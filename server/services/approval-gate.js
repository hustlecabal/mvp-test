// approval-gate.js
//
// This is the "nothing expensive happens without human approval" checkpoint.
// It knows nothing about HTTP or files on disk — it only works on a project
// object already in memory, and answers one question: canProceed(project)?
//
// Stage 8.1 note (see docs/architecture/budget-safety.md for the full
// explanation): the first real EvoLink smoke test showed that a
// "budgetLimit" set here is a HUMAN AUTHORIZATION THRESHOLD, not a
// technically-enforceable pre-submission provider cap — EvoLink does not
// expose a pre-submission quote, so the only real cost figure
// (reservedCost) is only known once a generation has already been
// submitted and credits already reserved on EvoLink's side. This file
// still enforces what it CAN enforce (approval, known budget vs. known
// cost, blocking further generations after an overage) but never pretends
// to guarantee something it structurally cannot.

// Named so this policy can be referenced/documented/tested by name rather
// than re-describing it every place it matters.
const UNKNOWN_COST_POLICY = 'UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL';

function defaultApprovals() {
  return {
    status: 'NONE', // NONE -> PENDING -> APPROVED or REJECTED
    estimatedCost: null,
    note: null,
    requestedAt: null,
    decidedAt: null,
    decidedBy: null,
    // Part 5: estimatedCost === null means "unknown", and unknown cost must
    // never be silently treated as free. A human has to explicitly say
    // "yes, I know the cost is unknown, proceed anyway" before canProceed()
    // will allow a generation whose estimatedCost is null.
    unknownCostAcknowledged: false,
    unknownCostAcknowledgedBy: null,
    unknownCostAcknowledgedAt: null,
  };
}

// See docs/architecture/budget-safety.md for the full field-by-field
// explanation. Short version:
//   limit       — budgetLimit: the human-authorized safety cap. NOT a
//                 provider-enforced pre-submission limit.
//   reserved    — running total of provider-reported reservedCost across
//                 every generation job reconciled for this project. This
//                 is the best number available at submission time.
//   actualSpent — running total of provider-reported actualCost, but ONLY
//                 for jobs where the provider actually returned one.
//                 EvoLink's documented API never does (see
//                 docs/integrations/evolink-api.md), so this stays `null`
//                 (meaning "unknown", never "zero") until some provider
//                 call actually reports a real final cost.
//   overage     — null until reserved (or actualSpent, once known) exceeds
//                 `limit`. Once set, it records which generation caused it
//                 and whether a human has acknowledged it yet.
//   blocked     — true while an unacknowledged overage exists. While true,
//                 canProceed() refuses every further generation for this
//                 project, regardless of approval/budget status.
//   reconciledJobs — internal bookkeeping: the last reservedCost/actualCost
//                 seen for each generation job id, so reconcileGenerationCost
//                 can be called repeatedly (e.g. once at submission, again
//                 at completion) without double-counting.
function defaultCreditLedger() {
  return {
    limit: null, // no limit set yet
    reserved: 0,
    actualSpent: null,
    overage: null,
    blocked: false,
    blockedReason: null,
    reconciledJobs: {},
  };
}

// Projects created before this stage existed have approvals: {} and
// creditLedger: {} (empty placeholders from the original project model),
// or an OLDER version of these objects (e.g. Stage 3's { limit, spent }
// ledger shape, before this stage's fields existed). Either way, this
// backfills any missing field with its default WITHOUT discarding fields
// that are already legitimately set (like an existing budget limit) —
// never a blind reset of an object that just looks unfamiliar.
//
// IMPORTANT: this fills in missing fields IN PLACE (mutates the existing
// approvals/creditLedger objects) rather than replacing them with a new
// object. Replacing the object would silently break any code that had
// already captured a reference to project.creditLedger before calling
// ensureShape() again (e.g. reconcileGenerationCost() below, which calls
// getRemainingBudget() — and therefore ensureShape() — partway through its
// own work on that same object).
function ensureShape(project) {
  if (!project.approvals || typeof project.approvals !== 'object' || !project.approvals.status) {
    project.approvals = defaultApprovals();
  } else {
    const defaults = defaultApprovals();
    for (const key of Object.keys(defaults)) {
      if (project.approvals[key] === undefined) {
        project.approvals[key] = defaults[key];
      }
    }
  }

  if (!project.creditLedger || typeof project.creditLedger !== 'object' || project.creditLedger.limit === undefined) {
    project.creditLedger = defaultCreditLedger();
  } else {
    const defaults = defaultCreditLedger();
    for (const key of Object.keys(defaults)) {
      if (project.creditLedger[key] === undefined) {
        project.creditLedger[key] = defaults[key];
      }
    }
    // Stage 3's ledger shape had a `spent` field that this stage replaced
    // with `reserved`/`actualSpent`. Drop it rather than carry a stale,
    // never-updated number forward under a name we no longer use for it.
    delete project.creditLedger.spent;
  }
  return project;
}

