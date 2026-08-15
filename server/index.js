const express = require('express');
const fs = require('fs');
const path = require('path');
const projectStore = require('./services/project-store');
const gate = require('./services/approval-gate');
const timelineStore = require('./services/timeline-store');
const assetStorage = require('./services/asset-storage');
const historyService = require('./services/generation-history-service');
const creativeStore = require('./services/creative-store');
const skillOrchestrator = require('./services/skill-orchestrator');
const keyframeStore = require('./services/keyframe-store');
const keyframePlanner = require('./services/keyframe-planner');
const keyframePromptService = require('./services/keyframe-prompt-service');
const keyframeGenerationApprovalStore = require('./services/keyframe-generation-approval-store');
const keyframeGenerationService = require('./services/keyframe-generation-service');
const generationStore = require('./services/generation-store');
const keyframeHandoffService = require('./services/keyframe-handoff-service');
const stateMachine = require('./schemas/state-machine');
const operatorQueueService = require('./services/operator-queue-service');
const referenceLibraryService = require('./services/reference-library-service');
const identityConsistencyReviewStore = require('./services/identity-consistency-review-store');
const { REFERENCE_ENTITY_TYPES } = require('./schemas/creative-schema');
const generationModelRegistry = require('./services/generation-model-registry');
const videoPromptService = require('./services/video-prompt-service');
const videoGenerationApprovalStore = require('./services/video-generation-approval-store');
const videoGenerationService = require('./services/video-generation-service');

const app = express();
const PORT = process.env.PORT || 3000;

// Lets Express read a JSON body (e.g. { "title": "..." }) sent by a client
// and turn it into req.body for us.
app.use(express.json());

// Stage 10 — serves frontend/ (plain HTML/CSS/JS, no build step) so the
// whole app runs from one `npm start`. The frontend calls this same API
// using relative paths (same origin — no CORS setup needed).
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'evolink-video-factory-server',
    timestamp: new Date().toISOString(),
  });
});

// Create a new project.
app.post('/projects', (req, res) => {
  const { title, topic } = req.body || {};

  if (title !== undefined && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }
  if (topic !== undefined && typeof topic !== 'string') {
    return res.status(400).json({ error: 'topic must be a string' });
  }

  const project = projectStore.createProject({ title, topic });
  res.status(201).json(project);
});

// List every saved project.
app.get('/projects', (req, res) => {
  res.json(projectStore.listProjects());
});

// Get one project by id.
app.get('/projects/:id', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(project);
});

// Update a project's title and/or topic. Stage 13E, Part 4 — status is
// deliberately NOT accepted here (see services/project-store.js's
// UPDATABLE_FIELDS comment): it must only ever change through the state
// machine's own transition() function, via POST /projects/:id/transition
// below, so canTransition()'s legality check and (for a generation state)
// the approval/budget gate are never silently skipped.
app.patch('/projects/:id', (req, res) => {
  const { title, topic, status } = req.body || {};

  if (status !== undefined) {
    return res.status(400).json({
      error: 'status cannot be changed through PATCH /projects/:id. Use POST /projects/:id/transition instead, so the change goes through the state machine.',
    });
  }
  if (title !== undefined && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }
  if (topic !== undefined && typeof topic !== 'string') {
    return res.status(400).json({ error: 'topic must be a string' });
  }

  const updated = projectStore.updateProject(req.params.id, { title, topic });
  if (!updated) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(updated);
});

// Stage 13E, Part 4 — the ONLY REST route that may change project.status,
// and it does so exactly the way mcp/tools/project-tools.js's
// transition_project does: through schemas/state-machine.js's transition()
// (which itself calls the approval/budget gate before allowing entry into
// a generation state), never a raw field assignment. See
// docs/architecture/control-surfaces.md.
app.post('/projects/:id/transition', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { to } = req.body || {};
  if (!to || typeof to !== 'string') {
    return res.status(400).json({ error: '"to" (the target state) is required' });
  }

  const result = stateMachine.transition(project, to);
  if (!result.ok) {
    return res.status(409).json({ error: result.reason, currentState: project.status });
  }

  projectStore.touch(project);
  res.json(result.project);
});

// Set (or change) how many credits a project is allowed to spend in total.
app.post('/projects/:id/budget', (req, res) => {
  const { limit } = req.body || {};

  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }

  const project = projectStore.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  gate.setBudget(project, limit);
  res.json(projectStore.touch(project));
});

// Stage 13E, Part 5 — expose the existing (previously unexposed)
// acknowledgeOverage. Never raises the budget limit, never touches
// approvals.status, never modifies a generation job. Idempotent-by-
// response: acknowledging an already-acknowledged overage returns 200
// with alreadyAcknowledged: true rather than silently re-stamping
// who/when, and never hides the overage after acknowledgement.
app.post('/projects/:id/budget/overage/acknowledge', (req, res) => {
  const { acknowledgedBy, note } = req.body || {};
  if (acknowledgedBy !== undefined && typeof acknowledgedBy !== 'string') {
    return res.status(400).json({ error: 'acknowledgedBy must be a string' });
  }
  if (note !== undefined && typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }

  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  gate.ensureShape(project);
  const { overage } = project.creditLedger;
  if (!overage) {
    return res.status(409).json({ error: 'No active budget overage exists for this project.' });
  }
  if (overage.acknowledged) {
    return res.json({ alreadyAcknowledged: true, overage, budget: gate.getBudgetView(project) });
  }

  gate.acknowledgeOverage(project, { acknowledgedBy, note });
  projectStore.touch(project);
  res.json({ alreadyAcknowledged: false, overage: project.creditLedger.overage, budget: gate.getBudgetView(project) });
});

