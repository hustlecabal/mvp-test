// respond.js
//
// A tiny shared helper so every tool formats its result the same way: MCP
// tool results are a list of "content" blocks, and for our purposes that's
// always one block of pretty-printed JSON text.

function jsonResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

module.exports = { jsonResult };
