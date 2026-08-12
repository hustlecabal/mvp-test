// Tests for the MCP server (server/mcp/server.js), using a REAL MCP
// client talking to a REAL spawned server process over stdio — the same
// way Claude Code would. This is deliberately end-to-end rather than
// calling tool handlers directly, so it also proves the server starts up
// and its tools are discoverable.
//
// TEST DATA SAFETY: the spawned server is given PROJECT_DATA_DIR pointing
// at a fresh temporary folder (never server/data/projects), so nothing
// here can ever touch real project data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-mcp-test-'));

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: tempDir },
  });
  client = new Client({ name: 'evolink-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function createTestProject(overrides = {}) {
  const result = await call('create_project', { title: 'Test Project', topic: 'Test topic', ...overrides });
  return textOf(result);
}

test('a real MCP client can discover all 76 tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  // Stage 8.1 added get_project_budget. Stage 9A added archive_asset and
  // get_asset_download. Stage 9B added list_generation_history and
  // get_shot_history. Stage 11A added the 10 creative-planning tools.
  // Stage 11B added the 3 read-only skill-orchestration discovery tools
  // (see docs/architecture/skill-orchestration.md). Stage 12 added the 7
  // Keyframe Intelligence tools (see
  // docs/architecture/keyframe-intelligence.md). Stage 13A added the 3
  // Keyframe Prompt Packaging tools (see
  // docs/architecture/keyframe-prompt-packaging.md). Stage 13B added the 9
  // Controlled Keyframe Generation tools (see
  // docs/architecture/keyframe-generation.md). Stage 13C added the 2
  // read-only/fixture-only execution-bridge tools (see
  // docs/architecture/keyframe-execution-bridge.md). Stage 13D added the 4
  // Human Keyframe Execution Handoff tools — create/get/list/cancel only;
  // there is deliberately no execute/run/generate tool for a handoff.
  // Stage 13E added select_canonical_keyframe_asset/
  // get_canonical_keyframe_asset (Part 1) and acknowledge_budget_overage
  // (Part 5). Stage 14 added the 3 read-only Operator Queue tools
  // (get_operator_queue, get_operator_queue_summary,
  // get_next_operator_action — see docs/architecture/operator-queue.md).
  // Stage 19 added the 7 Reference Library / Identity Lock / Identity
  // Consistency Review tools (list_reference_library, get_identity_lock,
  // add_entity_reference_asset, select_canonical_reference_asset,
  // get_canonical_reference_asset, record_identity_consistency_review,
  // list_identity_consistency_reviews).
  // Everything else is unchanged.
  assert.equal(names.length, 76);
  assert.deepEqual(names, [
    'acknowledge_budget_overage',
    'add_entity_reference_asset',
    'analyze_shot_keyframes',
    'approve_generated_keyframe',
    'approve_keyframe_generation',
    'archive_asset',
    'build_keyframe_prompt_package',
    'cancel_keyframe_handoff',
    'create_keyframe',
    'create_keyframe_handoff',
    'create_project',
    'create_scene',
    'create_shot',
    'create_storyboard_scene',
    'create_storyboard_shot',
    'estimate_generation',
    'generate_keyframe',
    'get_approval_status',
    'get_asset',
    'get_asset_download',
    'get_canonical_keyframe_asset',
    'get_canonical_reference_asset',
    'get_creative_brief',
    'get_creative_skill',
    'get_generation_status',
    'get_identity_lock',
    'get_keyframe',
    'get_keyframe_generation_approval',
    'get_keyframe_generation_status',
    'get_keyframe_handoff',
    'get_keyframe_plan',
    'get_keyframe_prompt_package',
    'get_master_creative_spec',
    'get_next_operator_action',
    'get_operator_queue',
    'get_operator_queue_summary',
    'get_project',
    'get_project_budget',
    'get_project_status',
    'get_shot',
    'get_shot_history',
    'get_skill_compatibility',
    'get_storyboard',
    'get_visual_bible',
    'list_assets',
    'list_creative_skills',
    'list_generation_history',
    'list_identity_consistency_reviews',
    'list_keyframe_generations',
    'list_keyframe_handoffs',
    'list_keyframe_prompt_packages',
    'list_keyframes',
    'list_projects',
    'list_reference_library',
    'list_scenes',
    'list_shots',
    'poll_generation',
    'prepare_keyframe_execution',
    'record_approval_decision',
    'record_identity_consistency_review',
    'reject_generated_keyframe',
    'reject_keyframe_generation',
    'request_generation',
    'request_generation_approval',
    'request_keyframe_generation_approval',
    'run_fixture_keyframe_execution',
    'select_canonical_keyframe_asset',
    'select_canonical_reference_asset',
    'transition_project',
    'update_creative_brief',
    'update_keyframe',
    'update_keyframe_plan',
    'update_master_creative_spec',
    'update_project',
    'update_storyboard',
    'update_visual_bible',
  ]);
});