// Ask for human approval before any generation is allowed to happen.
// estimatedCost is optional — a rough number of credits this step might use.
app.post('/projects/:id/approval/request', (req, res) => {
  const { estimatedCost, note } = req.body || {};

  if (estimatedCost !== undefined && (typeof estimatedCost !== 'number' || !Number.isFinite(estimatedCost) || estimatedCost < 0)) {
    return res.status(400).json({ error: 'estimatedCost must be a non-negative number' });
  }
  if (note !== undefined && typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }

  const project = projectStore.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  gate.requestApproval(project, { estimatedCost, note });
  res.json(projectStore.touch(project));
});

// A human approves or rejects the most recent pending approval request.
app.post('/projects/:id/approval/decision', (req, res) => {
  const { approve, decidedBy, note } = req.body || {};

  if (typeof approve !== 'boolean') {
    return res.status(400).json({ error: 'approve must be true or false' });
  }
  if (decidedBy !== undefined && typeof decidedBy !== 'string') {
    return res.status(400).json({ error: 'decidedBy must be a string' });
  }
  if (note !== undefined && typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }

  const project = projectStore.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const updated = gate.decideApproval(project, { approve, decidedBy, note });
  if (!updated) {
    return res.status(400).json({ error: 'No pending approval request for this project' });
  }

  res.json(projectStore.touch(updated));
});

// Check the gate: is this project currently allowed to generate anything?
// This is read-only — it does not change or save the project.
app.get('/projects/:id/approval', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  gate.ensureShape(project);
  res.json({
    approvals: project.approvals,
    creditLedger: project.creditLedger,
    canProceed: gate.canProceed(project),
  });
});

// Stage 10 — the same complete budget picture the get_project_budget MCP
// tool returns (both call gate.getBudgetView, so there is only one
// implementation of what "the budget view" means). Read-only.
app.get('/projects/:id/budget', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(gate.getBudgetView(project));
});

// Stage 10 — every generation attempt for one shot, exactly what the
// get_shot_history MCP tool returns (both call
// services/generation-history-service.js). Read-only — never triggers a
// generation.
app.get('/shots/:shotId/history', (req, res) => {
  const records = historyService.listShotHistory(req.params.shotId);
  if (records === null) {
    return res.status(404).json({ error: 'Shot not found' });
  }
  res.json({ shotId: req.params.shotId, generations: records, totalCount: records.length });
});

// Stage 11C — Creative Director workspace API. Every route here is a
// thin wrapper over services/creative-store.js (Stage 11A) — no creative
// business logic is duplicated here, matching every other stage's REST
// layer. None of these routes import or call approval-gate.js,
// generation-service.js, or any provider — saving a creative artifact
// cannot create a generation job, spend a credit, or change budget/
// approval state, because this code has no path to reach any of that.

// Part 13's save rule, steps 2-3: a non-blank changeNote is required on
// every creative save. Returns the trimmed note, or writes a 400 and
// returns null (caller must stop on null).
function requireChangeNote(body, res) {
  const note = typeof body.changeNote === 'string' ? body.changeNote.trim() : '';
  if (!note) {
    res.status(400).json({ error: 'changeNote is required and cannot be blank.' });
    return null;
  }
  return note;
}

// Every PUT body may include `updatedBy` and `changeNote` alongside the
// artifact's own fields — this splits those two bookkeeping fields out so
// only real field updates get passed to the store layer.
function splitVersionMeta(body) {
  const { changeNote, updatedBy, ...updates } = body || {};
  return { changeNote, updatedBy, updates };
}

// GET everything the Creative Director workspace needs in one call.
app.get('/projects/:id/creative', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(creativeStore.getCreativeRecord(req.params.id));
});

app.get('/projects/:id/creative/brief', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(creativeStore.getCreativeBrief(req.params.id));
});

app.put('/projects/:id/creative/brief', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  res.json(creativeStore.updateCreativeBrief(req.params.id, updates, { updatedBy, changeNote }));
});

app.get('/projects/:id/creative/spec', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(creativeStore.getMasterCreativeSpec(req.params.id));
});

app.put('/projects/:id/creative/spec', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  res.json(creativeStore.updateMasterCreativeSpec(req.params.id, updates, { updatedBy, changeNote }));
});

app.get('/projects/:id/creative/bible', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(creativeStore.getVisualBible(req.params.id));
});

app.put('/projects/:id/creative/bible', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  res.json(creativeStore.updateVisualBible(req.params.id, updates, { updatedBy, changeNote }));
});

app.get('/projects/:id/creative/storyboard', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(creativeStore.getStoryboard(req.params.id));
});

app.put('/projects/:id/creative/storyboard', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  res.json(creativeStore.updateStoryboard(req.params.id, updates, { updatedBy, changeNote }));
});

