#!/usr/bin/env node
// server.js — entry point for the EvoLink Video Factory MCP server.
//
// This process speaks the Model Context Protocol over stdio, so an MCP
// client (like Claude Code) can launch it and call its tools directly.
//
// This file is intentionally thin: it only wires tool registrations onto
// an McpServer. All real work happens in the existing backend services
// (../services/*, ../schemas/*) — see docs/architecture/mcp.md. No tool
// registered here calls EvoLink, makes a generation request, or bypasses
// the approval/budget gate.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const registerProjectTools = require('./tools/project-tools');
const registerSceneTools = require('./tools/scene-tools');
const registerShotTools = require('./tools/shot-tools');
const registerAssetTools = require('./tools/asset-tools');
const registerApprovalTools = require('./tools/approval-tools');
const registerGenerationTools = require('./tools/generation-tools');
const registerHistoryTools = require('./tools/history-tools');
const registerCreativeTools = require('./tools/creative-tools');
const registerSkillOrchestrationTools = require('./tools/skill-orchestration-tools');
const registerKeyframeTools = require('./tools/keyframe-tools');
const registerKeyframePromptTools = require('./tools/keyframe-prompt-tools');
const registerKeyframeGenerationTools = require('./tools/keyframe-generation-tools');
const registerKeyframeExecutionTools = require('./tools/keyframe-execution-tools');
const registerKeyframeHandoffTools = require('./tools/keyframe-handoff-tools');

function createServer() {
  const server = new McpServer({
    name: 'evolink-video-factory',
    version: '0.1.0',
  });

  registerProjectTools(server);
  registerSceneTools(server);
  registerShotTools(server);
  registerAssetTools(server);
  registerApprovalTools(server);
  registerGenerationTools(server);
  registerHistoryTools(server);
  registerCreativeTools(server);
  registerSkillOrchestrationTools(server);
  registerKeyframeTools(server);
  registerKeyframePromptTools(server);
  registerKeyframeGenerationTools(server);
  registerKeyframeExecutionTools(server);
  registerKeyframeHandoffTools(server);

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}

module.exports = { createServer };