function setBudget(project, limit) {
  ensureShape(project);
  project.creditLedger.limit = limit;
  return project;
}

function requestApproval(project, { estimatedCost, note } = {}) {
  ensureShape(project);
  project.approvals = {
    ...defaultApprovals(),
    status: 'PENDING',
    estimatedCost: estimatedCost != null ? estimatedCost : null,
    note: note || null,
    requestedAt: new Date().toISOString(),
  };
  return project;
}

// Returns the updated project, or null if there was no pending request to
// decide on (e.g. nobody called requestApproval yet, or it was already
// decided).
function decideApproval(project, { approve, decidedBy, note } = {}) {
  ensureShape(project);
  if (project.approvals.status !== 'PENDING') {
    return null;
  }
  project.approvals.status = approve ? 'APPROVED' : 'REJECTED';
  project.approvals.decidedAt = new Date().toISOString();
  project.approvals.decidedBy = decidedBy || null;
  if (note) {
    project.approvals.note = note;
  }
  return project;
}

// Part 5 — UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL: a human explicitly
// acknowledging that estimatedCost is null (unknown) and that they want to
// proceed anyway. This is deliberately separate from decideApproval() —
// approving a request and acknowledging its cost is unknown are two
// different facts, and both must be true before canProceed() allows an
// unknown-cost generation.
function acknowledgeUnknownCost(project, { acknowledgedBy } = {}) {
  ensureShape(project);
  project.approvals.unknownCostAcknowledged = true;
  project.approvals.unknownCostAcknowledgedBy = acknowledgedBy || null;
  project.approvals.unknownCostAcknowledgedAt = new Date().toISOString();
  return project;
}

// Stage 10 — the single, complete budget picture for a project. Both the
// get_project_budget MCP tool (server/mcp/tools/approval-tools.js) and the
// GET /projects/:id/budget HTTP endpoint (server/index.js) call this exact
// function rather than each building their own version of it, so there is
// only ever one place that decides what "the budget view" means.
function getBudgetView(project) {
  ensureShape(project);
  const { allowed, reason } = canProceed(project);
  const { limit, reserved, actualSpent, overage, blocked } = project.creditLedger;

  return {
    budgetLimit: limit,
    estimatedAllocations: project.approvals.estimatedCost,
    reservedCredits: reserved,
    spentCredits: actualSpent, // null = provider has never reported an actual/final cost
    remainingBudget: getRemainingBudget(project),
    overageAmount: overage ? overage.amount : null,
    overage,
    generationAllowed: allowed,
    blocked,
    reason,
  };
}