test('safety boundary: no generation or raw-access tools exist', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const forbidden = [
    'call_evolink',
    'raw_api_request',
    'execute_generation',
    'arbitrary_http_request',
    'generate_video',
    'generate_image',
    'execute_skill',
    'submit_generation',
    // Stage 13B, Part 16 — generate_keyframe itself is a legitimate,
    // safety-gated tool (see keyframe-generation-tools.test.js); these are
    // the ones that would let a caller bypass its checks.
    'raw_image_request',
    'raw_http_request',
    'bypass_budget',
    'force_generate',
    // Stage 13D, Part 4 — the handoff is intentionally human-controlled;
    // none of these programmatic-execution tools exist.
    'execute_handoff',
    'run_handoff',
    'run_skill',
    'generate_from_handoff',
    // Stage 14, Part 7 — the Operator Queue is an information/control
    // surface only, never an automation engine.
    'execute_queue',
    'run_queue',
    'generate_queue',
    'auto_process_queue',
    'batch_generate',
  ];
  for (const name of forbidden) {
    assert.ok(!names.includes(name), `${name} must not exist as an MCP tool`);
  }
});

test('1. create_project creates a project with expected fields', async () => {
  const project = textOf(
    await call('create_project', {
      title: 'Nokia Story',
      topic: 'Why Nokia lost the smartphone war',
      audience: 'tech enthusiasts',
    })
  );

  assert.ok(project.id);
  assert.equal(project.title, 'Nokia Story');
  assert.equal(project.audience, 'tech enthusiasts');
  assert.equal(project.status, 'PLANNING');
});

test('2. get_project retrieves a project by id', async () => {
  const created = await createTestProject({ title: 'Fetch me' });
  const fetched = textOf(await call('get_project', { projectId: created.id }));

  assert.equal(fetched.id, created.id);
  assert.equal(fetched.title, 'Fetch me');
});

test('get_project reports a clear error for an unknown id', async () => {
  const result = await call('get_project', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('3. list_projects returns a concise summary, not full project bodies', async () => {
  await createTestProject({ title: 'List test' });
  const list = textOf(await call('list_projects'));

  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  const entry = list[0];
  assert.ok('id' in entry && 'title' in entry && 'topic' in entry && 'status' in entry);
  assert.ok('createdAt' in entry && 'updatedAt' in entry);
  assert.ok(!('script' in entry), 'list_projects should stay concise, not return full project bodies');
});

test('4. update_project updates only safe fields, never status', async () => {
  const created = await createTestProject({ title: 'Before' });
  const updated = textOf(
    await call('update_project', { projectId: created.id, title: 'After', tone: 'nostalgic' })
  );

  assert.equal(updated.title, 'After');
  assert.equal(updated.tone, 'nostalgic');
  assert.equal(updated.status, 'PLANNING', 'update_project must not be able to change status');
});

test('5. get_project_status returns a beginner-friendly summary', async () => {
  const created = await createTestProject();
  const status = textOf(await call('get_project_status', { projectId: created.id }));

  assert.equal(status.currentState, 'PLANNING');
  assert.ok(status.whatThisMeans.length > 0);
  assert.deepEqual(status.nextAllowedStates, ['RESEARCH']);
  assert.equal(status.approvalRequired, false);
  assert.equal(status.generationCurrentlyAllowed, false);
});

test('6. transition_project performs and persists a valid state transition', async () => {
  const created = await createTestProject();
  const result = textOf(await call('transition_project', { projectId: created.id, targetState: 'RESEARCH' }));

  assert.equal(result.ok, true);
  assert.equal(result.project.status, 'RESEARCH');

  const refetched = textOf(await call('get_project', { projectId: created.id }));
  assert.equal(refetched.status, 'RESEARCH', 'the transition must actually be saved to disk');
});

test('7. transition_project rejects an invalid transition with a clear reason', async () => {
  const created = await createTestProject();
  const result = textOf(await call('transition_project', { projectId: created.id, targetState: 'SCRIPTING' }));

  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
  assert.equal(result.currentState, 'PLANNING', 'status must be unchanged after a rejected transition');
});

test('8. create_scene adds a scene using the existing Production IR structure', async () => {
  const created = await createTestProject();
  const scene = textOf(
    await call('create_scene', { projectId: created.id, title: 'Opening', description: 'The intro scene' })
  );

  assert.ok(scene.sceneId);
  assert.equal(scene.title, 'Opening');

  const scenes = textOf(await call('list_scenes', { projectId: created.id }));
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].sceneId, scene.sceneId);
});

test('9. create_shot associates a shot with the correct project and scene', async () => {
  const created = await createTestProject();
  const scene = textOf(await call('create_scene', { projectId: created.id, title: 'S1', description: 'd' }));
  const shot = textOf(
    await call('create_shot', {
      projectId: created.id,
      sceneId: scene.sceneId,
      narrativePurpose: 'establish the setting',
    })
  );

  assert.ok(shot.shotId);
  assert.equal(shot.sceneId, scene.sceneId);
  assert.equal(shot.narrativePurpose, 'establish the setting');
});

test('create_shot rejects a sceneId that does not belong to the project', async () => {
  const created = await createTestProject();
  const result = await call('create_shot', { projectId: created.id, sceneId: 'not-a-real-scene' });
  assert.equal(result.isError, true);
});

test('10. list_shots returns all shots, filterable by scene', async () => {
  const created = await createTestProject();
  const sceneA = textOf(await call('create_scene', { projectId: created.id, title: 'A', description: 'd' }));
  const sceneB = textOf(await call('create_scene', { projectId: created.id, title: 'B', description: 'd' }));
  await call('create_shot', { projectId: created.id, sceneId: sceneA.sceneId });
  await call('create_shot', { projectId: created.id, sceneId: sceneB.sceneId });

  const all = textOf(await call('list_shots', { projectId: created.id }));
  assert.equal(all.length, 2);

  const onlyA = textOf(await call('list_shots', { projectId: created.id, sceneId: sceneA.sceneId }));
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].sceneId, sceneA.sceneId);
});

