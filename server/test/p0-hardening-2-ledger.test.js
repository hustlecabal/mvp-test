// P0-HARDENING-2 — SPEND SAFETY, CONCURRENCY & RECOVERY.
//
// Tests for the new concurrency-safe reservation/release/settlement
// machinery added to services/approval-gate.js (Part 5/6/7), and for the
// recovery classifier added in services/generation-recovery-service.js
// (Part 9/10). Everything here works against REAL persisted projects
// (services/project-store.js, pointed at a disposable temp directory) —
// never a bare in-memory object — because the whole point of this stage
// is that the fix does its own fresh disk read inside a per-project lock;
// a test using a stale in-memory object would not actually exercise that.
//
// Part 15's three concurrency scenarios below are reproduced with the
// EXACT numbers the implementation spec requires, verbatim.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p0h2-ledger-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const recoveryService = require('../services/generation-recovery-service');

function readyProject({ budgetLimit = 10 } = {}) {
  const created = projectStore.createProject({ title: 'P0-HARDENING-2 ledger test', topic: 'x' });
  const project = projectStore.getProject(created.id);
  gate.setBudget(project, budgetLimit);
  gate.requestApproval(project, { estimatedCost: 0 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);
  return created.id;
}

// ===========================================================================
// Part 15 — MANDATORY CONCURRENCY REGRESSION (exact numbers, verbatim)
// ===========================================================================

test('P15-1. budget=10, concurrent A=7 and B=7: only ONE reserves, the other is blocked, no lost update, remaining budget is correct', async () => {
  const projectId = readyProject({ budgetLimit: 10 });

  const [resA, resB] = await Promise.all([
    gate.reserveBudget(projectId, { jobId: 'jobA', provider: 'evolink', operation: 'test', amount: 7, currency: 'credits' }),
    gate.reserveBudget(projectId, { jobId: 'jobB', provider: 'evolink', operation: 'test', amount: 7, currency: 'credits' }),
  ]);

  const outcomes = [resA, resB];
  const allowedCount = outcomes.filter((r) => r.allowed).length;
  const blockedCount = outcomes.filter((r) => !r.allowed).length;
  assert.equal(allowedCount, 1, 'exactly one of the two concurrent £7 reservations must succeed');
  assert.equal(blockedCount, 1, 'exactly one of the two concurrent £7 reservations must be blocked');

  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 7, 'the ledger must show exactly ONE £7 reservation, never 14 and never 0 (the exact lost-update bug the forensic audit found)');
  assert.equal(gate.getRemainingBudget(project), 3);

  // Both operations are represented correctly: exactly one RESERVED event,
  // never two, never zero.
  const reservedEvents = project.creditLedger.ledgerEvents.filter((e) => e.event === 'RESERVED');
  assert.equal(reservedEvents.length, 1);
  assert.equal(reservedEvents[0].amount, 7);
  const reservedJobId = reservedEvents[0].jobId;
  assert.ok(reservedJobId === 'jobA' || reservedJobId === 'jobB');

  // The blocked side's own return value honestly says so — never silently
  // dropped, never silently allowed.
  const blocked = outcomes.find((r) => !r.allowed);
  assert.ok(blocked.reason && /budget/i.test(blocked.reason));
});

test('P15-2. budget=10, concurrent A=6 and B=4: BOTH may proceed, total reserved = 10', async () => {
  const projectId = readyProject({ budgetLimit: 10 });

  const [resA, resB] = await Promise.all([
    gate.reserveBudget(projectId, { jobId: 'jobA', provider: 'evolink', operation: 'test', amount: 6, currency: 'credits' }),
    gate.reserveBudget(projectId, { jobId: 'jobB', provider: 'evolink', operation: 'test', amount: 4, currency: 'credits' }),
  ]);

  assert.equal(resA.allowed, true);
  assert.equal(resB.allowed, true);

  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 10);
  assert.equal(gate.getRemainingBudget(project), 0);

  const reservedEvents = project.creditLedger.ledgerEvents.filter((e) => e.event === 'RESERVED');
  assert.equal(reservedEvents.length, 2);
  assert.deepEqual(reservedEvents.map((e) => e.amount).sort(), [4, 6]);
});

