const express = require('express');
const projectStore = require('./services/project-store');
const gate = require('./services/approval-gate');

const app = express();
const PORT = process.env.PORT || 3000;

// Lets Express read a JSON body (e.g. { "title": "..." }) sent by a client
// and turn it into req.body for us.
app.use(express.json());

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

// Update a project's title, topic, and/or status.
app.patch('/projects/:id', (req, res) => {
  const { title, topic, status } = req.body || {};

  if (title !== undefined && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }
  if (topic !== undefined && typeof topic !== 'string') {
    return res.status(400).json({ error: 'topic must be a string' });
  }
  if (status !== undefined && typeof status !== 'string') {
    return res.status(400).json({ error: 'status must be a string' });
  }

  const updated = projectStore.updateProject(req.params.id, { title, topic, status });
  if (!updated) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(updated);
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
