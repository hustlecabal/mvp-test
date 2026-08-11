// approval-gate.js
//
// This is the "nothing expensive happens without human approval" checkpoint.
// It knows nothing about HTTP or files on disk — it only works on a project
// object already in memory, and answers one question: canProceed(project)?
//
// Later, when real generation (e.g. calling EvoLink) is built, that code
// will call canProceed() first and refuse to spend anything if it says no.
// For now, nothing actually spends credits yet — this just builds the gate
// itself, and a way for a human to request/approve/reject through it.

function defaultApprovals() {
  return {
    status: 'NONE', // NONE -> PENDING -> APPROVED or REJECTED
    estimatedCost: null,
    note: null,
    requestedAt: null,
    decidedAt: null,
    decidedBy: null,
  };
}

function defaultCreditLedger() {
  return {
    limit: null, // no limit set yet
    spent: 0,
  };
}

// Projects created before this stage existed have approvals: {} and
// creditLedger: {} (empty placeholders from the original project model).
// This fills them in with a proper shape the first time the gate touches
// them, without requiring every old project file to be manually migrated.
function ensureShape(project) {
  if (!project.approvals || typeof project.approvals !== 'object' || !project.approvals.status) {
    project.approvals = defaultApprovals();
  }
  if (
    !project.creditLedger ||
    typeof project.creditLedger !== 'object' ||
    typeof project.creditLedger.spent !== 'number'
  ) {
    project.creditLedger = defaultCreditLedger();
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
    status: 'PENDING',
    estimatedCost: estimatedCost != null ? estimatedCost : null,
    note: note || null,
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
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

// The actual gate check. Returns { allowed, reason }.
function canProceed(project) {
  ensureShape(project);
  const { approvals, creditLedger } = project;

  if (approvals.status !== 'APPROVED') {
    return { allowed: false, reason: 'Project has not been approved for generation yet.' };
  }

  const estimatedCost = approvals.estimatedCost || 0;
  if (creditLedger.limit != null && creditLedger.spent + estimatedCost > creditLedger.limit) {
    return { allowed: false, reason: 'Approved cost would exceed the project budget limit.' };
  }

  return { allowed: true, reason: null };
}

module.exports = {
  defaultApprovals,
  defaultCreditLedger,
  ensureShape,
  setBudget,
  requestApproval,
  decideApproval,
  canProceed,
};