test('11. list_assets returns an empty list without error (nothing generates yet)', async () => {
  const created = await createTestProject();
  const assets = textOf(await call('list_assets', { projectId: created.id }));
  assert.deepEqual(assets, []);
});

test('12. get_approval_status reports the gate state from the existing gate service', async () => {
  const created = await createTestProject();
  const status = textOf(await call('get_approval_status', { projectId: created.id }));

  assert.equal(status.approvalStatus, 'NONE');
  assert.equal(status.generationAllowed, false);
});

test('13. request_generation_approval requests approval without generating anything', async () => {
  const created = await createTestProject();
  const approvals = textOf(
    await call('request_generation_approval', { projectId: created.id, estimatedCost: 25, note: 'first batch' })
  );

  assert.equal(approvals.status, 'PENDING');
  assert.equal(approvals.estimatedCost, 25);

  const status = textOf(await call('get_approval_status', { projectId: created.id }));
  assert.equal(status.generationAllowed, false, 'requesting approval must not itself grant it');
});

test('14. record_approval_decision approves a pending request via the existing gate service', async () => {
  const created = await createTestProject();
  await call('request_generation_approval', { projectId: created.id, estimatedCost: 10 });
  const decision = textOf(
    await call('record_approval_decision', { projectId: created.id, approve: true, decidedBy: 'Opeyemi' })
  );

  assert.equal(decision.ok, true);
  assert.equal(decision.approvals.status, 'APPROVED');

  const status = textOf(await call('get_approval_status', { projectId: created.id }));
  assert.equal(status.generationAllowed, true);
});

test('record_approval_decision reports a clear failure when nothing is pending', async () => {
  const created = await createTestProject();
  const decision = textOf(await call('record_approval_decision', { projectId: created.id, approve: true }));
  assert.equal(decision.ok, false);
});

test('get_project_budget (Stage 8.1) reports the full ledger without submitting anything', async () => {
  const created = await createTestProject();
  await call('request_generation_approval', { projectId: created.id, estimatedCost: 30 });
  await call('record_approval_decision', { projectId: created.id, approve: true });

  const budget = textOf(await call('get_project_budget', { projectId: created.id }));

  assert.equal(budget.budgetLimit, null, 'no budget was set for this project');
  assert.equal(budget.estimatedAllocations, 30);
  assert.equal(budget.reservedCredits, 0);
  assert.equal(budget.spentCredits, null, 'unknown actual cost must stay null, never 0');
  assert.equal(budget.overageAmount, null);
  assert.equal(budget.blocked, false);
  assert.equal(budget.generationAllowed, true);
});

test('a full MCP-driven walk reaches CALIBRATION only after approval', async () => {
  const created = await createTestProject();

  // Blocked before approval
  const blocked = textOf(
    await (async () => {
      for (const state of [
        'RESEARCH',
        'CREATIVE_REVIEW',
        'SCRIPTING',
        'SCRIPT_REVIEW',
        'VISUAL_DEVELOPMENT',
        'VISUAL_REVIEW',
        'STORYBOARD',
        'GENERATION_REVIEW',
      ]) {
        await call('transition_project', { projectId: created.id, targetState: state });
      }
      return call('transition_project', { projectId: created.id, targetState: 'CALIBRATION' });
    })()
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /gate/i);

  // Approve, then it opens
  await call('request_generation_approval', { projectId: created.id, estimatedCost: 20 });
  await call('record_approval_decision', { projectId: created.id, approve: true });

  const allowed = textOf(await call('transition_project', { projectId: created.id, targetState: 'CALIBRATION' }));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.project.status, 'CALIBRATION');
});