// The remaining budget, or null if no limit has been set (meaning
// "unbounded" — there is nothing to compare against). Uses actualSpent
// when the provider has ever told us one (more precise); otherwise falls
// back to reserved, which is the conservative, always-available number —
// EvoLink has already committed those credits even before we know a final
// actual cost.
function getRemainingBudget(project) {
  ensureShape(project);
  const { limit, reserved, actualSpent } = project.creditLedger;
  if (limit == null) return null;
  const consumed = actualSpent != null ? actualSpent : reserved || 0;
  return round2(limit - consumed);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Part 3 — reconcileGenerationCost(project, job): folds a generation job's
// provider-reported cost into the project's credit ledger. Safe to call
// more than once for the same job (e.g. once right after submission, when
// only reservedCost is known, and again after it completes) — it tracks
// the last reservedCost/actualCost it saw for each job id and only applies
// the DELTA, so repeat calls never double-count.
//
// Never invents a number: if the provider hasn't reported reservedCost or
// actualCost, those fields on the job are `null`, and this function leaves
// the corresponding ledger totals unchanged rather than treating a missing
// value as zero.
function reconcileGenerationCost(project, job) {
  ensureShape(project);
  const ledger = project.creditLedger;
  const previous = ledger.reconciledJobs[job.id] || { reservedCost: 0, actualCost: null };

  const nextReservedCost = typeof job.reservedCost === 'number' ? job.reservedCost : previous.reservedCost;
  ledger.reserved = round2((ledger.reserved || 0) + (nextReservedCost - previous.reservedCost));

  let nextActualCost = previous.actualCost; // stays null until a provider ever reports one
  if (typeof job.actualCost === 'number') {
    const previousActualCost = previous.actualCost == null ? 0 : previous.actualCost;
    ledger.actualSpent = round2((ledger.actualSpent == null ? 0 : ledger.actualSpent) + (job.actualCost - previousActualCost));
    nextActualCost = job.actualCost;
  }

  ledger.reconciledJobs[job.id] = { reservedCost: nextReservedCost, actualCost: nextActualCost };

  // Part 6 — post-submission overage detection. Only ever set once per
  // project (the first generation that pushes it over) — later
  // reconciliations don't overwrite an existing unacknowledged overage
  // with a different generation's numbers.
  const remaining = getRemainingBudget(project);
  if (remaining != null && remaining < 0 && !ledger.overage) {
    ledger.overage = {
      generationId: job.id,
      amount: round2(Math.abs(remaining)),
      detectedAt: new Date().toISOString(),
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
    };
    ledger.blocked = true;
    ledger.blockedReason =
      `Generation ${job.id} pushed reserved/actual cost ${round2(Math.abs(remaining))} credits over the ` +
      `${ledger.limit}-credit budget limit. Further generation is blocked for this project until this overage ` +
      'is acknowledged.';
  }

  return project;
}

// A human acknowledging a detected overage — the only way to unblock
// further generation for a project after Part 6's overage policy has
// tripped. Originally left with no MCP/REST tool for Stage 8.1 to expose
// later; Stage 13E, Part 5 is that later stage — see
// mcp/tools/approval-tools.js's acknowledge_budget_overage and index.js's
// POST /projects/:id/budget/overage/acknowledge, both thin wrappers over
// this exact function.
//
// Returns null (a no-op, mutates nothing) if there is no overage at all,
// OR if the overage is already acknowledged — callers that need to tell
// those two cases apart (e.g. to report a distinct "already acknowledged"
// response rather than a bare error) should check
// project.creditLedger.overage / .overage.acknowledged themselves BEFORE
// calling this, exactly like decideApproval()'s "no pending request"
// convention.
//
// Never increases the budget limit, never touches approvals.status, and
// never modifies any generation job — it only records the acknowledgement
// and lifts the hard stop (blocked/blockedReason). If some OTHER blocking
// condition existed independently of this overage, clearing `blocked`
// here would not silently paper over it: canProceed() re-derives its
// verdict from approvals.status and the remaining-budget math on every
// call, so any other real gate keeps being enforced on the next check
// regardless of what this function did.
function acknowledgeOverage(project, { acknowledgedBy, note } = {}) {
  ensureShape(project);
  const { overage } = project.creditLedger;
  if (!overage || overage.acknowledged) return null;

  overage.acknowledged = true;
  overage.acknowledgedBy = acknowledgedBy || null;
  overage.acknowledgedAt = new Date().toISOString();
  overage.note = note || null;
  project.creditLedger.blocked = false;
  project.creditLedger.blockedReason = null;
  return project;
}

// The actual gate check. Returns { allowed, reason }.
function canProceed(project) {
  ensureShape(project);
  const { approvals, creditLedger } = project;

  if (approvals.status !== 'APPROVED') {
    return { allowed: false, reason: 'Project has not been approved for generation yet.' };
  }

  if (creditLedger.blocked) {
    return {
      allowed: false,
      reason: creditLedger.blockedReason || 'Project is blocked pending resolution of a budget overage.',
    };
  }

  // Part 5 policy: estimatedCost === null is "unknown", never "0" or
  // "free". Unknown cost blocks generation until a human explicitly
  // acknowledges it via acknowledgeUnknownCost().
  if (approvals.estimatedCost == null && !approvals.unknownCostAcknowledged) {
    return {
      allowed: false,
      reason:
        `Estimated cost is unknown and has not been explicitly acknowledged by a human (policy: ${UNKNOWN_COST_POLICY}). ` +
        'Call acknowledgeUnknownCost(project, { acknowledgedBy }) before generation can proceed.',
    };
  }

  const estimatedCost = approvals.estimatedCost || 0;
  const remaining = getRemainingBudget(project);
  if (remaining != null && estimatedCost > remaining) {
    return { allowed: false, reason: 'Approved cost would exceed the remaining project budget.' };
  }

  return { allowed: true, reason: null };
}

module.exports = {
  UNKNOWN_COST_POLICY,
  defaultApprovals,
  defaultCreditLedger,
  ensureShape,
  setBudget,
  requestApproval,
  decideApproval,
  acknowledgeUnknownCost,
  acknowledgeOverage,
  getRemainingBudget,
  getBudgetView,
  reconcileGenerationCost,
  canProceed,
};
