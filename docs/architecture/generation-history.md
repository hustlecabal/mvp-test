# Generation History & Asset Library

Stage 9B. A read-only layer for browsing what's already happened —
every generation attempt made, and every asset any of them produced —
without changing how any of it is created or stored.

## Why generations are never deleted

`services/generation-store.js` has never had a delete function, and
Stage 9B doesn't add one. Every generation job — successful, failed, or
abandoned mid-poll — stays on disk forever as its own record. That's
deliberate: a failed attempt is still useful information (what prompt
didn't work, what error came back, what it cost to find out), and
silently discarding it would erase exactly the data a human needs to
understand why a shot took three tries.

## Why multiple attempts for a shot matter

A shot is a single "what should appear on screen here" definition, but
getting a good result from it is naturally iterative:

```
Shot "red ball rolling" →
  Generation 1 → FAILED (bad)
  Generation 2 → COMPLETED (better, but not quite right)
  Generation 3 → COMPLETED (approved)
```

Nothing about this system ever overwrites generation 1 or 2 when
generation 3 succeeds — `generation-service.js`'s `requestGeneration()`
always creates a brand-new job (see its idempotency section:
duplicates are only suppressed for an exact, still-in-flight repeat of
the same request — a genuinely new attempt always gets its own job and,
if it completes, its own asset). `get_shot_history(shotId)` is what makes
that full history visible and queryable, instead of leaving it buried as
three separate files a human would have to know to go looking for.

## How generation history relates to assets

A generation history record (`services/generation-history-service.js`) is
built fresh on every call by joining two things that already exist and
are never copied:

- the generation job (`services/generation-store.js`) — status, prompt,
  timestamps, `reservedCost`/`actualCost`
- the asset it produced, if any (`services/timeline-store.js`) — type,
  and (Stage 9A) storage status, which becomes a working `previewUrl`/
  `downloadUrl` only once the file is actually archived

If a job never produced an asset (still processing, or failed),
`assetId`/`assetType`/`storageStatus`/`previewUrl`/`downloadUrl` are all
`null` — never `0`, `false`, or a URL that would just 404/409 if you
followed it. "We don't know" and "we know it's nothing" are kept
distinct everywhere in this system (the same principle Stage 8.1
established for cost fields), and history records follow the same rule
for `reservedCost`/`actualCost`: a `null` cost is genuinely unknown, and
`list_generation_history`'s `totalReservedCredits` only sums the
generations where a cost is actually known — it's `null`, not `0`, when
none of them are.

## How lineage works

Every history record traces straight back to `projectId`, `sceneId`,
`shotId`, and the job's own `provider`/`model`/`prompt` — the exact same
lineage fields Stage 5–7 already established on generation jobs and
assets. History doesn't introduce a new lineage system; it's a read view
over the one that already exists.

## Candidate vs. approved assets

Every asset has had an `approvalStatus` field since Stage 5
(`NONE`/`APPROVED`/`REJECTED`), originally unused. Stage 9B gives it a
job: `NONE` means "a candidate — a real, generated asset that simply
hasn't been reviewed yet." `services/timeline-store.js`'s
`setAssetApprovalStatus(projectId, assetId, status)` is the only function
that changes it, and it only ever touches that one field on that one
asset — every sibling candidate for the same shot stays exactly as it
was, never deleted, never silently replaced. This is intentionally the
smallest possible addition, not a new review workflow or state machine:
Stage 9B does not add an MCP tool to set it (matching this stage's
"don't add tools beyond history" instruction) — it exists as a tested,
ready-to-use service function for whichever future stage wires up a real
approval action.

## How the frontend will eventually use this API

Nothing here assumes a frontend yet — everything is single-purpose,
read-only endpoints a UI can call directly once one exists:

- `list_generation_history(projectId)` → a project-level activity feed:
  every attempt, its status, and rollup counts (completed/failed/
  processing, total reserved credits, how many produced an asset).
- `get_shot_history(shotId)` → the "pick the best take" view: every
  attempt for one shot, side by side, each with its own preview/download
  link and (once wired up) approval status.
- `list_assets(projectId, { sceneId, shotId, generationId, type,
  storageStatus })` → a filterable asset library — plain field-equality
  filters, deliberately not a search engine, matching how every other
  list function in this codebase already filters.

All three return logical URLs (`/assets/:assetId/preview`,
`/assets/:assetId/download`) and never a filesystem path, an API key, an
Authorization header, or a raw provider request/response object — a
frontend only ever needs what these tools already give it.
