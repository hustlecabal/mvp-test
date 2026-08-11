const express = require('express');
const projectStore = require('./services/project-store');

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