// Stage 24 — adds ONE new scene/shot, mirroring create_storyboard_scene/
// create_storyboard_shot's MCP behavior exactly (creativeStore.addStoryboardScene/
// addStoryboardShot). Found missing during the Stage 24 UI acceptance audit:
// the frontend had no way to create a scene or shot at all — only edit an
// existing shot's fields (PUT .../shots/:shotId below) or bulk-replace the
// whole storyboard (PUT .../storyboard above). Never generates anything,
// never touches approval/budget.
app.post('/projects/:id/creative/storyboard/scenes', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  const scene = creativeStore.addStoryboardScene(req.params.id, updates, { updatedBy, changeNote });
  res.json(scene);
});

app.post('/projects/:id/creative/storyboard/shots', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  let shot;
  try {
    shot = creativeStore.addStoryboardShot(req.params.id, updates, { updatedBy, changeNote });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json(shot);
});

// The Shot Editor's Save action — updates one shot's fields in place.
app.put('/projects/:id/creative/storyboard/shots/:shotId', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  let updated;
  try {
    updated = creativeStore.updateStoryboardShot(req.params.id, req.params.shotId, updates, { updatedBy, changeNote });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!updated) return res.status(404).json({ error: 'Shot not found' });
  res.json(updated);
});

// Stage 11C — read-only skill discovery for the Creative Skills panel.
// Thin wrappers over services/skill-orchestrator.js; no skill is ever run.
app.get('/skills', (req, res) => {
  res.json(skillOrchestrator.listSkills());
});

app.get('/skills/recommendation', (req, res) => {
  const { desiredOutput, platform, needsCinematicPlanning, needsReferenceImage } = req.query;
  res.json(
    skillOrchestrator.recommendSkill({
      desiredOutput,
      platform,
      needsCinematicPlanning: needsCinematicPlanning === 'true',
      needsReferenceImage: needsReferenceImage === 'true',
    })
  );
});

// Stage 12 — the Keyframe Intelligence layer. See
// docs/architecture/keyframe-intelligence.md. Every route below is thin:
// it validates the project exists, then delegates to
// services/keyframe-store.js or services/keyframe-planner.js. Nothing here
// can generate an image/video, call EvoLink, or spend a credit.

app.get('/projects/:id/keyframes', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(keyframeStore.getKeyframePlan(req.params.id));
});

app.put('/projects/:id/keyframes', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  res.json(keyframeStore.updateKeyframePlan(req.params.id, updates, { updatedBy, changeNote }));
});

app.get('/keyframes/:keyframeId', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });
  res.json(found.keyframe);
});

app.put('/keyframes/:keyframeId', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const changeNote = requireChangeNote(req.body || {}, res);
  if (changeNote === null) return;
  const { updatedBy, updates } = splitVersionMeta(req.body);

  const updated = keyframeStore.updateKeyframe(found.project.id, req.params.keyframeId, updates, { updatedBy, changeNote });
  if (!updated) return res.status(404).json({ error: 'Keyframe not found' });
  res.json(updated);
});

app.post('/projects/:id/keyframes', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { updatedBy, changeNote, ...fields } = req.body || {};
  const keyframe = keyframeStore.createKeyframe(req.params.id, fields, { updatedBy, changeNote });
  res.status(201).json(keyframe);
});

// Stage 13E, Part 1 — the canonical keyframe asset. PUT always requires an
// explicit assetId from the caller; nothing here ever auto-selects one.
app.put('/keyframes/:keyframeId/canonical-asset', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { assetId, selectedBy, changeNote } = req.body || {};
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const result = keyframeStore.selectCanonicalKeyframeAsset(found.project.id, req.params.keyframeId, assetId, { selectedBy, changeNote });
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.keyframe);
});

app.get('/keyframes/:keyframeId/canonical-asset', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });
  res.json(keyframeStore.getCanonicalKeyframeAsset(found.project.id, req.params.keyframeId));
});

// Read-only requirement analysis for one storyboard shot (Part 6-10). Never
// creates a keyframe, generation job, or spends a credit — see
// POST /projects/:id/keyframes to actually record a recommendation.
app.post('/projects/:id/keyframes/analyze', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { shotId } = req.body || {};
  const result = keyframePlanner.analyzeShotKeyframes(req.params.id, shotId);
  if (!result) return res.status(404).json({ error: 'Storyboard shot not found' });
  res.json(result);
});

// Stage 13A — Keyframe Prompt Packaging. See
// docs/architecture/keyframe-prompt-packaging.md. Every route below is a
// thin wrapper over services/keyframe-prompt-service.js. Nothing here can
// generate an image/video, call EvoLink, execute a skill, or spend a
// credit.

app.get('/keyframes/:keyframeId/prompt-package', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const pkg = keyframePromptService.getKeyframePromptPackage(found.project.id, req.params.keyframeId);
  if (!pkg) return res.status(404).json({ error: 'No prompt package has been built for this keyframe yet' });
  res.json(pkg);
});

app.post('/keyframes/:keyframeId/prompt-package', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { updatedBy, changeNote } = req.body || {};
  const pkg = keyframePromptService.buildKeyframePromptPackage(found.project.id, req.params.keyframeId, { updatedBy, changeNote });
  res.json(pkg);
});

