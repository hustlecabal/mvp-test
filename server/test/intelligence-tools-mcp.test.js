// Tests for the P0-INTEL MCP tools (start_intelligence,
// get_intelligence_status, list_intelligence_runs) — server/mcp/tools/
// intelligence-tools.js — using a REAL spawned MCP server process over
// stdio, the same pattern test/production-tools-mcp.test.js already
// establishes. Proves Part 20's explicit requirement: the MCP surface
// calls the SAME orchestrator (intelligence-orchestrator-service.js) as
// every other entry point, through a real process boundary, not an
// in-process stub.
//
// startIntelligenceRunAsync() cannot accept a fake acquisitionProvider
// (documented in that function's own header — it never crosses the
// fork() boundary), and the spawned MCP server process has no
// ANTHROPIC_API_KEY/APIFY_API_TOKEN in this environment either. So this
// file proves the MCP wiring itself (start/poll/list, async-return,
// idempotency, unknown-run/unknown-project errors) against a
// pre-ingested ReferenceSet — the videos are ingested directly via the
// real, unmodified reference-video-ingestion-service.js (fake acquisition
// provider, same convention as every other INT-1 test file) BEFORE the
// MCP server is asked to run measurement -> observation -> pattern ->
// recommendation for real over the shared, env-configured data
// directories. This is the same "provider overrides are sync-path-only"
// split intelligence-orchestrator-service.test.js's own async test (#26)
// already established.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const envVars = {};
for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-itools-mcp-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-itools-mcp-projects-'],
  ['REFERENCE_VIDEO_DATA_DIR', 'evolink-itools-mcp-rvstore-'],
  ['REFERENCE_VIDEO_MEASUREMENT_DATA_DIR', 'evolink-itools-mcp-mstore-'],
  ['REFERENCE_VIDEO_OBSERVATION_DATA_DIR', 'evolink-itools-mcp-ostore-'],
  ['REFERENCE_SET_DATA_DIR', 'evolink-itools-mcp-rsstore-'],
  ['CROSS_VIDEO_PATTERN_DATA_DIR', 'evolink-itools-mcp-pstore-'],
  ['RECOMMENDATION_DATA_DIR', 'evolink-itools-mcp-recstore-'],
  ['INTELLIGENCE_RUNS_DATA_DIR', 'evolink-itools-mcp-irstore-'],
]) {
  envVars[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env[envVar] = envVars[envVar];
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const referenceSetSvc = require('../services/reference-set-service');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { ...process.env, ...envVars },
  });
  client = new Client({ name: 'evolink-itools-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  for (const dir of Object.values(envVars)) fs.rmSync(dir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function newProject(title) {
  const project = projectStore.createProject({ title, topic: 'y' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

let fixtureVideoPath;
function buildFixtureVideo() {
  if (fixtureVideoPath) return fixtureVideoPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-itools-mcp-src-'));
  const p = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=160x90:duration=2:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  fixtureVideoPath = p;
  return p;
}

function fakeProvider() {
  return {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 't', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'COMPLETED', transcript: { text: 'is this working', language: 'en', words: [{ word: 'Is', startTime: 0, endTime: 0.2 }], segments: [] }, diagnostics: [] }),
  };
}

function fetchImplServing(filePath) {
  return async () => {
    const buf = fs.readFileSync(filePath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
}

async function buildPreIngestedSet(project, n = 3) {
  const set = referenceSetSvc.createSet(project.id, { name: 'mcp-golden-set' }).referenceSet;
  const videoPath = buildFixtureVideo();
  for (let i = 0; i < n; i += 1) {
    const rv = await ingestReferenceVideo(project.id, { url: `https://www.youtube.com/watch?v=fxmcp${i}`, provider: fakeProvider(), fetchImpl: fetchImplServing(videoPath) });
    referenceSetSvc.addVideo(project.id, set.id, rv.id);
  }
  return set;
}

const TERMINAL_STATUSES = ['COMPLETE', 'FAILED'];

async function pollUntilTerminal(intelligenceRunId, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = textOf(await call('get_intelligence_status', { intelligenceRunId }));
    if (TERMINAL_STATUSES.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`intelligence run "${intelligenceRunId}" did not reach a terminal status within ${timeoutMs}ms (last status: ${run.status})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('1. start_intelligence for an unknown project returns an MCP tool error, never a silent pass', async () => {
  const result = await call('start_intelligence', { projectId: 'nonexistent-project-id', referenceVideoUrls: ['https://x'] });
  assert.equal(result.isError, true);
});

test('2. start_intelligence with no referenceVideoUrls/referenceSetId is a structured failure, not an MCP throw', async () => {
  const project = newProject('MCP no-input test');
  const result = textOf(await call('start_intelligence', { projectId: project.id }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_REFERENCE_INPUT');
});

test('3. start_intelligence is ASYNCHRONOUS and, through the SAME orchestrator, drives a real pre-ingested ReferenceSet to a real, persisted COMPLETE IntelligenceRun with a real RecommendationSet', async () => {
  const project = newProject('MCP Golden Intelligence Test');
  const set = await buildPreIngestedSet(project, 3);

  const requestedAt = Date.now();
  const started = textOf(await call('start_intelligence', { projectId: project.id, referenceSetId: set.id }));
  const returnedAfterMs = Date.now() - requestedAt;
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(!TERMINAL_STATUSES.includes(started.run.status), 'start_intelligence must return before the real pipeline finishes');
  assert.ok(returnedAfterMs < 5000, `start_intelligence must return quickly (took ${returnedAfterMs}ms)`);

  const finished = await pollUntilTerminal(started.run.intelligenceRunId);
  assert.equal(finished.status, 'COMPLETE', JSON.stringify(finished.diagnostics));
  assert.ok(finished.recommendationSetId);
  assert.ok(finished.patternSetId);

  const list = textOf(await call('list_intelligence_runs', { projectId: project.id }));
  assert.equal(list.length, 1);
  assert.equal(list[0].intelligenceRunId, started.run.intelligenceRunId);
});

test('4. start_intelligence is idempotent: a second call while non-terminal resumes the SAME run through the MCP surface', async () => {
  const project = newProject('MCP idempotency test');
  const set = await buildPreIngestedSet(project, 3);

  const first = textOf(await call('start_intelligence', { projectId: project.id, referenceSetId: set.id }));
  assert.equal(first.ok, true);
  const second = textOf(await call('start_intelligence', { projectId: project.id, referenceSetId: set.id }));
  assert.equal(second.ok, true);
  assert.equal(second.run.intelligenceRunId, first.run.intelligenceRunId);

  await pollUntilTerminal(first.run.intelligenceRunId);
  const list = textOf(await call('list_intelligence_runs', { projectId: project.id }));
  assert.equal(list.length, 1, 'only one IntelligenceRun should exist for this project after both calls');
});

test('5. get_intelligence_status for an unknown run id returns an MCP tool error, never a silent pass', async () => {
  const result = await call('get_intelligence_status', { intelligenceRunId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(result.isError, true);
});

test('6. list_intelligence_runs for an unknown project returns an MCP tool error, never a silent pass', async () => {
  const result = await call('list_intelligence_runs', { projectId: 'nonexistent-project-id' });
  assert.equal(result.isError, true);
});
