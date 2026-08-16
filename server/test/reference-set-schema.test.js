// Tests for schemas/reference-set-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/reference-set-schema');

test('1. createReferenceSet defaults to an empty-but-valid ACTIVE set with no members', () => {
  const set = schema.createReferenceSet();
  assert.match(set.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(set.members, []);
  assert.equal(set.status, 'ACTIVE');
});

test('2. createReferenceSetMember defaults to PENDING curation, no label', () => {
  const member = schema.createReferenceSetMember({ referenceVideoId: 'rv1' });
  assert.equal(member.curationStatus, 'PENDING');
  assert.equal(member.label, null);
  assert.ok(member.addedAt);
});

test('3. MEMBER_CURATION_STATUSES is exactly PENDING/APPROVED/REJECTED', () => {
  assert.deepEqual(schema.MEMBER_CURATION_STATUSES.slice().sort(), ['APPROVED', 'PENDING', 'REJECTED'].sort());
});

test('4. createReferenceSet nests members through createReferenceSetMember', () => {
  const set = schema.createReferenceSet({ members: [{ referenceVideoId: 'rv1' }] });
  assert.equal(set.members.length, 1);
  assert.equal(set.members[0].curationStatus, 'PENDING');
});

test('5. createReferenceSet never mutates a nested members array passed in', () => {
  const membersInput = [{ referenceVideoId: 'rv1', label: 'x' }];
  const set = schema.createReferenceSet({ members: membersInput });
  set.members[0].label = 'CORRUPTED';
  assert.equal(membersInput[0].label, 'x');
});

test('6. createReferenceSet has no field capable of storing a video binary, transcript, or measurement — membership is by id reference only', () => {
  const set = schema.createReferenceSet({ members: [{ referenceVideoId: 'rv1' }] });
  const memberKeys = Object.keys(set.members[0]);
  assert.deepEqual(memberKeys.sort(), ['referenceVideoId', 'addedAt', 'addedBy', 'curationStatus', 'label', 'curatedBy', 'curatedAt'].sort());
});
