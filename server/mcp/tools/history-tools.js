// history-tools.js — Stage 9B read-only MCP tools for generation history
// and per-shot history. All real work happens in
// services/generation-history-service.js; nothing here can trigger a
// generation, and nothing here is a write operation.

const { z } = require('zod');
const historyService = require('../../services/generation-history-service');
const { jsonResult } = require('../lib/respond');

function register(server) {
  server.registerTool(
    'list_generation_history',
    {
      title: "List a project's full generation history",
      description:
        'Returns every generation attempt ever made for a project (never filtered out or overwritten), each ' +
        'combined with its resulting asset info (type, storage status, preview/download URLs) and known cost. ' +
        'Also returns totals: count by status, total reserved credits (where any is known), and how many ' +
        'attempts produced an asset. Read-only — never triggers a generation.',
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => {
      const records = historyService.listGenerationHistory(projectId);
      if (records === null) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(historyService.summarizeGenerationHistory(records));
    }
  );

  server.registerTool(
    'get_shot_history',
    {
      title: 'Get every generation attempt made for one shot',
      description:
        'Returns every generation attempt for a single shot, oldest attempts included (a shot may have a bad ' +
        'first take, a better second take, and an approved third take — none of them are ever deleted or ' +
        'overwritten). Read-only — never triggers a generation.',
      inputSchema: {
        shotId: z.string(),
      },
    },
    async ({ shotId }) => {
      const records = historyService.listShotHistory(shotId);
      if (records === null) {
        throw new Error(`No shot found with id "${shotId}"`);
      }
      return jsonResult({ shotId, generations: records, totalCount: records.length });
    }
  );
}

module.exports = register;
