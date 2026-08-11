// project-store.js
//
// This is the ONLY file that reads or writes project JSON files on disk.
// Everything else (like index.js) asks these functions to do the work,
// instead of touching the filesystem directly. That keeps file-handling
// logic in one place, so it's easier to keep safe and easier to test.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Where project files live. Can be overridden with an environment
// variable so tests can point this at a temporary, throwaway folder
// instead of the real data/projects folder.
const PROJECTS_DIR = process.env.PROJECT_DATA_DIR
  ? path.resolve(process.env.PROJECT_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'projects');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// Project ids are generated with crypto.randomUUID(), which always looks
// like "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (hex characters and dashes
// only). Checking incoming ids against this pattern before touching the
// filesystem stops someone from passing something like "../../secrets" as
// an id and reading/writing files outside the projects folder.
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function projectFilePath(id) {
  return path.join(PROJECTS_DIR, `${id}.json`);
}

function blankProject({ title, topic }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: title || '',
    topic: topic || '',
    status: 'PLANNING',
    createdAt: now,
    updatedAt: now,
    creativeDirection: {},
    research: {},
    story: {},
    script: {},
    visualBible: {},
    characters: [],
    locations: [],
    shots: [],
    assets: [],
    generations: [],
    approvals: {},
    creditLedger: {},
  };
}

function saveProject(project) {
  fs.writeFileSync(projectFilePath(project.id), JSON.stringify(project, null, 2));
}

function createProject({ title, topic } = {}) {
  const project = blankProject({ title, topic });
  saveProject(project);
  return project;
}

function getProject(id) {
  if (!isValidId(id)) return null;
  const filePath = projectFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listProjects() {
  const files = fs.readdirSync(PROJECTS_DIR).filter((name) => name.endsWith('.json'));
  const projects = files.map((file) =>
    JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, file), 'utf8'))
  );
  return projects.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Only these fields can be changed through updateProject. Everything else
// (like id, createdAt, or the arrays for shots/characters/etc.) is left
// alone at this stage — later stages will add their own focused update
// paths for those.
const UPDATABLE_FIELDS = ['title', 'topic', 'status'];

function updateProject(id, updates = {}) {
  const project = getProject(id);
  if (!project) return null;

  for (const field of UPDATABLE_FIELDS) {
    if (updates[field] !== undefined) {
      project[field] = updates[field];
    }
  }
  project.updatedAt = new Date().toISOString();

  saveProject(project);
  return project;
}

module.exports = {
  createProject,
  getProject,
  listProjects,
  updateProject,
  isValidId,
  PROJECTS_DIR,
};
