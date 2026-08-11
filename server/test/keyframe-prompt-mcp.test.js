// Tests for the Stage 13A Keyframe Prompt Packaging MCP tools, using a
// real spawned MCP server process over stdio — same pattern as
// keyframe-mcp.test.js. Confirms the build/get/list tools work end-to-end
// through the real MCP layer, and that none of them can create a
// generation job or touch the approval/budget gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-mcp-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-mcp-packages-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-mcp-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: {
      PROJECT_DATA_DIR: projectTempDir,
      CREATIVE_DATA_DIR: creativeTempDir,
      KEYFRAME_DATA_DIR: keyframeTempDir,
      KEYFRAME_PROMPT_DATA_DIR: promptTempDir,
      GENERATION_JOBS_DATA_DIR: jobsTempDir,
    },
  });
  client = new Client({ name: 'evolink-kfp-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  for (const dir of [projectTempDir, creativeTempDir, keyframeTempDir, promptTempDir, jobsTempDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function createProject() {
  return projectStore.createProject({ title: 'MCP kfp test', topic: 'x' });
}

async function seedShotAndKeyframe(project, keyframeFields = {}) {
  await call('update_visual_bible', { projectId: project.id, characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId, characterReferences: ['char-1'] }));
  const keyframe = textOf(
    await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'CHARACTER_REFERENCE', ...keyframeFields })
  );
  return { scene, shot, keyframe };
}

// --- discoverability ---------------------------------------------------------------

test('all 3 keyframe prompt-packaging tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ['get_keyframe_prompt_package', 'build_keyframe_prompt_package', 'list_keyframe_prompt_packages']) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }
});

test('no generate/execute/submit-style tool exists for prompt packaging itself', async () => {
  // Stage 13B added a real (separately safety-gated) generate_keyframe
  // tool elsewhere — this file only confirms the PACKAGING tools tested
  // here never grew their own shortcut around it.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['execute_skill', 'submit_generation', 'generate_prompt_package']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- build / get / list ----------------------------------------------------------------

test('build_keyframe_prompt_package builds a package end-to-end through MCP', async () => {
  const project = createProject();
  const { keyframe } = await seedShotAndKeyframe(project);

  const built = textOf(await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.ok(built.packageId);
  assert.equal(built.keyframeId, keyframe.keyframeId);
  assert.equal(built.version, 1);
  assert.ok(built.prompt.length > 0);
  assert.equal(built.identityLock[0].characterId, 'char-1');
});

test('get_keyframe_prompt_package returns null before any build, then the built package after', async () => {
  const project = createProject();
  const { keyframe } = await seedShotAndKeyframe(project);

  assert.equal(textOf(await call('get_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId })), null);

  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  const fetched = textOf(await call('get_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(fetched.keyframeId, keyframe.keyframeId);
});

test('build_keyframe_prompt_package reports a clear error for an unknown keyframeId', async () => {
  const project = createProject();
  const result = await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: 'nope' });
  assert.equal(result.isError, true);
});

test('list_keyframe_prompt_packages lists every built package for a project', async () => {
  const project = createProject();
  const { keyframe } = await seedShotAndKeyframe(project);
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });

  const list = textOf(await call('list_keyframe_prompt_packages', { projectId: project.id }));
  assert.equal(list.length, 1);
  assert.equal(list[0].keyframeId, keyframe.keyframeId);
});

// --- safety: no keyframe-prompt MCP call ever creates a generation job -----------------

test('no keyframe-prompt-packaging MCP call ever creates a generation job', async () => {
  const project = createProject();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const { keyframe } = await seedShotAndKeyframe(project);
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('get_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('list_keyframe_prompt_packages', { projectId: project.id });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});