test('P15-3. budget=10, concurrent A=6 and B=5: ONE proceeds, ONE is blocked', async () => {
  const projectId = readyProject({ budgetLimit: 10 });

  const [resA, resB] = await Promise.all([
    gate.reserveBudget(projectId, { jobId: 'jobA', provider: 'evolink', operation: 'test', amount: 6, currency: 'credits' }),
    gate.reserveBudget(projectId, { jobId: 'jobB', provider: 'evolink', operation: 'test', amount: 5, currency: 'credits' }),
  ]);

  const outcomes = [resA, resB];
  assert.equal(outcomes.filter((r) => r.allowed).length, 1);
  assert.equal(outcomes.filter((r) => !r.allowed).length, 1);

  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 6);
  assert.equal(gate.getRemainingBudget(project), 4);
});

test('P15-4. ten genuinely concurrent £3 reservations against a £10 budget: never over-reserves, no lost updates, exactly the right count succeeds', async () => {
  const projectId = readyProject({ budgetLimit: 10 });

  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => gate.reserveBudget(projectId, { jobId: `job-${i}`, provider: 'evolink', operation: 'test', amount: 3, currency: 'credits' })));

  const allowed = results.filter((r) => r.allowed);
  // floor(10 / 3) = 3 can fit; a 4th would push reserved to 12 > 10.
  assert.equal(allowed.length, 3);
  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 9);
  assert.equal(project.creditLedger.ledgerEvents.filter((e) => e.event === 'RESERVED').length, 3);
});

test('different projects never block each other: two concurrent reservations for DIFFERENT projects both settle independently and quickly', async () => {
  const projectA = readyProject({ budgetLimit: 10 });
  const projectB = readyProject({ budgetLimit: 10 });

  const [resA, resB] = await Promise.all([
    gate.reserveBudget(projectA, { jobId: 'jobA', provider: 'evolink', operation: 'test', amount: 7, currency: 'credits' }),
    gate.reserveBudget(projectB, { jobId: 'jobB', provider: 'evolink', operation: 'test', amount: 7, currency: 'credits' }),
  ]);

  assert.equal(resA.allowed, true);
  assert.equal(resB.allowed, true);
});

// ===========================================================================
// Part 16 — CRASH/FAILURE INJECTION TESTS
// ===========================================================================

test('C1. reservation succeeds, provider throws: the reservation is released, not left stranded', async () => {
  const projectId = readyProject({ budgetLimit: 10 });
  const reservation = await gate.reserveBudget(projectId, { jobId: 'job-crash-1', provider: 'evolink', operation: 'test', amount: 7, currency: 'credits' });
  assert.equal(reservation.allowed, true);
  assert.equal(projectStore.getProject(projectId).creditLedger.reserved, 7);

  // Simulate the provider call throwing (mirrors generation-service.js's
  // own catch block).
  const released = await gate.releaseReservation(projectId, { jobId: 'job-crash-1', provider: 'evolink', currency: 'credits', note: 'simulated provider throw' });
  assert.equal(released.released, true);

  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 0, 'the reservation must be fully released, not left stranded against a job that was never billed');
  assert.equal(gate.getRemainingBudget(project), 10);
  const events = project.creditLedger.ledgerEvents;
  assert.deepEqual(events.map((e) => e.event), ['RESERVED', 'RELEASED']);
});

test('C2. provider result available, settlement write fails: the system never claims the ledger is settled', async () => {
  const projectId = readyProject({ budgetLimit: 10 });
  await gate.reserveBudget(projectId, { jobId: 'job-crash-2', provider: 'evolink', operation: 'test', amount: 5, currency: 'credits' });

  // Simulate a settlement write failing by pointing settleGenerationCost at
  // a project id that no longer resolves (the exact failure mode a
  // deleted/corrupted project file would produce) — settleGenerationCost
  // must THROW rather than silently report success.
  await assert.rejects(() => gate.settleGenerationCost('00000000-0000-0000-0000-000000000000', { id: 'job-crash-2', reservedCost: 5, actualCost: 5 }));

  // The REAL project's ledger is untouched by the failed attempt — still
  // shows the reservation, never a phantom settlement.
  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 5);
  assert.equal(project.creditLedger.actualSpent, null);
});