app.get('/projects/:id/keyframe-prompt-packages', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { shotId, sceneId, status } = req.query;
  res.json(keyframePromptService.listKeyframePromptPackages(req.params.id, { shotId, sceneId, status }));
});

// Stage 22B-Part-2 — Video Prompt Packaging. See
// docs/architecture/video-prompt-package.md. Every route below is a thin
// wrapper over services/video-prompt-service.js. Nothing here can generate
// a video, call EvoLink or Google, execute a skill, spend a credit, create
// a generation job, or create/change a generation approval or
// canonical-asset selection. provider/model are never defaulted here —
// the caller must supply them explicitly.

app.get('/keyframes/:keyframeId/video-prompt-package', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const pkg = videoPromptService.getVideoPromptPackage(found.project.id, req.params.keyframeId);
  if (!pkg) return res.status(404).json({ error: 'No video prompt package has been built for this keyframe yet' });
  res.json(pkg);
});

app.post('/keyframes/:keyframeId/video-prompt-package', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { provider, model, requiresReferenceImages, creativeSpecification, executionParameters, updatedBy, changeNote } = req.body || {};
  const result = videoPromptService.buildVideoPromptPackage(found.project.id, req.params.keyframeId, {
    provider,
    model,
    requiresReferenceImages,
    creativeSpecification,
    executionParameters,
    updatedBy,
    changeNote,
  });
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

app.get('/shots/:shotId/video-prompt-packages', (req, res) => {
  const project = creativeStore.findProjectByShotId(req.params.shotId);
  if (!project) return res.status(404).json({ error: 'Shot not found' });

  const { sceneId, status } = req.query;
  res.json(videoPromptService.listVideoPromptPackages(project.id, { shotId: req.params.shotId, sceneId, status }));
});

// Stage 22B-Part-3 — Controlled Video Generation. See docs/architecture/
// video-generation-lifecycle.md. Every route below is a thin wrapper over
// services/video-generation-approval-store.js or services/video-
// generation-service.js — all safety checks (approval binding, canonical
// asset, model registry, budget, duplicate protection) live in those
// services, never here. POST /shots/:shotId/video-generation is the only
// route that can cause a real provider call, and only if that service's
// checks all pass. A shot can have more than one keyframe, so every route
// below also requires an explicit `keyframeId` (query for GET, body for
// POST) naming exactly which keyframe's video is being acted on — never
// inferred or defaulted.
//
// Resolves the owning project via creativeStore.findProjectByShotId() (the
// same helper video-prompt-packages above already uses), then confirms
// the given keyframeId genuinely belongs to that shot before delegating.
function resolveShotKeyframe(shotId, keyframeId) {
  if (!keyframeId) return { error: 'keyframeId is required' };
  const project = creativeStore.findProjectByShotId(shotId);
  if (!project) return { error: 'Shot not found' };
  const keyframe = keyframeStore.getKeyframe(project.id, keyframeId);
  if (!keyframe || keyframe.shotId !== shotId) return { error: `Keyframe "${keyframeId}" does not belong to shot "${shotId}"` };
  return { project, keyframe };
}

app.post('/shots/:shotId/video-generation/approval', (req, res) => {
  const { keyframeId, estimatedCost, reason, requestedBy } = req.body || {};
  const resolved = resolveShotKeyframe(req.params.shotId, keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });

  const pkg = videoPromptService.getVideoPromptPackage(resolved.project.id, keyframeId);
  if (!pkg) return res.status(409).json({ error: 'No video prompt package has been built for this keyframe yet.' });

  const approval = videoGenerationApprovalStore.requestApproval(resolved.project.id, keyframeId, {
    sceneId: resolved.keyframe.sceneId,
    shotId: resolved.keyframe.shotId,
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    executionParameters: pkg.executionParameters,
    estimatedCost,
    reason,
    requestedBy,
  });
  res.json(approval);
});

app.get('/shots/:shotId/video-generation/approval', (req, res) => {
  const resolved = resolveShotKeyframe(req.params.shotId, req.query.keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  res.json(videoGenerationApprovalStore.getApproval(resolved.project.id, req.query.keyframeId));
});

app.post('/shots/:shotId/video-generation/approval/approve', (req, res) => {
  const { keyframeId, approvedBy } = req.body || {};
  const resolved = resolveShotKeyframe(req.params.shotId, keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });

  const approval = videoGenerationApprovalStore.decideApproval(resolved.project.id, keyframeId, { approve: true, decidedBy: approvedBy });
  if (!approval) return res.status(409).json({ error: 'No pending video generation approval request to approve.' });
  res.json(approval);
});

app.post('/shots/:shotId/video-generation/approval/reject', (req, res) => {
  const { keyframeId, decidedBy, reason } = req.body || {};
  const resolved = resolveShotKeyframe(req.params.shotId, keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });

  const approval = videoGenerationApprovalStore.decideApproval(resolved.project.id, keyframeId, { approve: false, decidedBy, reason });
  if (!approval) return res.status(409).json({ error: 'No pending video generation approval request to reject.' });
  res.json(approval);
});

