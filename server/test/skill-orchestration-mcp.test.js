// Tests for the Stage 11B skill-orchestration MCP tools
// (list_creative_skills, get_creative_skill, get_skill_compatibility),
// using a real spawned MCP server process over stdio — same pattern as
// the other MCP test files. All three tools are read-only; no real skill
// is ever invoked and no generation job is ever created.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-skill-mcp-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-skill-mcp-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

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
  client = new Client({ name: 'evolink-skill-mcp-test-client', version: '0.1.0' });
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

test('list_creative_skills returns all 8 registry entries through MCP', async () => {
  const skills = textOf(await call('list_creative_skills'));
  assert.equal(skills.length, 8);
  assert.ok(skills.some((s) => s.id === 'video-prompt-builder'));
  assert.ok(skills.some((s) => s.id === 'cinema-worldbuilder-pro-2.0'));
});

test('get_creative_skill returns one skill by id through MCP', async () => {
  const skill = textOf(await call('get_creative_skill', { skillId: 'video-prompt-builder' }));
  assert.equal(skill.role, 'SPECIALIST');
  assert.equal(skill.generationRisk, 'NONE');
});

test('get_creative_skill reports a clear error for an unknown skill', async () => {
  const result = await call('get_creative_skill', { skillId: 'not-a-real-skill' });
  assert.equal(result.isError, true);
});

test('get_skill_compatibility reports platform coupling and adapter availability through MCP', async () => {
  const result = textOf(await call('get_skill_compatibility', { skillId: 'cinema-worldbuilder-pro-2.0', platform: 'evolink' }));
  assert.equal(result.platformCoupling, 'HIGGSFIELD');
  assert.equal(result.hasAdapter, true);
});

test('get_skill_compatibility reports a clear error for an unknown skill', async () => {
  const result = await call('get_skill_compatibility', { skillId: 'not-a-real-skill' });
  assert.equal(result.isError, true);
});

test('no execute_skill tool exists yet', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.includes('execute_skill'), false);
  assert.equal(names.includes('run_skill'), false);
});

test('none of the 3 skill-orchestration MCP calls ever create a generation job', async () => {
  const before = generationStore.listGenerationJobs().length;

  await call('list_creative_skills');
  await call('get_creative_skill', { skillId: 'video-prompt-builder' });
  await call('get_skill_compatibility', { skillId: 'video-prompt-builder', platform: 'evolink' });

  assert.equal(generationStore.listGenerationJobs().length, before);
});
