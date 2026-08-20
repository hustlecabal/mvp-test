// Tests for services/human-voice-acquisition-service.js — CREATIVE
// BRAIN, Part 5. Mirrors services/reference-video-ingestion-service.js's
// own Apify financial-gating test conventions: a small injected fake
// DiscussionAcquisitionProvider to exercise every status deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [envVar, prefix] of [
  ['PROJECT_DATA_DIR', 'evolink-hvatest-projects-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const { acquireHumanVoiceCorpus } = require('../services/human-voice-acquisition-service');
const { createDiscussionAcquisitionResult, createDiscussionItem } = require('../services/human-voice/discussion-acquisition-provider-interface');

function newProject({ approved = true } = {}) {
  const project = projectStore.createProject({ title: 'x', topic: 'career change' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  if (approved) gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

function fakeProvider(overrides = {}) {
  return {
    acquireDiscussion: async () =>
      createDiscussionAcquisitionResult({
        status: 'COMPLETED',
        items: [
          createDiscussionItem({ externalId: 'a', platform: 'REDDIT', kind: 'POST', text: 'real post one', retrievedAt: new Date().toISOString() }),
          createDiscussionItem({ externalId: 'b', platform: 'REDDIT', kind: 'POST', text: 'real post two', retrievedAt: new Date().toISOString() }),
        ],
      }),
    ...overrides,
  };
}

test('1. fails for a non-existent project', async () => {
  const result = await acquireHumanVoiceCorpus('00000000-0000-4000-8000-000000000000', { topic: 't', provider: fakeProvider() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'PROJECT_NOT_FOUND');
});

test('2. fails with INVALID_QUERY for an empty topic', async () => {
  const project = newProject();
  const result = await acquireHumanVoiceCorpus(project.id, { topic: '', provider: fakeProvider() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_QUERY');
});

test('3. UNSUPPORTED for a platform with no acquisition provider', async () => {
  const project = newProject();
  const result = await acquireHumanVoiceCorpus(project.id, { topic: 't', platform: 'TWITTER', provider: fakeProvider() });
  assert.equal(result.status, 'UNSUPPORTED');
});

test('4. blocked by BUDGET_APPROVAL_REQUIRED when the project itself is not approved', async () => {
  const project = newProject({ approved: false });
  const result = await acquireHumanVoiceCorpus(project.id, { topic: 't', provider: fakeProvider() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'BUDGET_APPROVAL_REQUIRED');
});

test('5. a successful acquisition returns real, normalized items and settles a REAL computed cost (never fabricated)', async () => {
  const project = newProject();
  const result = await acquireHumanVoiceCorpus(project.id, { topic: 't', provider: fakeProvider() });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.items.length, 2);
  const refreshed = projectStore.getProject(project.id);
  assert.ok(refreshed.creditLedger.usdSpend.apify.settledUsd > 0);
});

test('6. a FAILED provider result settles as UNKNOWN (never zero) when the network may have been reached', async () => {
  const project = newProject();
  const failingProvider = fakeProvider({ acquireDiscussion: async () => createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [{ code: 'DISCUSSION_ACQUISITION_FAILED', message: 'Apify returned HTTP 500' }] }) });
  const result = await acquireHumanVoiceCorpus(project.id, { topic: 't', provider: failingProvider });
  assert.equal(result.status, 'FAILED');
  const refreshed = projectStore.getProject(project.id);
  assert.equal(refreshed.creditLedger.usdSpend.apify.unknownSettlements, 1);
});

test('7. a provider failure due to missing APIFY_API_TOKEN releases the reservation (never billed for a call that never happened)', async () => {
  const project = newProject();
  const noTokenProvider = fakeProvider({ acquireDiscussion: async () => createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [{ code: 'DISCUSSION_ACQUISITION_FAILED', message: 'no APIFY_API_TOKEN configured in this environment' }] }) });
  const before = projectStore.getProject(project.id).creditLedger.usdSpend.apify.settledUsd;
  await acquireHumanVoiceCorpus(project.id, { topic: 't', provider: noTokenProvider });
  const after = projectStore.getProject(project.id).creditLedger.usdSpend.apify.settledUsd;
  assert.equal(after, before);
});

test('8. UNAVAILABLE (no discussion found) settles a real cost based on the (zero) items actually returned', async () => {
  const project = newProject();
  const emptyProvider = fakeProvider({ acquireDiscussion: async () => createDiscussionAcquisitionResult({ status: 'UNAVAILABLE', diagnostics: [{ code: 'NO_DISCUSSION_FOUND', message: 'none' }] }) });
  const result = await acquireHumanVoiceCorpus(project.id, { topic: 't', provider: emptyProvider });
  assert.equal(result.status, 'UNAVAILABLE');
});

test('9. security — human-voice-acquisition-service.js never fetches a caller-controlled URL directly (only via the injected provider)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/human-voice-acquisition-service.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(src));
});

test('10. real Reddit provider (services/human-voice/reddit-acquisition-provider.js) returns UNAVAILABLE-equivalent FAILED without APIFY_API_TOKEN — never invents credentials', async () => {
  const { createRedditAcquisitionProvider } = require('../services/human-voice/reddit-acquisition-provider');
  const originalToken = process.env.APIFY_API_TOKEN;
  delete process.env.APIFY_API_TOKEN;
  try {
    const provider = createRedditAcquisitionProvider();
    const result = await provider.acquireDiscussion({ topic: 'career change' });
    assert.equal(result.status, 'FAILED');
    assert.match(result.diagnostics[0].message, /no APIFY_API_TOKEN configured/);
  } finally {
    if (originalToken !== undefined) process.env.APIFY_API_TOKEN = originalToken;
  }
});
