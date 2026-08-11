# Control Surfaces — MCP, REST, and Frontend

Stage 13E, Part 6. This document does not introduce anything new — it
writes down, explicitly, the division of responsibility the codebase has
followed since Stage 10 (when the REST API and frontend were first added
alongside the Stage 5 MCP server), and closes the one place (Stage 13D's
architecture audit, Part 5/17) where that division had quietly drifted.

## The six layers

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│     MCP      │   │     REST     │   │   Frontend   │
│ orchestration│   │ application  │   │human interface│
│  interface   │   │  interface   │   │              │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │  (calls REST
       │                  │                  │   over HTTP)
       └────────┬─────────┴──────────────────┘
                │  (plain function calls — no protocol)
                ▼
        ┌───────────────┐
        │    Services    │  business logic
        │ (server/services/*.js, schemas/*.js)
        └───────┬────────┘
                │
                ▼
        ┌───────────────┐
        │    Stores      │  persistence
        │ (JSON files under server/data/)
        └───────┬────────┘
                │  (only for real generation)
                ▼
        ┌───────────────┐
        │   Providers    │  external execution boundary
        │ (server/providers/*)
        └───────────────┘
```

**MCP = orchestration interface.** `server/mcp/server.js` and
`server/mcp/tools/*.js`. This is how Claude Code (or any other MCP client)
drives the system: creating projects, moving them through the state
machine, planning creative artifacts, requesting and approving
generation. See `docs/architecture/mcp.md` for the full explanation of
why MCP exists and how a tool call reaches a service.

**REST = application interface.** `server/index.js`. This is how the
browser-based frontend talks to the backend over HTTP — the same
services MCP calls, wrapped in `app.get/post/put/patch` route handlers
instead of `server.registerTool(...)` calls. REST is not a second
implementation of anything MCP already does; every route is a thin
translation from an HTTP request to the identical service call an
equivalent MCP tool would make.

**Frontend = human interface.** `frontend/index.html`, `frontend/app.js`,
`frontend/styles.css`. Plain HTML/CSS/vanilla JS, no build step, no
business rules of its own — every decision it renders (is this button
enabled, is this asset approved, is this project blocked) comes from a
field already computed and returned by a REST response. Two workspaces
exist today: **Production** (read-only project/scene/shot/generation/
budget view) and **Creative Director** (creative planning, keyframes,
prompt packages, generation, and human execution handoffs — the only
workspace with write actions).

**Services = business logic.** `server/services/*.js` (and the state
machine at `server/schemas/state-machine.js`). This is the ONLY layer
that is allowed to know a rule — what counts as a valid state transition,
whether a budget allows a generation, whether a prompt package is stale,
whether a handoff can be created. Both MCP and REST call into exactly the
same service functions; neither layer re-implements a rule the services
already enforce.

**Stores = persistence.** `server/services/*-store.js` (e.g.
`project-store.js`, `timeline-store.js`, `keyframe-store.js`,
`keyframe-handoff-service.js`'s own file I/O). Plain JSON files under
`server/data/`, one file per project (or per job, for generation jobs).
Stores know how to read and write; they do not decide whether a write is
allowed — that's the service layer's job, one level up.

**Providers = external execution boundary.** `server/providers/evolink/*`
(the one real provider, used only for video generation) and
`server/providers/fake-image/*` (a local, deterministic stand-in used
only by Stage 13B/13C's keyframe-generation testing path — see the
FIXTURE-ONLY classification in
`docs/architecture/keyframe-execution-bridge.md`). This is the only layer
allowed to make a real network call or spend a real credit. No MCP tool,
REST route, service, or store outside this layer ever does.

## The rule: no business logic in MCP, REST, or the frontend

Concretely, this means:

- An MCP tool handler and a REST route handler that do "the same thing"
  must call the same service function, not each maintain their own copy
  of the rule. Example: `transition_project` (MCP,
  `mcp/tools/project-tools.js`) and `POST /projects/:id/transition` (REST,
  `index.js`) both call `schemas/state-machine.js`'s `transition()` —
  neither one re-implements `canTransition()`'s legality graph.
- A rule enforced on one control surface must be enforced identically on
  every surface that can trigger the same effect. This stage (13E, Part
  4) fixed the one place that wasn't true: `PATCH /projects/:id` used to
  accept a raw `status` field and write it directly via
  `projectStore.updateProject()`, while the MCP `update_project` tool
  already refused to. `status` is now removed from `updateProject`'s
  `UPDATABLE_FIELDS` entirely (see `services/project-store.js`) — the
  fix lives in the shared service, so it applies to both surfaces (and
  any future one) automatically, rather than being patched into the REST
  route alone.
- The frontend never contains a rule that decides WHETHER an action is
  allowed beyond disabling a button as a convenience — the server always
  re-checks independently. Example: `frontend/app.js`'s
  `computeKeyframeGenerationEligibility()` is explicitly commented as "a
  convenience, not a security boundary" — `services/keyframe-generation-
  service.js`'s own `runSafetyChecks()` is what actually enforces
  eligibility, regardless of what the disabled/enabled button state
  shows.

## Why REST and MCP are not equivalent in capability today

This document records the intended DIVISION of responsibility, not a
claim that every capability is currently exposed on every surface. As of
Stage 13E, REST does not yet expose Timeline IR scene/shot creation,
video generation (`request_generation`/`poll_generation`), or generation
history listing — those remain MCP-only. This is a known gap (see the
Stage 13D architecture audit, item 18), not a design intention that REST
should be permanently thinner than MCP. Closing it, if and when it's
needed, means adding REST routes that call the same existing services —
never inventing new business logic to do it.

## Where this leaves an Operator Queue

An Operator Queue (explicitly not built in this stage — see Stage 13E's
Part 6 instruction to decide the control-surface model, not implement a
queue) is, under this model, simply another consumer sitting alongside
MCP, REST, and the frontend — most likely built as additional REST routes
plus frontend UI, calling the same services everything else already
calls. It should not need a parallel copy of any rule already enforced by
the service layer.