// Stage 23 — exposes the existing videoGenerationApprovalStore.acknowledgeUnknownCost
// (present since Stage 22B-Part-3 but never reachable outside a direct
// script call). Never invents a cost, never changes the approval status
// itself — only records that a human explicitly acknowledged an unknown
// estimatedCost, exactly mirroring approval-gate.js's own UNKNOWN_COST_
// REQUIRES_EXPLICIT_APPROVAL policy for the project-level ledger.
app.post('/shots/:shotId/video-generation/approval/acknowledge-unknown-cost', (req, res) => {
  const { keyframeId, acknowledgedBy } = req.body || {};
  const resolved = resolveShotKeyframe(req.params.shotId, keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });

  const approval = videoGenerationApprovalStore.acknowledgeUnknownCost(resolved.project.id, keyframeId, { acknowledgedBy });
  if (!approval) return res.status(409).json({ error: 'No video generation approval exists for this keyframe yet.' });
  res.json(approval);
});

app.get('/shots/:shotId/video-generation/eligibility', (req, res) => {
  const resolved = resolveShotKeyframe(req.params.shotId, req.query.keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  res.json(videoGenerationService.canGenerateVideo(resolved.project.id, req.query.keyframeId));
});

app.post('/shots/:shotId/video-generation', async (req, res) => {
  const { keyframeId } = req.body || {};
  const resolved = resolveShotKeyframe(req.params.shotId, keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });

  const result = await videoGenerationService.generateVideo(resolved.project.id, keyframeId);
  res.json(result);
});

// Stage 23 — lists every video generation job (with its resulting asset,
// if any) for one keyframe, newest included, so a client can find the
// most recent completed video to review without already knowing its
// generationId. Read-only; thin wrapper over videoGenerationService.
// listVideoGenerations, which was already exported but had no route.
app.get('/shots/:shotId/video-generations', (req, res) => {
  const resolved = resolveShotKeyframe(req.params.shotId, req.query.keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  res.json(videoGenerationService.listVideoGenerations(resolved.project.id, req.query.keyframeId));
});

app.get('/shots/:shotId/video-generation/:generationId', (req, res) => {
  // The generationId itself is globally unique (services/generation-
  // store.js), so no keyframeId is required here — but the shot is still
  // confirmed as a sanity check that the caller has the right URL.
  const project = creativeStore.findProjectByShotId(req.params.shotId);
  if (!project) return res.status(404).json({ error: 'Shot not found' });

  const result = videoGenerationService.getVideoGenerationStatus(req.params.generationId);
  if (!result || result.projectId !== project.id || result.shotId !== req.params.shotId) {
    return res.status(404).json({ error: `No video generation job found with id "${req.params.generationId}" for shot "${req.params.shotId}"` });
  }
  res.json(result);
});

// Stage 23 — human review of a completed video asset. Mirrors POST
// /keyframes/:keyframeId/approval's shape exactly (the existing image-asset
// review route), but delegates to videoGenerationService.approveGeneratedVideo/
// rejectGeneratedVideo since a video asset has no keyframe-generation-status
// field to update (see that service's own comment on why). Never generates,
// never re-selects a canonical asset, never touches the approved canonical
// KEYFRAME image — this only ever changes the VIDEO asset's own approvalStatus.
app.post('/shots/:shotId/video-generation/review', (req, res) => {
  const { keyframeId, assetId, approve, decidedBy, reason } = req.body || {};
  const resolved = resolveShotKeyframe(req.params.shotId, keyframeId);
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const result = approve
    ? videoGenerationService.approveGeneratedVideo(resolved.project.id, keyframeId, assetId, { approvedBy: decidedBy })
    : videoGenerationService.rejectGeneratedVideo(resolved.project.id, keyframeId, assetId, { decidedBy, reason });

  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result);
});

// Stage 13B — Controlled Keyframe Generation. See docs/architecture/
// keyframe-generation.md. Every route below is a thin wrapper over
// services/keyframe-generation-approval-store.js or
// services/keyframe-generation-service.js — all safety checks (approval,
// budget, staleness, duplicate protection) live in those services, never
// here. generate_keyframe (POST .../generate) is the only route that can
// cause a real (fake-provider, in this stage) generation, and only if
// that service's checks all pass.

app.post('/keyframes/:keyframeId/generation-approval/request', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { promptPackageId, promptPackageVersion, estimatedCost, reason, requestedBy } = req.body || {};
  let resolvedPackageId = promptPackageId;
  let resolvedPackageVersion = promptPackageVersion;
  if (!resolvedPackageId) {
    const pkg = keyframePromptService.getKeyframePromptPackage(found.project.id, req.params.keyframeId);
    if (!pkg) {
      return res.status(409).json({ error: 'No prompt package has been built for this keyframe yet.' });
    }
    resolvedPackageId = pkg.packageId;
    resolvedPackageVersion = pkg.version;
  }

  const approval = keyframeGenerationApprovalStore.requestApproval(found.project.id, req.params.keyframeId, {
    promptPackageId: resolvedPackageId,
    promptPackageVersion: resolvedPackageVersion,
    estimatedCost,
    reason,
    requestedBy,
  });
  res.json(approval);
});