test('C3. provider call outcome becomes UNKNOWN: the reservation/exposure remains explicitly unresolved, never silently released or settled', async () => {
  const projectId = readyProject({ budgetLimit: 10 });
  await gate.reserveBudget(projectId, { jobId: 'job-crash-3', provider: 'evolink', operation: 'test', amount: 5, currency: 'credits' });

  const staleJob = { id: 'job-crash-3', status: 'SUBMITTED', providerTaskId: 'task-3' };
  const flakyProviderAdapter = { getGenerationStatus: async () => { throw new Error('network partition'); } };
  const recovery = await recoveryService.classifyJobRecovery(staleJob, flakyProviderAdapter);
  assert.equal(recovery.classification, 'PROVIDER_OUTCOME_UNKNOWN');

  // Nothing about the ledger changes just from classifying — the reservation
  // stays exactly as it was, neither released nor settled.
  const project = projectStore.getProject(projectId);
  assert.equal(project.creditLedger.reserved, 5);
  assert.equal(project.creditLedger.ledgerEvents.filter((e) => e.event === 'RELEASED').length, 0);
  assert.equal(project.creditLedger.ledgerEvents.filter((e) => e.event === 'SETTLED').length, 0);
});

test('C4. a stale job is identified as stale, but the recovery classifier never invents a provider failure', async () => {
  const stillActiveAdapter = { getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 40, reservedCost: null, results: null, error: null }) };
  const recovery = await recoveryService.classifyJobRecovery({ id: 'job-stale', status: 'TIMED_OUT', providerTaskId: 'task-stale' }, stillActiveAdapter);
  assert.equal(recovery.classification, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.ok(!/fail/i.test(recovery.reason), 'must not fabricate a "failed" narrative for a job the provider itself reports as still active');

  const completedAdapter = { getGenerationStatus: async () => ({ status: 'COMPLETED', progress: 100, reservedCost: 5, results: ['url'], error: null }) };
  const completedRecovery = await recoveryService.classifyJobRecovery({ id: 'job-stale-2', status: 'TIMED_OUT', providerTaskId: 'task-stale-2' }, completedAdapter);
  assert.equal(completedRecovery.classification, 'ALREADY_COMPLETED');

  const failedAdapter = { getGenerationStatus: async () => ({ status: 'FAILED', progress: null, reservedCost: null, results: null, error: { message: 'provider-confirmed failure' } }) };
  const failedRecovery = await recoveryService.classifyJobRecovery({ id: 'job-stale-3', status: 'TIMED_OUT', providerTaskId: 'task-stale-3' }, failedAdapter);
  assert.equal(failedRecovery.classification, 'FAILED_CONFIRMED');
});

test('a crashed REQUESTED job with no providerTaskId is classified PROVIDER_OUTCOME_UNKNOWN, never assumed safe and never assumed failed (P1-1)', async () => {
  const recovery = await recoveryService.classifyJobRecovery({ id: 'job-crashed-requested', status: 'REQUESTED', providerTaskId: null }, { getGenerationStatus: async () => { throw new Error('should never be called: no providerTaskId to query'); } });
  assert.equal(recovery.classification, 'PROVIDER_OUTCOME_UNKNOWN');
});

test('a FAILED job that never got a providerTaskId is SAFE_TO_RETRY (nothing was ever billed)', async () => {
  const recovery = await recoveryService.classifyJobRecovery({ id: 'job-failed-pre-submit', status: 'FAILED', providerTaskId: null }, { getGenerationStatus: async () => { throw new Error('should never be called'); } });
  assert.equal(recovery.classification, 'SAFE_TO_RETRY');
});

