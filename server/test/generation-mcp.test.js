// Tests for the 4 new generation MCP tools, using a REAL spawned server
// process over stdio, the same way Stage 5's mcp.test.js tests the rest.
//
// Provider calls can't be mocked across a process boundary, so this file
// covers what's genuinely testable at the MCP layer without a real
// EvoLink call: safety checks blocking a submission (proving
// request_generation truly delegates to generation-service.js and
// doesn't reach a provider), reading an existing job, and polling a job
// that's already finished (proving poll_generation delegates to
// generation-poller.js without needing a live provider call). The
// provider-call paths themselves (successful submission, status mapping,
// asset creation, poll timeout) are already fully tested with mocked
// providers in generation-service.test.js and generation-poller.test.js.
//
// TEST DATA SAFETY: PROJECT_DATA_DIR and GENERATION_JOBS_DATA_DIR both
// point at fresh temporary folders, shared between this test process and
// the spawned server (same paths, same filesystem) -- never
// server/data/projects or server/data/generation-jobs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-mcp-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-mcp-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

// Used only to set up fixture data on disk for the spawned server to read
// -- not used to call generation-service.js directly (that would defeat
// the point of testing through the real MCP layer).
const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const generationStore = require('../services/generation-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: projectTempDir, GENERATION_JOBS_DATA_DIR: jobsTempDir },
  });
  client = new Client({ name: 'evolink-gen-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fs.rmSync(projectTempDir, { recursive: true, force: true });
  fs.rmSync(jobsTempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

test('the 4 generation tools are discoverable alongside the rest (Stage 8.1 + 9A + 9B + 11A + 11B + 12 + 13A + 13B + 13C + 13D + 13E + 14 additions included)', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('estimate_generation'));
  assert.ok(names.includes('request_generation'));
  assert.ok(names.includes('get_generation_status'));
  assert.ok(names.includes('poll_generation'));
  // Stage 22B-Part-1 added 2 more read-only tools (list_generation_models,
  // find_generation_models) — see docs/architecture/generation-model-registry.md.
  // Stage 22B-Part-2 added 3 more (build_video_prompt_package,
  // get_video_prompt_package, list_video_prompt_packages) — see
  // docs/architecture/video-prompt-package.md.
  // Stage 22B-Part-3 added 7 more (request_video_generation_approval,
  // get_video_generation_approval, approve_video_generation,
  // reject_video_generation, can_generate_video, generate_video,
  // get_video_generation_status) — see
  // docs/architecture/video-generation-lifecycle.md.
  // Stage 23 added 3 more (acknowledge_video_unknown_cost,
  // approve_generated_video, reject_generated_video).
  // P0 Hardening (finding J) added 1 more (set_project_budget) — the
  // primary agent-facing interface previously had no way to establish a
  // spend ceiling at all.
  assert.equal(names.length, 92);
});

test('estimate_generation reports allowed:false for a nonexistent project, without submitting anything', async () => {
  const result = textOf(
    await call('estimate_generation', {
      projectId: '00000000-0000-0000-0000-000000000000',
      shotId: '11111111-1111-1111-1111-111111111111',
      provider: 'evolink',
      model: 'seedance-2.5-text-to-video',
      task: 'text-to-video',
      prompt: 'x',
    })
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /No project found/);
});

test('21. request_generation uses generation-service.js -- the same safety-check reasons come back through MCP', async () => {
  const result = textOf(
    await call('request_generation', {
      projectId: '00000000-0000-0000-0000-000000000000',
      shotId: '11111111-1111-1111-1111-111111111111',
      provider: 'evolink',
      model: 'seedance-2.5-text-to-video',
      task: 'text-to-video',
      prompt: 'x',
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /No project found/);
});

test('request_generation blocks a real project that is in the wrong state, via MCP', async () => {
  const project = projectStore.createProject({ title: 'MCP gen test', topic: 'x' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId });

  const result = textOf(
    await call('request_generation', {
      projectId: project.id,
      shotId: shot.shotId,
      provider: 'evolink',
      model: 'seedance-2.5-text-to-video',
      task: 'text-to-video',
      prompt: 'x',
    })
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /not a generation state/);
});

test('22. get_generation_status returns a job created directly on disk (shared with the spawned server)', async () => {
  const job = generationStore.createGenerationJob({
    projectId: 'proj-x',
    shotId: 'shot-x',
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'x',
    status: 'PROCESSING',
    progress: 42,
    reservedCost: 10,
  });

  const result = textOf(await call('get_generation_status', { generationId: job.id }));

  assert.equal(result.id, job.id);
  assert.equal(result.status, 'PROCESSING');
  assert.equal(result.progress, 42);
  assert.equal(result.reservedCost, 10);
});

test('get_generation_status reports a clear error for an unknown id', async () => {
  const result = await call('get_generation_status', { generationId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('23. poll_generation delegates to generation-poller.js -- polling an already-finished job is a no-op', async () => {
  const job = generationStore.createGenerationJob({
    projectId: 'proj-y',
    shotId: 'shot-y',
    provider: 'evolink',
    status: 'COMPLETED',
  });

  const result = textOf(await call('poll_generation', { generationId: job.id }));

  assert.equal(result.ok, true);
  assert.equal(result.polled, false);
  assert.equal(result.job.status, 'COMPLETED');
});

test('poll_generation reports a clear error for an unknown id', async () => {
  const result = textOf(await call('poll_generation', { generationId: '00000000-0000-0000-0000-000000000000' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /No generation job found/);
});
