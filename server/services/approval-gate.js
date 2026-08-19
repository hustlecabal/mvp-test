// approval-gate.js
//
// This is the "nothing expensive happens without human approval" checkpoint.
// Most of this file (everything from ensureShape() down to canProceed())
// still knows nothing about HTTP or files on disk — it only works on a
// project object already in memory, and answers one question:
// canProceed(project)?
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
//
// P0-HARDING-2 note (see docs/architecture/budget-safety.md's concurrency
// addendum and this stage's final report): the forensic audit proved that
// every caller of reconcileGenerationCost() followed a
// "read project -> await provider call -> mutate -> writeFileSync" pattern,
// which lets two concurrent requests for the SAME project interleave and
// lose one write. reserveBudget()/releaseReservation()/settleGenerationCost/
// settleUsdSpend() below are the fix: they do their OWN fresh read of the
// project from disk (via project-store.js — the one deliberate, necessary
// new dependency this file takes on) INSIDE a per-project async lock, so
// the read-modify-write is atomic for that project. This lock is
// PROCESS-LOCAL ONLY — it says nothing about multi-process deployment,
// because nothing in this repository's current architecture runs more
// than one process against the same project data.

// Named so this policy can be referenced/documented/tested by name rather
// than re-describing it every place it matters.
const UNKNOWN_COST_POLICY = 'UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL';