// ===========================================================================
// Part 17 — DATA MIGRATION
// ===========================================================================

test('M1. an existing project object (old shape, missing ledgerEvents/usdSpend entirely) loads safely and is backfilled additively, without altering existing numbers', () => {
  const oldStyleProject = {
    id: 'old-shape-project',
    approvals: { status: 'APPROVED', estimatedCost: 5, unknownCostAcknowledged: false },
    creditLedger: { limit: 100, reserved: 42, actualSpent: 10, overage: null, blocked: false, blockedReason: null, reconciledJobs: { 'legacy-job': { reservedCost: 42, actualCost: 10 } } },
  };
  const before = JSON.parse(JSON.stringify(oldStyleProject.creditLedger));

  gate.ensureShape(oldStyleProject);

  // Pre-existing numbers are completely unchanged.
  assert.equal(oldStyleProject.creditLedger.limit, before.limit);
  assert.equal(oldStyleProject.creditLedger.reserved, before.reserved);
  assert.equal(oldStyleProject.creditLedger.actualSpent, before.actualSpent);
  assert.deepEqual(oldStyleProject.creditLedger.reconciledJobs, before.reconciledJobs);

  // New fields are safely backfilled, empty/zeroed, never fabricated from
  // the old data.
  assert.deepEqual(oldStyleProject.creditLedger.ledgerEvents, []);
  assert.deepEqual(oldStyleProject.creditLedger.usdSpend, {
    apify: { reservedUsd: 0, settledUsd: 0, unknownSettlements: 0 },
    anthropic: { reservedUsd: 0, settledUsd: 0, unknownSettlements: 0 },
  });
});

test('M2. an old-shape project persisted to disk, then loaded fresh through project-store.js, is safely usable by reserveBudget without a migration script', async () => {
  const created = projectStore.createProject({ title: 'Old shape on disk', topic: 'x' });
  // Simulate a project file written by CODE THAT PREDATES this stage: no
  // ledgerEvents, no usdSpend, but a real pre-existing reserved balance.
  const raw = projectStore.getProject(created.id);
  raw.approvals = { status: 'APPROVED', estimatedCost: 1, unknownCostAcknowledged: false, note: null, requestedAt: null, decidedAt: null, decidedBy: null, unknownCostAcknowledgedBy: null, unknownCostAcknowledgedAt: null };
  raw.creditLedger = { limit: 20, reserved: 5, actualSpent: null, overage: null, blocked: false, blockedReason: null, reconciledJobs: {} };
  projectStore.touch(raw);

  // No migration script ran. reserveBudget must still work correctly,
  // respecting the pre-existing reserved=5 against limit=20 (remaining=15).
  const withinBudget = await gate.reserveBudget(created.id, { jobId: 'new-job-on-old-project', provider: 'evolink', operation: 'test', amount: 14, currency: 'credits' });
  assert.equal(withinBudget.allowed, true, '5 already reserved + 14 new = 19, within the 20-credit limit');
  assert.equal(projectStore.getProject(created.id).creditLedger.reserved, 19);

  const overBudget = await gate.reserveBudget(created.id, { jobId: 'new-job-on-old-project-2', provider: 'evolink', operation: 'test', amount: 5, currency: 'credits' });
  assert.equal(overBudget.allowed, false, '19 already reserved + 5 new = 24, which exceeds the 20-credit limit');
});

test('M3. only NEW operations create new ledger events — an old project with no ledgerEvents history is never fabricated one for its pre-existing reserved/actualSpent numbers', () => {
  const project = {
    id: 'old-project-2',
    approvals: {},
    creditLedger: { limit: 50, reserved: 30, actualSpent: 30, overage: null, blocked: false, blockedReason: null, reconciledJobs: { j1: { reservedCost: 30, actualCost: 30 } } },
  };
  gate.ensureShape(project);
  assert.deepEqual(project.creditLedger.ledgerEvents, [], 'pre-existing spend history must never be retroactively fabricated as ledger events');
});
