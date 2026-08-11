# MCP — How Claude Code Operates the Video Factory

Code: `server/mcp/server.js` and `server/mcp/tools/*.js`.
Config: `.mcp.json` (project root).

## What MCP is, in plain English

MCP stands for **Model Context Protocol**. It's a standard way for an AI
assistant (like Claude Code) to discover and call a fixed set of named
"tools" that a program exposes — a bit like a restaurant menu: the AI
doesn't get to walk into the kitchen and do whatever it wants, it can only
order from the specific dishes listed on the menu, each with clearly
defined ingredients (inputs) and a description of what it does.

An MCP **server** is the program that publishes the menu and cooks the
dishes when ordered. An MCP **client** (Claude Code, in our case) reads the
menu and places orders. They talk to each other over "stdio" — the
server's standard input/output streams — which is the simplest possible
connection: no network ports, no accounts, nothing to expose to the
internet.

## Why we use it here

Without MCP, the only way for Claude Code to "operate" this project would
be by directly editing files or running arbitrary shell commands — which
is powerful, but has no guardrails. MCP lets us hand Claude Code a
specific, deliberately limited set of actions: create a project, check its
status, request approval, and so on — nothing more. Every tool call is
visible, named, and constrained to exactly what its description says it
does.

## Tools that currently exist (Stage 5)

All 16 tools are **safe project-management and planning tools**. None of
them call a generation provider or spend money.

| Tool | What it does |
|---|---|
| `create_project` | Creates a new project (title, topic, optional audience/tone/creativeMode). |
| `get_project` | Retrieves a full project by id. |
| `list_projects` | Lists all projects as a concise summary (not full bodies). |
| `update_project` | Updates title/topic/audience/tone/creativeMode. Cannot change `status`. |
| `get_project_status` | Beginner-friendly summary: current state, what it means, what's next, whether approval/budget currently allow generation. |
| `transition_project` | Moves a project to a new state, via the existing state machine. |
| `create_scene` | Adds a scene to a project. |
| `list_scenes` | Lists a project's scenes. |
| `create_shot` | Adds a shot to a scene. |
| `get_shot` | Retrieves one shot. |
| `list_shots` | Lists a project's shots, optionally filtered to one scene. |
| `list_assets` | Lists asset metadata/lineage (empty until generation exists). |
| `get_asset` | Retrieves one asset's metadata. |
| `get_approval_status` | Reads the current approval/budget gate state. |
| `request_generation_approval` | Starts an approval request with an estimated cost. Does **not** generate anything. |
| `record_approval_decision` | Records a human's approve/reject decision. |

## What MCP is NOT allowed to do

By design, this stage does **not** include any tool that could spend money
or call a provider. Specifically, none of the following exist, and none
should be added without deliberately revisiting this document:

- `call_evolink`
- `raw_api_request`
- `execute_generation`
- `arbitrary_http_request`
- any tool that generates a keyframe, video, or other paid asset

A dedicated test (`server/test/mcp.test.js`) checks the live tool list for
exactly these names and fails if any of them ever appear, as a guard rail
against accidentally reintroducing them later.

## How the backend remains the source of truth

Every MCP tool handler is a **thin wrapper** — a few lines that validate
input, call an existing backend function, and format the result as JSON.
None of them contain business logic of their own:

```
Claude Code
    │  (MCP protocol, over stdio)
    ▼
MCP tool  (server/mcp/tools/*.js)
    │  (a plain function call — no protocol involved)
    ▼
Existing backend service
    (services/project-store.js, services/approval-gate.js,
     services/timeline-store.js, schemas/state-machine.js)
    │
    ▼
Project JSON file on disk
```

For example, `transition_project` does not know the rules for which state
can move to which — it calls `schemas/state-machine.js`'s `transition()`
function, the exact same function `server/test/state-machine.test.js`
already tests directly. If those rules ever change, they only need to
change in one place, and every consumer (MCP, and eventually the HTTP API
and frontend) picks up the change automatically.

The one new piece of backend code this stage added is
`services/timeline-store.js`, which gives scenes/shots/assets the same
kind of create/read/list operations projects already had — this lives in
the backend, not in MCP, so it's reusable by anything else later (an HTTP
endpoint, the frontend, etc.), not just MCP.

## How future generation tools will work

Generation is deliberately **out of scope** for this stage. When it is
built (a later stage, not yet started), the same layering will apply — a
generation tool will still be thin, and will still be required to route
through the existing checkpoints rather than skip them:

```
MCP tool (e.g. a future "generate_keyframe")
    ↓
Existing backend service
    ↓
schemas/state-machine.js   — is the project in a generation state?
    ↓
services/approval-gate.js  — has a human approved this, and is it in budget?
    ↓
A generation service (not built yet) — turns a generation request
  (schemas/production-schema.js's createGenerationRequest shape) into an
  actual call to a provider (EvoLink, or something else)
    ↓
The provider
```

No EvoLink integration, API key, or generation call exists anywhere in
this codebase yet. When it's added, it will be a new provider
implementation behind the existing provider-agnostic generation request
shape from Stage 4 — the Creative IR, Timeline IR, state machine, and MCP
tools built so far won't need to change to support it.