const crypto = require('crypto');
const projectStore = require('./project-store');

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
//   ledgerEvents  — P0-HARDENING-2, Part 4: an append-only audit trail of
//                 every financial mutation this file makes, regardless of
//                 currency. Each entry is
//                 { eventId, jobId, provider, operation, amount, currency,
//                   event, at, note }, where event is one of RESERVED /
//                 RELEASED / SETTLED. This is additive — nothing here
//                 changes what `reserved`/`actualSpent` mean; it exists so
//                 a human can reconstruct exactly what was authorized,
//                 reserved, released, and settled, in order.
//   usdSpend      — P0-HARDENING-2, Part 7: EvoLink's `reserved`/
//                 `actualSpent` above are credits. Apify and Anthropic are
//                 billed in USD, a different currency that must NEVER be
//                 numerically combined with credits. Each provider gets
//                 its own explicitly-labelled sub-ledger:
//                 { reservedUsd, settledUsd, unknownSettlements }.
//                 unknownSettlements counts operations that genuinely
//                 happened but whose actual USD cost the provider's
//                 existing API response does not expose — it is never
//                 estimated or invented (see Part 11/12).
function defaultCreditLedger() {
  return {
    limit: null, // no limit set yet
    reserved: 0,
    actualSpent: null,
    overage: null,
    blocked: false,
    blockedReason: null,
    reconciledJobs: {},
    ledgerEvents: [],
    usdSpend: {
      apify: { reservedUsd: 0, settledUsd: 0, unknownSettlements: 0 },
      anthropic: { reservedUsd: 0, settledUsd: 0, unknownSettlements: 0 },
    },
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

// P0-HARDENING-2 — USD provider prices in this codebase are genuinely
// sub-cent (e.g. Apify's $0.005/result — see reference-video-ingestion-
// service.js). round2 is correct for EvoLink credits (always whole-cent in
// practice) but would silently distort a real $0.005 price to $0.01 — a
// 100% error, exactly the kind of "fabricated actual cost" Rule 4
// forbids. usdSpend accumulation uses this micro-dollar rounding instead
// (matching reference-video-interpretation-model-registry.js's own
// estimateCostUsd precision), never round2.
function roundUsd(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
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

// ---------------------------------------------------------------------------
// P0-HARDENING-2 — concurrency-safe reservation/release/settlement.
//
// Everything above this line is the ORIGINAL, unmodified gate logic: it
// only reads/writes an in-memory project object a caller already has, and
// callers remain free to keep using it exactly as before (in particular,
// reconcileGenerationCost()'s same-job delta math is untouched — nothing
// below reimplements or duplicates it).
//
// Everything below is NEW. It exists because the forensic audit proved
// that "read project -> await provider call -> mutate -> save" is not
// atomic: two concurrent requests for the same project can both read the
// same `reserved`/remaining-budget figures, both decide they fit, and
// then the second writeFileSync silently overwrites the first (a lost
// update). The fix is a per-project async lock PLUS doing a fresh disk
// read of the project INSIDE that lock, rather than trusting whatever
// project object the caller happened to already be holding.
// ---------------------------------------------------------------------------

// projectId -> Promise. Represents the tail of that project's serialized
// queue of financial mutations. Deliberately process-local (a plain
// in-memory Map) — see the file header note on why that is an honest,
// sufficient guarantee for this codebase's current architecture rather
// than a limitation being hidden.
const projectLocks = new Map();

// Runs `fn` (which may be async) after every previously-queued financial
// mutation for `projectId` has finished, and before any later-queued one
// starts. Different projectIds never wait on each other — this Map only
// ever holds one promise per project that currently has in-flight work.
//
// Exception-safe: if `fn` throws/rejects, the caller's returned promise
// (`run`) still rejects with that real error, but the QUEUE itself
// ("chained") always resolves, so a failed mutation never poisons future
// mutations for the same project ("a failed lock callback must not
// poison the queue permanently" — Part 5).
//
// Self-cleaning: once nothing further is chained behind this call, the
// Map entry is removed, so long-lived processes don't accumulate one
// resolved-promise entry per project forever.
function withProjectLock(projectId, fn) {
  const previous = projectLocks.get(projectId) || Promise.resolve();
  const run = previous.then(() => fn());
  const chained = run.then(
    () => undefined,
    () => undefined
  );
  projectLocks.set(projectId, chained);
  chained.finally(() => {
    if (projectLocks.get(projectId) === chained) {
      projectLocks.delete(projectId);
    }
  });
  return run;
}

// Appends one audit-trail entry. Never called directly by anything
// outside this file — every code path that wants a ledger event goes
// through reserveBudget/releaseReservation/settleGenerationCost/
// settleUsdSpend so the event shape can never drift from what those
// functions actually did.
function appendLedgerEvent(ledger, { jobId, provider, operation, amount, currency, event, note } = {}) {
  ledger.ledgerEvents.push({
    eventId: crypto.randomUUID(),
    jobId: jobId || null,
    provider: provider || null,
    operation: operation || null,
    amount: typeof amount === 'number' ? amount : null,
    currency: currency || null,
    event,
    at: new Date().toISOString(),
    note: note || null,
  });
}

// Part 6/7 — reserve budget/exposure for ONE operation, atomically, for
// EITHER currency this codebase actually bills in:
//   currency: 'credits' — EvoLink. `amount` is the best pre-call estimate
//     available (the per-operation approval's estimatedCost — EvoLink
//     itself never exposes a pre-submission quote, see the file header).
//     Checked against remaining budget and committed atomically inside
//     the lock. Seeds ledger.reconciledJobs[jobId] with this amount as
//     the delta baseline, so the EXISTING reconcileGenerationCost() call
//     that happens later (once EvoLink reports its real reservedCost)
//     naturally corrects the estimate to the real number via its own
//     unmodified delta math — never double-counted.
//     `amount === null` means "genuinely unknown pre-call cost"; this is
//     only allowed through if the project's approval already carries
//     unknownCostAcknowledged (Part 5's existing policy — this function
//     does not invent a new one).
//   currency: 'usd' — Apify or Anthropic. `amount` is either a real known
//     pre-call price (Apify's fixed per-item price; Anthropic's
//     token-estimate-based cost) or null when no pre-call cost exists
//     (e.g. Apify's duration-priced video download, whose duration isn't
//     known until after the download). A null amount is recorded
//     honestly as an UNKNOWN reservation — never estimated, never
//     treated as zero. There is no numeric USD ceiling anywhere in this
//     codebase (confirmed in the forensic audit), so a `usd` reservation
//     only fails if the provider/currency itself is invalid — it is
//     bookkeeping/audit-trail, not a budget check.
//
// Returns { allowed, reason, project } — mirrors canProceed()'s shape.
// Never throws for a legitimate "blocked" outcome; throws only for a
// genuinely invalid call (bad projectId, bad currency).
async function reserveBudget(projectId, { jobId, provider, operation, amount, currency = 'credits', unknownCostAcknowledged = false, note } = {}) {
  return withProjectLock(projectId, () => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new Error(`reserveBudget: no such project "${projectId}"`);
    ensureShape(project);
    const ledger = project.creditLedger;

    if (currency === 'credits') {
      if (amount == null) {
        if (!unknownCostAcknowledged && !project.approvals.unknownCostAcknowledged) {
          return {
            allowed: false,
            reason: `Unknown reservation cost for job ${jobId} has not been acknowledged (policy: ${UNKNOWN_COST_POLICY}).`,
            project,
          };
        }
        appendLedgerEvent(ledger, { jobId, provider: provider || 'evolink', operation, amount: null, currency, event: 'RESERVED', note: note || 'Pre-call cost UNKNOWN; proceeding on acknowledged unknown-cost policy.' });
        projectStore.touch(project);
        return { allowed: true, project };
      }

      const remaining = getRemainingBudget(project);
      if (remaining != null && amount > remaining) {
        return { allowed: false, reason: 'Reservation would exceed the remaining project budget.', project };
      }

      ledger.reserved = round2((ledger.reserved || 0) + amount);
      ledger.reconciledJobs[jobId] = { reservedCost: amount, actualCost: null };
      appendLedgerEvent(ledger, { jobId, provider: provider || 'evolink', operation, amount, currency, event: 'RESERVED', note: note || null });
      projectStore.touch(project);
      return { allowed: true, project };
    }

    if (currency === 'usd') {
      const bucket = ledger.usdSpend[provider];
      if (!bucket) throw new Error(`reserveBudget: unknown usd provider bucket "${provider}"`);
      if (typeof amount === 'number') {
        bucket.reservedUsd = roundUsd((bucket.reservedUsd || 0) + amount);
      }
      appendLedgerEvent(ledger, {
        jobId,
        provider,
        operation,
        amount: typeof amount === 'number' ? amount : null,
        currency,
        event: 'RESERVED',
        note: note || (amount == null ? 'Pre-call cost UNKNOWN for this provider/operation.' : null),
      });
      projectStore.touch(project);
      return { allowed: true, project };
    }

    throw new Error(`reserveBudget: unsupported currency "${currency}"`);
  });
}

// Releases a reservation made by reserveBudget(), atomically. Only ever
// releases the CREDITS portion if that job's cost is still unconfirmed
// (i.e. reconcileGenerationCost/settleGenerationCost never ran for it) —
// once a real actualCost has been recorded, the reservation has already
// been superseded by a settlement and must not be subtracted out from
// under it (Part 12: "do not silently release a reservation after a
// crash when provider outcome is unknown" — this function is for the
// OPPOSITE, confirmed case: the provider outcome IS known to be "did not
// happen" or "was never billed", e.g. a throw before EvoLink's task was
// ever created).
async function releaseReservation(projectId, { jobId, provider, currency = 'credits', amount, note } = {}) {
  return withProjectLock(projectId, () => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new Error(`releaseReservation: no such project "${projectId}"`);
    ensureShape(project);
    const ledger = project.creditLedger;

    let releasedAmount = null;
    if (currency === 'credits') {
      const previous = ledger.reconciledJobs[jobId];
      if (previous && previous.actualCost == null) {
        releasedAmount = previous.reservedCost || 0;
        ledger.reserved = round2((ledger.reserved || 0) - releasedAmount);
        delete ledger.reconciledJobs[jobId];
      }
    } else if (currency === 'usd') {
      const bucket = ledger.usdSpend[provider];
      if (bucket && typeof amount === 'number') {
        bucket.reservedUsd = roundUsd((bucket.reservedUsd || 0) - amount);
        releasedAmount = amount;
      }
    }

    appendLedgerEvent(ledger, { jobId, provider: provider || 'evolink', operation: 'RELEASE', amount: releasedAmount, currency, event: 'RELEASED', note: note || null });
    projectStore.touch(project);
    return { released: true, project };
  });
}

// The concurrency-safe replacement for the unsafe
// `gate.reconcileGenerationCost(project, job); projectStore.touch(project);`
// call-site pattern every EvoLink generation service used to use directly
// on its own (possibly stale) in-memory project object. This does its own
// fresh read inside the lock, then delegates to the EXISTING, unmodified
// reconcileGenerationCost() for the actual math — Part 1 Rule 9 requires
// that delta logic stay exactly as it is, and it does.
async function settleGenerationCost(projectId, job) {
  return withProjectLock(projectId, () => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new Error(`settleGenerationCost: no such project "${projectId}"`);
    reconcileGenerationCost(project, job);
    if (typeof job.actualCost === 'number') {
      appendLedgerEvent(project.creditLedger, {
        jobId: job.id,
        provider: 'evolink',
        operation: job.operation || null,
        amount: job.actualCost,
        currency: 'credits',
        event: 'SETTLED',
        note: null,
      });
    }
    projectStore.touch(project);
    return project;
  });
}

