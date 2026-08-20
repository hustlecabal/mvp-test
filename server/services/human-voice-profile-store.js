// human-voice-profile-store.js
//
// CREATIVE BRAIN — persistence for HumanVoiceProfile records (schemas/
// human-voice-profile-schema.js). One JSON file per project id,
// `{ projectId, profiles: [] }` — the exact same convention as services/
// reference-video-store.js (its own header is the direct precedent).

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const HUMAN_VOICE_PROFILE_DATA_DIR = process.env.HUMAN_VOICE_PROFILE_DATA_DIR
  ? path.resolve(process.env.HUMAN_VOICE_PROFILE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'human-voice-profiles');

fs.mkdirSync(HUMAN_VOICE_PROFILE_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(HUMAN_VOICE_PROFILE_DATA_DIR, `${projectId}.json`);
}

function loadLibrary(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveLibrary(library) {
  fs.writeFileSync(fileFor(library.projectId), JSON.stringify(library, null, 2));
}

function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, profiles: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, profiles: [] };
}

function getHumanVoiceProfile(projectId, profileId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.profiles.find((p) => p.id === profileId) || null;
}

function listHumanVoiceProfiles(projectId) {
  const library = readLibrary(projectId);
  return library ? library.profiles.slice() : null;
}

// Idempotency lookup (mirrors reference-video-store.js's own
// findByExternalId) — the latest profile already built for a
// (projectId, platform, topic) triple, so a repeat request reuses it
// rather than re-acquiring/re-paying.
function findLatestByTopic(projectId, platform, topic) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.profiles.filter((p) => p.platform === platform && p.topic === topic);
  if (matches.length === 0) return null;
  return matches.reduce((latest, p) => (p.createdAt > latest.createdAt ? p : latest));
}

function addHumanVoiceProfile(projectId, profile) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(profile));
  library.profiles.push(stored);
  saveLibrary(library);
  return { ok: true, profile: stored };
}

module.exports = {
  HUMAN_VOICE_PROFILE_DATA_DIR,
  getHumanVoiceProfile,
  listHumanVoiceProfiles,
  findLatestByTopic,
  addHumanVoiceProfile,
};