app.get('/keyframes/:keyframeId/generation-approval', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });
  res.json(keyframeGenerationApprovalStore.getApproval(found.project.id, req.params.keyframeId));
});

app.post('/keyframes/:keyframeId/generation-approval/decision', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { approve, decidedBy, reason } = req.body || {};
  const approval = keyframeGenerationApprovalStore.decideApproval(found.project.id, req.params.keyframeId, { approve, decidedBy, reason });
  if (!approval) return res.status(409).json({ error: 'No pending keyframe generation approval request to decide.' });

  if (approve) {
    keyframeStore.setKeyframeGenerationStatus(found.project.id, req.params.keyframeId, 'GENERATION_APPROVED');
  }
  res.json(approval);
});

app.post('/keyframes/:keyframeId/generate', async (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const result = await keyframeGenerationService.generateKeyframe(found.project.id, req.params.keyframeId);
  res.json(result);
});

app.get('/keyframes/:keyframeId/generations', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });
  res.json(keyframeGenerationService.listKeyframeGenerations(found.project.id, req.params.keyframeId));
});

app.get('/keyframe-generations/:generationId', (req, res) => {
  const job = generationStore.getGenerationJob(req.params.generationId);
  if (!job || job.generationType !== 'IMAGE_KEYFRAME') return res.status(404).json({ error: 'Keyframe generation job not found' });
  res.json(job);
});

// Part 13's post-generation human review — deliberately a DIFFERENT route
// (and a different store) than /generation-approval/decision above: that
// one authorizes SUBMITTING a generation; this one records what a human
// thinks of its RESULT.
app.post('/keyframes/:keyframeId/approval', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { approve, assetId, decidedBy, reason } = req.body || {};
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const result = approve
    ? keyframeGenerationService.approveGeneratedKeyframe(found.project.id, req.params.keyframeId, assetId, { approvedBy: decidedBy })
    : keyframeGenerationService.rejectGeneratedKeyframe(found.project.id, req.params.keyframeId, assetId, { decidedBy, reason });

  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result);
});

// Stage 13D — Human Keyframe Execution Handoff. See
// docs/architecture/keyframe-execution-bridge.md (Stage 13C) for why the
// real execution step is a human, not an automated call. Every route
// below is a thin wrapper over services/keyframe-handoff-service.js.
// Nothing here calls Higgsfield, an image API, or EvoLink — the only
// "execution" that happens is writing a human-supplied image's bytes to
// local disk once every safety check (approval, package currency,
// duplicate protection) has passed.

app.post('/keyframes/:keyframeId/handoff', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });

  const { createdBy, notes } = req.body || {};
  const result = keyframeHandoffService.createHandoff(found.project.id, req.params.keyframeId, { createdBy, notes });
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.status(201).json(result.handoff);
});

app.get('/keyframes/:keyframeId/handoffs', (req, res) => {
  const found = keyframeStore.findKeyframeById(req.params.keyframeId);
  if (!found) return res.status(404).json({ error: 'Keyframe not found' });
  res.json(keyframeHandoffService.listHandoffs(found.project.id, { keyframeId: req.params.keyframeId }));
});

app.get('/handoffs/:handoffId', (req, res) => {
  const found = keyframeHandoffService.findHandoffById(req.params.handoffId);
  if (!found) return res.status(404).json({ error: 'Handoff not found' });
  res.json(found.handoff);
});

app.put('/handoffs/:handoffId', (req, res) => {
  const found = keyframeHandoffService.findHandoffById(req.params.handoffId);
  if (!found) return res.status(404).json({ error: 'Handoff not found' });

  const { status, notes, updatedBy, changeNote } = req.body || {};
  const result = keyframeHandoffService.updateHandoff(found.project.id, req.params.handoffId, { status, notes }, { updatedBy, changeNote });
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.handoff);
});

app.post('/handoffs/:handoffId/cancel', (req, res) => {
  const found = keyframeHandoffService.findHandoffById(req.params.handoffId);
  if (!found) return res.status(404).json({ error: 'Handoff not found' });

  const { decidedBy, reason } = req.body || {};
  const result = keyframeHandoffService.cancelHandoff(found.project.id, req.params.handoffId, { decidedBy, reason });
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.handoff);
});

app.get('/handoffs/:handoffId/package', (req, res) => {
  const found = keyframeHandoffService.findHandoffById(req.params.handoffId);
  if (!found) return res.status(404).json({ error: 'Handoff not found' });

  const pkg = keyframeHandoffService.buildExecutionPackage(found.project.id, req.params.handoffId);
  res.json(pkg);
});

// Part 6 — the image-return/ingestion endpoint. Deliberately raw-body,
// not JSON: the request body IS the image's bytes, nothing else. Never
// trusts the client's Content-Type or any filename — see
// asset-storage.js's storeUploadedImage(), which identifies the format
// by sniffing the file's own magic bytes and is the only thing that
// decides whether this is really a supported image.
app.post('/handoffs/:handoffId/asset', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
  const found = keyframeHandoffService.findHandoffById(req.params.handoffId);
  if (!found) return res.status(404).json({ error: 'Handoff not found' });

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Request body must be the raw image bytes.' });
  }

  const completedBy = req.query.completedBy || req.get('X-Completed-By') || null;
  const result = keyframeHandoffService.ingestHandoffAsset(req.params.handoffId, req.body, { completedBy });
  if (!result.ok) {
    const status = result.code === 'already_ingested' || result.code === 'cancelled' || result.code === 'invalid_status' ? 409 : 400;
    return res.status(status).json({ error: result.reason });
  }
  res.status(201).json(result);
});

