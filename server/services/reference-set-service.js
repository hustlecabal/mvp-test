// reference-set-service.js
//
// INT-1E, Part 3/17 — membership management for ReferenceSets. Every
// ADD_VIDEO call validates the referenceVideoId against a REAL, existing
// schemas/reference-video-schema.js ReferenceVideo (services/reference-
// video-store.js) before it is ever added — membership is never inferred,
// never accepted on faith (Part 2/3's explicit instruction). This file
// never reads or writes a video's binary, transcript, or measurements —
// it only ever manipulates the small membership list.

const projectStore = require('./project-store');
const referenceVideoStore = require('./reference-video-store');
const referenceSetStore = require('./reference-set-store');
const { createReferenceSet, createReferenceSetMember, MEMBER_CURATION_STATUSES } = require('../schemas/reference-set-schema');

function createSet(projectId, { name, description, criteria } = {}) {
  if (!projectStore.getProject(projectId)) return { ok: false, reason: `No project found with id "${projectId}"` };
  const set = createReferenceSet({ projectId, name: name || '', description: description || '', criteria: criteria || '' });
  const saved = referenceSetStore.addReferenceSet(projectId, set);
  return saved.ok ? { ok: true, referenceSet: saved.referenceSet } : saved;
}

function getSet(projectId, referenceSetId) {
  return referenceSetStore.getReferenceSet(projectId, referenceSetId);
}

function listSets(projectId) {
  return referenceSetStore.listReferenceSets(projectId);
}

// Part 3 — ADD_VIDEO. Refuses a referenceVideoId that doesn't resolve to a
// REAL, existing ReferenceVideo in this exact project (never a different
// project's video — INT-1A's own ReferenceVideo is already project-scoped,
// and this file trusts that scoping rather than re-deriving it). Refuses a
// duplicate add (idempotent no-op on re-add, matching Part 24's spirit —
// re-adding an existing member never creates a second membership entry).
function addVideo(projectId, referenceSetId, referenceVideoId, { addedBy } = {}) {
  const set = referenceSetStore.getReferenceSet(projectId, referenceSetId);
  if (!set) return { ok: false, reason: `No ReferenceSet found with id "${referenceSetId}"` };
  const referenceVideo = referenceVideoStore.getReferenceVideo(projectId, referenceVideoId);
  if (!referenceVideo) return { ok: false, reason: `No ReferenceVideo found with id "${referenceVideoId}" in this project — refusing to add unverified membership` };
  if (set.members.some((m) => m.referenceVideoId === referenceVideoId)) {
    return { ok: true, referenceSet: set, alreadyMember: true };
  }
  set.members.push(createReferenceSetMember({ referenceVideoId, addedBy: addedBy || null }));
  const updated = referenceSetStore.updateReferenceSet(projectId, set);
  return { ok: true, referenceSet: updated };
}

// Part 3 — REMOVE_VIDEO. Never deletes the underlying ReferenceVideo — only
// this set's membership record for it.
function removeVideo(projectId, referenceSetId, referenceVideoId) {
  const set = referenceSetStore.getReferenceSet(projectId, referenceSetId);
  if (!set) return { ok: false, reason: `No ReferenceSet found with id "${referenceSetId}"` };
  const before = set.members.length;
  set.members = set.members.filter((m) => m.referenceVideoId !== referenceVideoId);
  if (set.members.length === before) return { ok: false, reason: `"${referenceVideoId}" is not a member of this ReferenceSet` };
  const updated = referenceSetStore.updateReferenceSet(projectId, set);
  return { ok: true, referenceSet: updated };
}

// Part 17 — APPROVE / REJECT / LABEL a member. Never touches the
// underlying ReferenceVideo; only this set's own membership record.
function curateVideo(projectId, referenceSetId, referenceVideoId, { curationStatus, label, curatedBy } = {}) {
  const set = referenceSetStore.getReferenceSet(projectId, referenceSetId);
  if (!set) return { ok: false, reason: `No ReferenceSet found with id "${referenceSetId}"` };
  const member = set.members.find((m) => m.referenceVideoId === referenceVideoId);
  if (!member) return { ok: false, reason: `"${referenceVideoId}" is not a member of this ReferenceSet` };
  if (curationStatus) {
    if (!MEMBER_CURATION_STATUSES.includes(curationStatus)) return { ok: false, reason: `"${curationStatus}" is not a valid curation status` };
    member.curationStatus = curationStatus;
    member.curatedBy = curatedBy || null;
    member.curatedAt = new Date().toISOString();
  }
  if (label !== undefined) member.label = label;
  const updated = referenceSetStore.updateReferenceSet(projectId, set);
  return { ok: true, referenceSet: updated };
}

module.exports = { createSet, getSet, listSets, addVideo, removeVideo, curateVideo };
