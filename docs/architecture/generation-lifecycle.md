# Generation Lifecycle

This document explains how a single request to generate a video (or
image, eventually) actually flows through the system, end to end — from
"a human approved this" to "there's a finished asset on the project."

Code: `server/services/generation-store.js`, `generation-service.js`,
`generation-poller.js`; MCP tools in `server/mcp/tools/generation-tools.js`.

## What a Generation Job is, and why we need one

Every time we ask a provider (EvoLink, for now) to generate something, we
create a **Generation Job** — a small record that remembers everything
about that one request: which project and shot it's for, what was asked
for, which provider/model handled it, its current status, how much it
might cost, and — once finished — the result and the asset it produced.

We need this because generation is **asynchronous and takes real time**.
The provider doesn't hand back a finished video immediately — it hands
back a task ID, and we have to check back later. Without a persistent
record of "this generation is happening, here's its provider task ID,"
a crash or restart partway through would leave us with no way to know an
external task even exists, or whether it already cost money.

Each job connects the full chain:

```
Project → Shot → Generation Request → Provider → External Task ID
   → Status → Result → Asset
```

## How approval protects us

Before a Generation Job is ever created, `generation-service.js` runs
every one of these checks, **in this order**, and stops at the first
failure:

1. Does the project exist?
2. Does the shot exist (and belong to that project)?
3. Is the project currently in a generation state (`CALIBRATION`,
   `KEYFRAME_GENERATION`, or `MOTION_GENERATION` — see
   [state-machine.md](./state-machine.md))?
4. Does the Stage 3 approval/budget gate (`services/approval-gate.js`)
   say generation is currently allowed for this project?

**Nothing calls the provider until all four pass.** This isn't
duplicated logic — `generation-service.js` calls the exact same
`gate.canProceed()` function the state machine itself already uses, so
there's only one place this rule is ever defined.

`estimate_generation` (an MCP tool) runs these same four checks and
reports the result **without** creating a job or touching a provider —
useful for checking "would this be allowed?" before actually committing
to it.

## The three cost fields, and why they're separate

A Generation Job has `estimatedCost`, `reservedCost`, and `actualCost` —
deliberately three different fields, because they come from different
places at different times:

- **`estimatedCost`** — set by a **human**, ahead of time, through the
  Stage 3 approval flow (`request_generation_approval`). This is what the
  approval/budget gate actually bases its decision on. It's snapshotted
  onto the job at creation time for the record.
- **`reservedCost`** — reported **by the provider itself**, at the moment
  it accepts the task (EvoLink calls this `usage.credits_reserved`).
  It doesn't exist yet when the approval decision was made — it can only
  be recorded *after* submission, purely for our own tracking. It is
  **never** used to retroactively justify a submission that already
  happened, and the code never assumes it will be present (EvoLink's own
  documentation doesn't guarantee it).
- **`actualCost`** — the real, final cost. As of this stage, EvoLink's
  documented API doesn't return this value anywhere we've found (see
  `docs/integrations/evolink-api.md`) — so it stays `null`. We do not
  invent a number here. If EvoLink (or a future provider) documents a way
  to get this later, this field is ready for it.

## How provider submission works

`generation-service.js` never talks HTTP to EvoLink directly. It calls
the same generic provider interface from Stage 6
(`providers/provider-interface.js`):

```
generation-service.js
    ↓  (generic request: provider/model/task/prompt/references/parameters)
provider adapter (e.g. providers/evolink/evolink-provider.js)
    ↓
provider's HTTP client
    ↓
the actual provider (EvoLink)
```

This means adding a second provider later (LongCat, a local model, etc.)
means adding an entry to `generation-service.js`'s small provider
registry — nothing about the safety checks, the job model, or the MCP
tools needs to change.

The moment a provider accepts a submission, its task ID, status, and
`reservedCost` (if given) are saved to the job **immediately** — before
anything else happens. If our process crashed the instant after, we would
still know the external task exists and could check on it later, rather
than losing track of something that might already be running (and
costing money).

## How polling works

A Generation Job doesn't resolve itself — something has to ask the
provider "is it done yet?" `generation-poller.js` does exactly that:

1. Read the job's `providerTaskId`.
2. Ask the provider for its current status.
3. Update the job.
4. If it's still pending/processing, wait a short interval and check
   again.
5. Stop as soon as it's `COMPLETED` or `FAILED`.
6. Give up after a configurable number of attempts (`TIMED_OUT`).

Polling settings (`GENERATION_POLL_INTERVAL_MS`,
`GENERATION_POLL_MAX_ATTEMPTS`) default to short, development-friendly
values — this is not meant to model a real multi-minute video wait, just
to prove the mechanism works.

**Important distinction:** if checking the provider fails because of a
network problem, that is recorded as a separate `lastPollError` field —
it does **not** change the job's actual status. A network hiccup is not
the same thing as "the generation failed," and treating it as one would
be actively wrong (and could make a perfectly good generation look
failed). The next poll attempt simply tries again.

**`TIMED_OUT` is one of ours, not the provider's.** It means *we* stopped
checking after a number of attempts — it does not mean the provider's
task actually failed. The real task may still be running, or may finish
later; the docs deliberately avoid inventing a provider-side failure that
didn't happen.

## How failures work

If the provider reports the task failed, the job is marked `FAILED`,
with the provider's error code, message, and a `failedAt` timestamp
recorded. **Nothing here automatically creates a new generation job to
retry.** A failed generation stays failed — retrying (if ever added) would
be a deliberate, separate action, not something that happens silently and
potentially spends money again without a human deciding to.

## How assets are created

The moment a job is first seen as `COMPLETED` (checked via
`!job.assetId`, so this only ever happens once per job), an Asset record
is created and linked to:

- the project, scene, and shot it belongs to
- the Generation Job that produced it (`generationId`)
- the provider and model that made it
- the prompt used
- the reference assets/images it was built from

This reuses the exact same asset lineage rules from Stage 4
(`schemas/production-schema.js`) — assets are never edited in place, only
created new, so nothing here can accidentally corrupt or overwrite an
existing approved asset.

## Why EvoLink URLs will eventually need to be archived

EvoLink's documentation is explicit: generated file URLs are **only
valid for 24 hours**. Right now, an Asset simply stores that URL
(`asset.url`) — it does not download or archive the actual file. That's
fine for this stage (nothing has been generated for real yet), but it
means a real completed asset's file would become unreachable after a day
unless something downloads and stores it permanently. This stage
deliberately does not build that — it's flagged here as a known,
necessary piece of a later stage.

## How duplicate generation is prevented

Calling `request_generation` twice for the exact same intended request
(same project, shot, provider, model, task, prompt, references, and
parameters) while an earlier matching job is still in flight (`REQUESTED`,
`SUBMITTED`, or `PROCESSING`) does **not** submit a second one — it
simply returns the existing job (`deduplicated: true`).

This is intentionally simple: an exact match check, not a distributed
locking system. It protects against the most likely real accident (a
retry, a double-click, calling the tool twice) without adding complexity
this MVP doesn't need yet. A generation that already finished (completed,
failed, or timed out) does **not** block a fresh request — only one that's
still genuinely in progress does.
