// Tests for Stage 8.1's budget/ledger fix — see
// docs/architecture/budget-safety.md for the full explanation of why this
// stage exists (the first real EvoLink smoke test reserved 100.45 credits
// against a 100-credit cap, and the old ledger incorrectly kept showing
// spent: 0).
//
// Everything here works on plain in-memory project objects (the same
// pattern approval-gate.test.js already uses) — no filesystem, no
// generation-service, no provider, no network. Nothing in this file makes
// or could make a real EvoLink call.

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../services/approval-gate');

function newProject() {
  return { id: 'test-project', approvals: {}, creditLedger: {} };
}

// A fake generation job — only the fields reconcileGenerationCost() reads.
function fakeJob(overrides = {}) {
  return {
    id: 'job-1',
    reservedCost: null,
    actualCost: null,
    ...overrides,
  };
}

// --- 1. Reserved cost is recorded ------------------------------------------

test('1. reconcileGenerationCost records reservedCost onto the ledger', () => {
  const project = newProject();
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 50 }));

  assert.equal(project.creditLedger.reserved, 50);
});

// --- 2. Spent is not falsely reported as zero when provider usage is known -

test('2. actualSpent reflects a provider-reported actualCost, not zero', () => {
  const project = newProject();
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 50, actualCost: 48 }));

  assert.equal(project.creditLedger.actualSpent, 48);
});

// --- 3. Unknown actual cost remains unknown --------------------------------

test('3. actualSpent stays null when the provider never reports an actualCost (EvoLink today)', () => {
  const project = newProject();
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 100.45, actualCost: null }));

  assert.equal(project.creditLedger.actualSpent, null, 'unknown must stay null, never become 0');
});

// --- 4. Remaining budget is calculated correctly ---------------------------

test('4. getRemainingBudget subtracts reserved credits from the limit', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 40 }));

  assert.equal(gate.getRemainingBudget(project), 60);
});

test('4b. getRemainingBudget prefers actualSpent over reserved once it is known', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 40, actualCost: 35 }));

  assert.equal(gate.getRemainingBudget(project), 65);
});

test('4c. getRemainingBudget returns null when no limit has been set', () => {
  const project = newProject();
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 40 }));

  assert.equal(gate.getRemainingBudget(project), null);
});

// --- 5 & 6. Over-budget reservation is detected, overage amount is correct -

test('5 & 6. an over-budget reservation is detected and the exact overage amount is recorded', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 100.45 }));

  assert.ok(project.creditLedger.overage, 'overage must be recorded');
  assert.equal(project.creditLedger.overage.amount, 0.45);
  assert.equal(project.creditLedger.overage.generationId, 'job-1');
  assert.equal(project.creditLedger.overage.acknowledged, false);
});

test('negative remaining budget is never silently treated as valid', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 250 }));

  assert.equal(gate.getRemainingBudget(project), -150);
  assert.ok(project.creditLedger.overage);
  assert.equal(project.creditLedger.overage.amount, 150);
});

// --- 7. Project becomes blocked according to the overage policy -----------

test('7. an overage blocks further generation, even for an otherwise-approved, in-budget request', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 5 }); // small, well within budget on its own
  gate.decideApproval(project, { approve: true });
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 150 })); // a DIFFERENT generation caused the overage

  const result = gate.canProceed(project);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /blocked|overage/i);
});

test('7b. acknowledgeOverage clears the block flag, but does not retroactively fix a still-negative remaining budget', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 5 });
  gate.decideApproval(project, { approve: true });
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 150 }));

  assert.equal(gate.canProceed(project).allowed, false);

  gate.acknowledgeOverage(project, { acknowledgedBy: 'a human' });

  assert.equal(project.creditLedger.blocked, false);
  assert.equal(project.creditLedger.overage.acknowledged, true);
  assert.equal(project.creditLedger.overage.acknowledgedBy, 'a human');

  // Acknowledging just lifts the hard stop so a human can decide what to do
  // next — it does not invent credits. Remaining budget is still negative
  // (100 limit - 150 reserved), so the ordinary budget check still refuses.
  const stillBlocked = gate.canProceed(project);
  assert.equal(stillBlocked.allowed, false);
  assert.match(stillBlocked.reason, /remaining project budget/);

  // Only once a human raises the limit to cover what was actually reserved
  // does the project become able to proceed again.
  gate.setBudget(project, 300);
  assert.equal(gate.canProceed(project).allowed, true);
});

// --- 8. Unknown pre-submission cost requires explicit human acknowledgement

test('8. an approved project with unknown (null) estimatedCost cannot proceed without explicit acknowledgement', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: null, note: 'cost genuinely unknown before submission' });
  gate.decideApproval(project, { approve: true });

  const result = gate.canProceed(project);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL/);
});

test('8b. acknowledging unknown cost allows an approved, in-budget project to proceed', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: null });
  gate.decideApproval(project, { approve: true });
  gate.acknowledgeUnknownCost(project, { acknowledgedBy: 'a human' });

  const result = gate.canProceed(project);
  assert.equal(result.allowed, true);
  assert.equal(project.approvals.unknownCostAcknowledgedBy, 'a human');
  assert.ok(project.approvals.unknownCostAcknowledgedAt);
});

// --- 9. estimatedCost null never becomes 0 ---------------------------------

test('9. requestApproval never coerces a null/omitted estimatedCost into 0', () => {
  const project = newProject();
  gate.requestApproval(project, {});

  assert.equal(project.approvals.estimatedCost, null, 'omitted estimatedCost must stay null, not become 0');
});

test('9b. UNKNOWN_COST_POLICY is exported and named for exactly this purpose', () => {
  assert.equal(gate.UNKNOWN_COST_POLICY, 'UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL');
});

// --- reconcileGenerationCost is safe to call more than once for one job ---

test('reconcileGenerationCost never double-counts when called twice for the same job', () => {
  const project = newProject();
  gate.setBudget(project, 1000);

  // First call: only reservedCost is known yet (right after submission).
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 50, actualCost: null }));
  assert.equal(project.creditLedger.reserved, 50);

  // Second call for the SAME job: reservedCost unchanged, actualCost now known.
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 50, actualCost: 45 }));
  assert.equal(project.creditLedger.reserved, 50, 'reserved must not double-count on a repeat call');
  assert.equal(project.creditLedger.actualSpent, 45);
});

test('reconcileGenerationCost tracks multiple different jobs on the same project additively', () => {
  const project = newProject();
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-1', reservedCost: 50 }));
  gate.reconcileGenerationCost(project, fakeJob({ id: 'job-2', reservedCost: 30 }));

  assert.equal(project.creditLedger.reserved, 80);
});

// --- migration safety: an old-shape ledger from before this stage --------

test('ensureShape backfills a Stage 3-shaped ledger ({ limit, spent }) without losing the existing limit', () => {
  const project = { id: 'legacy', approvals: {}, creditLedger: { limit: 100, spent: 0 } };
  gate.ensureShape(project);

  assert.equal(project.creditLedger.limit, 100, 'an already-set budget limit must never be discarded');
  assert.equal(project.creditLedger.reserved, 0);
  assert.equal(project.creditLedger.actualSpent, null);
  assert.equal('spent' in project.creditLedger, false, 'the old, never-accurate spent field should not survive migration');
});