// Stage 14 — the Operator Queue. All three routes are thin wrappers over
// services/operator-queue-service.js — no queue logic lives here. Every
// one is read-only: nothing below can generate, approve, or mutate
// anything. See docs/architecture/operator-queue.md.
app.get('/projects/:id/operator-queue', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(operatorQueueService.buildProjectQueue(req.params.id));
});

app.get('/projects/:id/operator-queue/summary', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(operatorQueueService.getQueueSummary(req.params.id));
});

app.get('/projects/:id/operator-queue/next', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(operatorQueueService.getNextAction(req.params.id));
});

app.get('/projects/:id/shot-readiness', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(operatorQueueService.getShotReadiness(req.params.id));
});

// ================= Stage 19 — Reference Library / Identity Lock / Identity Consistency Review =================
// Every route below is a thin wrapper over services/reference-library-
// service.js, services/creative-store.js, and services/
// identity-consistency-review-store.js — no business logic lives here.
// PUT /reference-library/... routes always require an explicit assetId
// from the caller; nothing here ever auto-selects or auto-associates one.

function requireValidEntityType(entityType, res) {
  if (!REFERENCE_ENTITY_TYPES.includes(entityType)) {
    res.status(400).json({ error: `"${entityType}" is not a valid reference entity type. Use one of: ${REFERENCE_ENTITY_TYPES.join(', ')}` });
    return false;
  }
  return true;
}

app.get('/projects/:id/reference-library', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(referenceLibraryService.listReferenceLibrary(req.params.id));
});

app.get('/projects/:id/reference-library/:entityType/:entityId/identity-lock', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!requireValidEntityType(req.params.entityType, res)) return;

  const lock = referenceLibraryService.getIdentityLock(req.params.id, req.params.entityType, req.params.entityId);
  if (!lock) return res.status(404).json({ error: 'Entity not found' });
  res.json(lock);
});

app.post('/projects/:id/reference-library/:entityType/:entityId/reference-assets', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!requireValidEntityType(req.params.entityType, res)) return;

  const { assetId, updatedBy, changeNote } = req.body || {};
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const entity = creativeStore.addEntityReferenceAsset(req.params.id, req.params.entityType, req.params.entityId, assetId, { updatedBy, changeNote });
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  res.status(201).json(entity);
});

app.put('/projects/:id/reference-library/:entityType/:entityId/canonical', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!requireValidEntityType(req.params.entityType, res)) return;

  const { assetId, selectedBy, changeNote } = req.body || {};
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const result = creativeStore.selectCanonicalReferenceAsset(req.params.id, req.params.entityType, req.params.entityId, assetId, { selectedBy, changeNote });
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.entity);
});

app.get('/projects/:id/reference-library/:entityType/:entityId/canonical', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!requireValidEntityType(req.params.entityType, res)) return;

  const result = creativeStore.getCanonicalReferenceAsset(req.params.id, req.params.entityType, req.params.entityId);
  if (!result) return res.status(404).json({ error: 'Entity not found' });
  res.json(result);
});

app.post('/projects/:id/assets/:assetId/identity-review', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { keyframeId, referenceAssetId, scores, notes, reviewedBy } = req.body || {};
  let review;
  try {
    review = identityConsistencyReviewStore.recordReview(req.params.id, req.params.assetId, { keyframeId, referenceAssetId, scores, notes, reviewedBy });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!review) return res.status(404).json({ error: 'Project not found' });
  res.status(201).json(review);
});

app.get('/projects/:id/assets/:assetId/identity-reviews', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(identityConsistencyReviewStore.listReviews(req.params.id, req.params.assetId));
});

// Stage 24 — the upload half of adding a reference asset (found missing
// during the UI acceptance audit: reference-assets above only accepts an
// assetId that already exists, and nothing turned a human's raw image
// bytes into one). Deliberately raw-body, not JSON — same convention as
// POST /handoffs/:handoffId/asset — the request body IS the image's bytes.
app.post('/projects/:id/reference-library/:entityType/:entityId/upload', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!requireValidEntityType(req.params.entityType, res)) return;

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Request body must be the raw image bytes.' });
  }

  const uploadedBy = req.query.uploadedBy || req.get('X-Uploaded-By') || null;
  const result = creativeStore.ingestReferenceAsset(req.params.id, req.params.entityType, req.params.entityId, req.body, { uploadedBy });
  if (!result.ok) {
    const status = result.code === 'not_found' ? 404 : 400;
    return res.status(status).json({ error: result.reason });
  }
  res.status(201).json(result);
});

