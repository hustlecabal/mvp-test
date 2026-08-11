// Tests for the actual HTTP endpoints in index.js, using Node's built-in
// test runner and built-in fetch (no extra test/HTTP library needed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a fresh temporary folder before index.js (and the
// project store it uses) is loaded.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-api-test-'));
process.env.PROJECT_DATA_DIR = tempDir;

const app = require('../index');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

test('GET /health still works', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('POST /projects creates a project', async () => {
  const res = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Nokia Smartphone Story',
      topic: 'Why Nokia lost the smartphone war',
    }),
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.title, 'Nokia Smartphone Story');
  assert.equal(body.status, 'PLANNING');
});

test('GET /projects lists projects', async () => {
  const res = await fetch(`${baseUrl}/projects`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
});

test('GET /projects/:id retrieves a single project', async () => {
  const createRes = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Fetch me', topic: 'x' }),
  });
  const created = await createRes.json();

  const res = await fetch(`${baseUrl}/projects/${created.id}`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.id, created.id);
  assert.equal(body.title, 'Fetch me');
});

test('GET /projects/:id returns 404 for a missing project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000`);
  assert.equal(res.status, 404);

  const body = await res.json();
  assert.equal(body.error, 'Project not found');
});

test('PATCH /projects/:id updates fields and updatedAt', async () => {
  const createRes = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Before', topic: 'x' }),
  });
  const created = await createRes.json();

  const res = await fetch(`${baseUrl}/projects/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'After', status: 'RESEARCH' }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'After');
  assert.equal(body.status, 'RESEARCH');
  assert.notEqual(body.updatedAt, created.updatedAt);
});

test('PATCH /projects/:id returns 404 for a missing project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });

  assert.equal(res.status, 404);
});

test('malformed JSON body returns a clean 400 error, not a crash', async () => {
  const res = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not valid json',
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});
