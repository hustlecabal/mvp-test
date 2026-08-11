# Frontend Production Workspace

Stage 10. A read-only browser UI over the backend built in Stages 1–9B —
plain HTML/CSS/JavaScript, no framework, no build step.

## Frontend structure

```
frontend/
  index.html   — the three-panel layout skeleton (empty containers only)
  styles.css   — plain CSS, no framework
  app.js       — all behavior: fetches data, renders it into the containers
```

`server/index.js` serves this directory statically
(`express.static(path.join(__dirname, '..', 'frontend'))`), so the whole
app — API and UI — runs from one command (`npm start` inside `server/`) on
one origin. The frontend calls the API with relative paths (`/projects`,
not `http://localhost:3000/projects`), so there's no CORS configuration to
worry about.

`app.js` never computes budget, approval, or lineage logic itself — every
number it shows (remaining budget, whether generation is allowed, which
asset belongs to which generation) comes directly from a backend response.
The frontend's only job is fetching and formatting.

## API calls

All read-only. Nothing the frontend calls can create, modify, or delete
anything.

| Call | Used for |
|---|---|
| `GET /projects` | The project list (LEFT panel, top) |
| `GET /projects/:id` | Full project detail — includes `scenes[]` and `shots[]` already embedded, so no separate scene/shot endpoints were needed |
| `GET /projects/:id/budget` | Budget panel (RIGHT panel, bottom) — new in Stage 10, calls `services/approval-gate.js`'s `getBudgetView()`, the exact same function the `get_project_budget` MCP tool calls |
| `GET /shots/:shotId/history` | Generation history + shot workspace (CENTER panel) — new in Stage 10, calls `services/generation-history-service.js`'s `listShotHistory()`, the exact same function the `get_shot_history` MCP tool calls |
| `GET /assets/:assetId/preview` | The `<video>` element's `src` (Stage 9A endpoint, unchanged) |
| `GET /assets/:assetId/download` | The Download button's `href` (Stage 9A endpoint, unchanged) |

Only two new backend endpoints were added, and both are thin HTTP wrappers
around services that already existed for the equivalent MCP tools —
nothing in `index.js` reimplements budget or history logic; see
`docs/architecture/budget-safety.md` and
`docs/architecture/generation-history.md` for what those functions
actually do.

## Project navigation

Clicking a project in the LEFT panel loads its full record
(`GET /projects/:id`) and its budget (`GET /projects/:id/budget`) in
parallel. The scene/shot tree is built entirely client-side from the
already-embedded `project.scenes` and `project.shots` arrays — grouping
shots under their scene by `sceneId` is a plain array filter, not business
logic.

## Shot workspace

Clicking a shot fetches `GET /shots/:shotId/history` and renders:

- the shot's title, scene name, status, and generation count
- its prompt
- a `<video>` preview using the **most recently archived** asset's
  `/assets/:assetId/preview` URL — never a temporary EvoLink URL. If no
  generation for this shot has been archived yet, the video is replaced
  with "The generated result has not been archived." instead.
- a Download button using that same asset's `/assets/:assetId/download`
  URL

## Generation history

Every record `GET /shots/:shotId/history` returns is rendered as its own
card — none are ever hidden or replaced by a later one. Cards are numbered
chronologically (`Generation 1`, `Generation 2`, …, oldest first) even
though the API returns them newest-first, so the numbering reads the way a
human made the attempts. Clicking a card selects it, updating both the
video preview area's outline and the RIGHT panel's generation info to that
specific attempt — so a failed attempt's details can be inspected without
losing access to a later successful one.

Each card also shows the resulting asset's approval status as a badge —
**Candidate** (`NONE`, unreviewed), **Approved**, or **Rejected** — using
Stage 9B's `assetApprovalStatus` field. Display-only, on purpose: this
stage adds no way to change it, per this stage's instructions.

## Asset preview / download

The `<video>` element's `src` and the Download link's `href` are always
the asset's own `previewUrl`/`downloadUrl` from the history record — which
`generation-history-service.js` only ever populates once
`asset.storage.status === 'STORED'`. If a generation is COMPLETED but its
asset hasn't been archived yet, those fields are `null` and the UI shows
the "not archived" message instead of a broken video tag.

## Budget display

The RIGHT panel's budget section shows, field for field, exactly what
`GET /projects/:id/budget` (== `get_project_budget`) returns: budget
limit, reserved credits, actual spent, remaining budget, overage amount,
and whether generation is currently allowed. Every field goes through the
same "unknown stays Unknown, never becomes 0" rule the backend already
enforces (see `docs/architecture/budget-safety.md`) — the frontend simply
doesn't override a `null` with a display default of `0`.

When `generationAllowed` is `false`, a red warning box shows the exact
`reason` string the backend returned (e.g. the smoke-test project's real
overage message) — never a generic "something's wrong," and never a
button to work around it. This stage adds no generation controls at all.

## Empty and error states

Every panel independently shows one of: `Loading...` while a fetch is in
flight, `Something went wrong.` plus a `Retry` button if a fetch throws
(never a raw error message or stack trace), or one of the specific empty
messages this stage specifies (`No projects yet.`, `This project has no
scenes yet.`, `This shot has not been generated yet.`, etc.) when a fetch
succeeds but returns nothing. No panel is ever left blank.
