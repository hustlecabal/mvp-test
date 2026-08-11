# Operator Queue — Stage 14

Code: `server/schemas/operator-queue-schema.js`,
`server/services/operator-queue-service.js`,
`server/mcp/tools/operator-queue-tools.js`, the `/projects/:id/operator-queue*`
and `/projects/:id/shot-readiness` routes in `server/index.js`, and the
"Operator Queue" workspace in `frontend/index.html`/`frontend/app.js`.

## Queue purpose

The Operator Queue is the operational control layer for a human producing
many keyframes across a project. It creates no new state, approval, asset,
or prompt system — it only reads records that already exist (the
Storyboard, the Keyframe Plan, Prompt Packages, Keyframe Generation
Approvals, Handoffs, Assets, and the canonical-asset selection) and
answers, per keyframe: what needs attention, what to do next, why, and
whether the keyframe is actually done. See the Stage 14 task brief's own
ten questions — every one of them is answered by a field on a queue item
or by `getQueueSummary()`/`getShotReadiness()`, never by a new rule.

## Queue categories

Ten categories, each mapped to exactly one concrete next action
(`operator-queue-service.js`'s `CATEGORY_INFO` table):

| Category | Next action | Meaning |
|---|---|---|
| `BLOCKED` | Resolve blocking condition | A human-intervention condition (today: only a project budget overage) is stalling this keyframe |
| `NEEDS_ASSET_REVIEW` | Approve or reject asset | A handoff-ingested image is waiting for a human decision |
| `IMAGE_RETURNED` | Review returned image | A fake-image-generation-path image is waiting for a human decision |
| `READY_FOR_CANONICAL_SELECTION` | Select canonical asset | An APPROVED candidate exists but none is canonical yet |
| `NEEDS_APPROVAL` | Approve keyframe generation | A CURRENT package exists but no matching APPROVED generation approval |
| `READY_FOR_HANDOFF` | Create human handoff | Approved and ready — no active handoff exists yet |
| `NEEDS_PROMPT_PACKAGE` | Build prompt package | No package exists, or the existing one is STALE |
| `NEEDS_KEYFRAME_PLAN` | Analyze keyframes | A shot has no keyframes planned at all (a shot-level placeholder item, `keyframeId: null`) |
| `HANDOFF_IN_PROGRESS` | Open handoff | A READY or IN_PROGRESS handoff already exists (Stage 13E: at most one) |
| `COMPLETE` | (none) | Canonical asset selected AND that asset is APPROVED |

### Resolving the spec's two near-duplicate categories

The task brief names both `IMAGE_RETURNED` ("Review returned image") and
`NEEDS_ASSET_REVIEW` ("Approve or reject asset") for what is, underneath,
the same signal — an unreviewed (`approvalStatus: 'NONE'`) asset exists.
Part 16 additionally states unconditionally that an INGESTED handoff maps
to `NEEDS_ASSET_REVIEW`. This implementation resolves the two by
**provenance**: an unreviewed asset that arrived through a human handoff
(`asset.handoffId` set) is `NEEDS_ASSET_REVIEW`, matching Part 16's literal
instruction; one that arrived through the Stage 13B/13C generation path
(`asset.generationId` set, no handoff) is `IMAGE_RETURNED`. Both sit at the
same priority (2), so this choice never changes ordering — only which
category name a human sees.

## Priority rules

Priority is an explicit table (`CATEGORY_INFO`), not inferred from
anything else. 1 is highest (needs a human right now), 9 is lowest
(nothing to do):

```
1  BLOCKED                          — a human-intervention condition is stalling production
2  NEEDS_ASSET_REVIEW / IMAGE_RETURNED — a human already did external work and is waiting on a decision
3  READY_FOR_CANONICAL_SELECTION    — a decision is pending, but nothing is stalled
4  NEEDS_APPROVAL                   — the next production step needs a decision
5  READY_FOR_HANDOFF                — ready to start the next production step
6  NEEDS_PROMPT_PACKAGE             — planning work, no decision needed
7  NEEDS_KEYFRAME_PLAN              — earlier planning work, no decision needed
8  HANDOFF_IN_PROGRESS              — already in motion, nothing for the operator to do but wait
9  COMPLETE                         — nothing to do
```

The queue sorts by priority ascending, then by the storyboard's own
scene/shot `order` fields (falling back to id only when `order` was never
set) — same project state always produces the same order
(`buildProjectQueue`'s own determinism test, `operator-queue-service.test.js`
item 17).

### The budget-blocked rule (Part 17)

The task brief states "if project budget is blocked: category BLOCKED"
without further qualification. This implementation applies it narrowly:
only `NEEDS_APPROVAL` and `READY_FOR_HANDOFF` — the two categories that
represent committing to the next paid-adjacent production step — are
converted to `BLOCKED` while a budget overage is unresolved.
`NEEDS_KEYFRAME_PLAN`, `NEEDS_PROMPT_PACKAGE` (pure planning, free),
`NEEDS_ASSET_REVIEW`/`IMAGE_RETURNED`/`READY_FOR_CANONICAL_SELECTION`
(reviewing/selecting an already-existing asset, free), and
`HANDOFF_IN_PROGRESS` (already committed, in flight) are left untouched.
This reflects the actual code: `services/keyframe-handoff-service.js`'s
`createHandoff()` never checks the credit ledger at all (a handoff itself
costs nothing to the project's tracked budget — the human spends real
money on Higgsfield outside the application), so a budget block doesn't
literally prevent a handoff from being created; it is surfaced here as a
signal that the human should resolve the overage before continuing, not
as a rule this file invents independently of the real gate
(`services/approval-gate.js`'s `canProceed()` remains the only real
enforcement point, unchanged by this stage).

## Completion definition

A keyframe is `COMPLETE` if and only if:

1. it has a canonical asset selected (`keyframe.canonicalAssetId`), **and**
2. that exact asset's `approvalStatus` is `APPROVED`.

"An image exists" is never sufficient — this is exactly why Stage 13E's
canonical-asset work (`selectCanonicalKeyframeAsset`) was a prerequisite
for this stage: without a canonical-asset field, there would be no way to
distinguish "one of several candidate images happens to be approved" from
"this is definitively the keyframe's asset." `getQueueSummary()`'s
`completionPercentage` is `round(complete / totalKeyframes * 100)`, where
`totalKeyframes` counts only real keyframe items (the `NEEDS_KEYFRAME_PLAN`
shot-placeholder items are excluded, since they have no keyframe yet to be
complete or incomplete).

## Shot readiness definition

`getShotReadiness(projectId)` reuses the SAME per-keyframe `COMPLETE`
determination `buildProjectQueue` already computed — never a second
definition of "complete." For each shot with at least one queue item:

```
keyframesRequired = count of planned keyframes for this shot
keyframesComplete = count of those with category COMPLETE
keyframesMissing  = keyframesRequired - keyframesComplete
readyForVideo     = keyframesRequired > 0 AND keyframesComplete === keyframesRequired
```

`readyForVideo` is a **read-only signal only**. Nothing in this file (or
anywhere in this stage) starts, prepares, or references video generation
— `services/generation-service.js` is untouched.

## Source-of-truth services

The queue never invents a rule any of these already own:

- `services/project-store.js` / `services/approval-gate.js` — project
  status, credit ledger, budget-blocked state.
- `services/creative-store.js` — storyboard scenes/shots, visual bible
  (character/location names).
- `services/keyframe-store.js` — keyframes, `stale`, and (Stage 13E) the
  canonical asset.
- `services/keyframe-prompt-service.js` — prompt packages and their live
  CURRENT/STALE status.
- `services/keyframe-generation-approval-store.js` — keyframe generation
  approvals.
- `services/keyframe-handoff-service.js` — handoffs, including Stage 13E's
  at-most-one-active-handoff guarantee.
- `services/timeline-store.js` — assets and their `approvalStatus`.

## Why compute-on-read

Nothing about a queue item is ever persisted. Every call to
`buildProjectQueue`/`getQueueSummary`/`getNextAction`/`getShotReadiness`
re-derives the queue from the current state of the stores above. A
persisted/materialized queue would need its own invalidation logic
(when does a package rebuild, an approval decision, or a handoff
ingestion require recomputing which items?) — compute-on-read sidesteps
that whole class of staleness bugs entirely, at the cost of recomputing
on every read. Stage 12's `stale` flag on a keyframe and Stage 13A's
package `status` already established this same pattern in this codebase;
this stage just extends it to a project-wide aggregate.

## Why the queue does not create a new state machine

A queue item's `category` is a computed VIEW over five other systems'
existing state (package status, approval status, handoff status, asset
approval status, canonical selection) — it is not itself a state a
keyframe can be "in" that anything writes to. There is no
`keyframe.queueCategory` field, no transition-legality graph, and no
function that sets a category. Every category is recomputed from scratch
on every read; two different reads of the same underlying state always
produce the same category, but there is no persisted state to have gotten
out of sync in the first place.

## Human-in-the-loop boundary

The queue is strictly read-only apart from navigation. `get_operator_queue`,
`get_operator_queue_summary`, and `get_next_operator_action` (MCP) and
`GET /projects/:id/operator-queue*` / `GET /projects/:id/shot-readiness`
(REST) are the only surfaces — no `execute_queue`, `run_queue`,
`generate_queue`, `auto_process_queue`, or `batch_generate` exists, and a
dedicated test (`operator-queue-mcp.test.js`) fails if any of them ever
appear. In the frontend, every queue item's only interactive control is
**OPEN KEYFRAME**, which switches to the existing Creative Director
Keyframe Plan workspace — the queue never renders a second editor, and
contains no Generate/Execute/Run Skill/Auto Generate/Batch Generate
control anywhere (enforced by a static test,
`operator-queue-frontend.test.js`).

## Scaling observations (Part 13/20)

Measured directly (`operator-queue-scale.test.js`, printed on every test
run) on this machine, for a project with N keyframes spread across
N/10 scenes, a realistic mix of categories (~1 in 9 fully COMPLETE, the
rest at various earlier stages):

| Keyframes | `buildProjectQueue` + `getQueueSummary` + `getShotReadiness` |
|---|---|
| 10  | ~7 ms |
| 50  | ~46 ms |
| 100 | ~163 ms |

This is comfortably fast for an interactive queue — no further
optimization was needed to reach this, and no database was introduced.

**A real N+1 was found and fixed during this stage**, though not in
the Operator Queue's own code. `services/keyframe-prompt-service.js`'s
`attachLiveStatus()` (used by `listKeyframePromptPackages`, which the
queue calls once per project) called `keyframeStore.getKeyframePlan()`
once per package to read the Keyframe Plan's current version — but
`getKeyframePlan()` is itself O(keyframe count), because it runs
`keyframe-store.js`'s `attachStale()` (a full storyboard re-read) on every
keyframe just to compute a `stale` flag `attachLiveStatus` never even
uses. Calling that once per PACKAGE turned an O(N) package listing into
O(N²): measured at **~4.6 seconds** for 100 packages before the fix, and
100 keyframes' worth of `buildProjectQueue` taking over **15 seconds**.
The fix — `keyframeStore.getKeyframePlanVersion(projectId)`, a new O(1)
accessor that reads only the plan's own version field without ever
running `attachStale`, plus having `listKeyframePromptPackages` fetch the
live storyboard/plan versions ONCE for the whole list instead of once per
package — is a narrow, behavior-preserving fix (verified against the
full pre-existing `keyframe-prompt-service`/`keyframe-store` test suites,
all still green) squarely inside "avoid N+1 filesystem reads where
practical" (Part 13), not a new architecture. It brought
`listKeyframePromptPackages` at 100 packages from ~4.6s to ~3ms.

Every other store this stage reads from a project already exposes (or,
in the case of `keyframe-generation-approval-store.js`'s new
`listApprovals()`, was given) a single bulk-read function — `listKeyframes`,
`listKeyframePromptPackages`, `listApprovals`, `listHandoffs` (unfiltered),
and `listAssets` are each called exactly ONCE per `buildProjectQueue` call,
regardless of keyframe count; everything else is an in-memory `Map` lookup
built from those single reads. The one remaining per-item cost is Stage
13D's `keyframe-handoff-service.js` enriching each INGESTED handoff with
its asset via a fresh `timelineStore.getAsset()` call (itself a full
project re-read) — bounded by the number of *ingested handoffs*, not
keyframe count squared, and not worth touching for this stage's measured
scale. If a project's keyframe count grows an order of magnitude beyond
what was measured here, that would be the next place to look before
reaching for a database.