// Part 7/11/12 — settles a USD-billed provider operation (Apify or
// Anthropic), atomically. `amount` is either a real actual cost (e.g.
// Anthropic's usage-derived actualCostUsd) or null when the provider's
// existing API response does not expose one (e.g. Apify's dataset-items
// endpoint, which never returns run-level cost — see Part 11). A null
// amount is NEVER treated as zero: it increments unknownSettlements
// instead of settledUsd, so "we don't know" and "it cost $0" can never be
// confused when reading the ledger back.
async function settleUsdSpend(projectId, { jobId, provider, operation, amount, note } = {}) {
  return withProjectLock(projectId, () => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new Error(`settleUsdSpend: no such project "${projectId}"`);
    ensureShape(project);
    const ledger = project.creditLedger;
    const bucket = ledger.usdSpend[provider];
    if (!bucket) throw new Error(`settleUsdSpend: unknown usd provider bucket "${provider}"`);

    if (typeof amount === 'number') {
      bucket.settledUsd = roundUsd((bucket.settledUsd || 0) + amount);
    } else {
      bucket.unknownSettlements += 1;
    }

    appendLedgerEvent(ledger, {
      jobId,
      provider,
      operation,
      amount: typeof amount === 'number' ? amount : null,
      currency: 'usd',
      event: 'SETTLED',
      note: note || (amount == null ? 'Actual cost UNKNOWN — this provider call does not expose it.' : null),
    });
    projectStore.touch(project);
    return project;
  });
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
  reserveBudget,
  releaseReservation,
  settleGenerationCost,
  settleUsdSpend,
};