// Stage 25 — a human decision on a reference candidate, mirroring
// /keyframes/:keyframeId/approval (keyframe-generation-service.js) and the
// video-generation review route: an explicit APPROVED/REJECTED, scoped to
// an asset that is genuinely one of this entity's own reference assets.
app.post('/projects/:id/reference-library/:entityType/:entityId/assets/:assetId/decision', (req, res) => {
  const project = projectStore.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!requireValidEntityType(req.params.entityType, res)) return;

  const { approve, decidedBy } = req.body || {};
  if (typeof approve !== 'boolean') return res.status(400).json({ error: 'approve (boolean) is required' });

  const result = creativeStore.decideReferenceAsset(req.params.id, req.params.entityType, req.params.entityId, req.params.assetId, approve, { decidedBy });
  if (!result.ok) {
    const status = result.code === 'not_found' ? 404 : 400;
    return res.status(status).json({ error: result.reason });
  }
  res.json(result.asset);
});

// Stage 9A — permanent asset storage download/preview. See
// docs/architecture/asset-storage.md. Neither endpoint ever exposes the
// internal filesystem path to the client; both only stream file bytes.

// Shared by /download and /preview: looks up the asset and confirms it has
// actually been archived to local storage, or responds with a clear error
// and returns null. Never touches the filesystem path if this fails.
function requireStoredAsset(req, res) {
  const found = timelineStore.findAssetById(req.params.assetId);
  if (!found) {
    res.status(404).json({ error: 'Asset not found' });
    return null;
  }
  const { asset } = found;
  if (!asset.storage || asset.storage.status !== 'STORED' || !asset.storage.path) {
    res.status(409).json({ error: 'Asset has not been archived to local storage yet. Call archive_asset first.' });
    return null;
  }

  let fullPath;
  try {
    fullPath = assetStorage.resolveStoredPath(asset.storage.path);
  } catch {
    res.status(500).json({ error: 'Stored asset path is invalid.' });
    return null;
  }
  if (!fs.existsSync(fullPath)) {
    res.status(500).json({ error: 'Archived file is missing from storage. Try archiving again.' });
    return null;
  }

  return { asset, fullPath };
}

// Streams a file to the response, with basic single-range support (Part 8:
// "support range requests if practical" — this covers the common single
// `bytes=start-end` case a <video> element sends; it does not support
// multi-range requests, which is a documented limitation, not an oversight).
function streamFile(req, res, fullPath, { contentType, disposition }) {
  const stat = fs.statSync(fullPath);
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  if (disposition) res.setHeader('Content-Disposition', disposition);

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match && match[1] ? parseInt(match[1], 10) : 0;
  const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(fullPath, { start, end }).pipe(res);
}

// Download: forces the browser to save the file, using a filename built
// only from the asset id and its (already-whitelisted) extension — never
// from user input or the internal filesystem path.
app.get('/assets/:assetId/download', (req, res) => {
  const found = requireStoredAsset(req, res);
  if (!found) return;
  const { asset, fullPath } = found;

  const ext = path.extname(asset.storage.path);
  streamFile(req, res, fullPath, {
    contentType: asset.storage.contentType || 'application/octet-stream',
    disposition: `attachment; filename="${asset.assetId}${ext}"`,
  });
});

// Preview: same stream, but without Content-Disposition, so a browser
// <video>/<img> tag can play/render it inline.
app.get('/assets/:assetId/preview', (req, res) => {
  const found = requireStoredAsset(req, res);
  if (!found) return;
  const { asset, fullPath } = found;

  streamFile(req, res, fullPath, {
    contentType: asset.storage.contentType || 'video/mp4',
  });
});

// ================= Stage 22B-Part-1 — Generation Model Capability Registry =================
// Every route below is a thin wrapper over services/generation-model-registry.js
// — no registry logic lives here. Every one is read-only: nothing below
// generates, submits, approves, or spends a credit. See
// docs/architecture/generation-model-registry.md.

app.get('/generation-models', (req, res) => {
  const { provider, modality, productionReadyOnly, verificationStatus } = req.query;
  res.json(
    generationModelRegistry.listModels({
      provider: provider || undefined,
      modality: modality || undefined,
      productionReadyOnly: productionReadyOnly === 'true' ? true : undefined,
      verificationStatus: verificationStatus || undefined,
    })
  );
});

app.get('/generation-models/:provider/:model', (req, res) => {
  const entry = generationModelRegistry.getModel(req.params.provider, req.params.model);
  if (!entry) return res.status(404).json({ error: 'No matching model in the registry' });
  res.json(entry);
});

app.post('/generation-models/search', (req, res) => {
  const { requirements, sortByPrice } = req.body || {};
  const results = sortByPrice
    ? generationModelRegistry.cheapestSatisfying(requirements || {})
    : generationModelRegistry.findModelsSatisfying(requirements || {});
  res.json(results);
});

app.post('/generation-models/validate', (req, res) => {
  const { provider, model, requirements } = req.body || {};
  if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
  res.json(generationModelRegistry.validateModelSelection({ provider, model, requirements: requirements || {} }));
});

// If a client sends broken JSON (e.g. a typo'd request body), express.json()
// throws an error. Without this handler, Express would send back a wall of
// HTML. This catches that specific error and returns a clean JSON message
// instead.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  next(err);
});

// Only start listening when this file is run directly (e.g. `node index.js`
// or `npm start`). When tests import this file to test the routes, they
// start the server themselves on a random free port, so we skip it here.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
