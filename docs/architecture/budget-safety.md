# Budget Safety

Stage 8.1. Written after the project's first real EvoLink generation
(project "EVOLINK LIVE SMOKE TEST", generation `bd08023f-ea3a-46a7-af8a-6257e188fd5f`)
came back with `reservedCost: 100.45` against a 100-credit human-authorized
cap — 0.45 credits over. That's the event that exposed the gaps this
document (and the code changes alongside it) fix. Nothing here is
theoretical; it's a direct response to something that actually happened.

## Why the original 100-credit cap wasn't technically enforceable

Before this stage, `services/approval-gate.js` had one number:
`creditLedger.limit`. The mental model was "a hard spending cap." That's
not quite what it was, and pretending otherwise is exactly what this
document is here to stop doing.

Here's the sequence of events for any EvoLink video generation:

1. We decide to submit a request. At this point we do **not** know what it
   will cost — see `docs/integrations/evolink-api.md`'s "Pricing / Cost"
   section: EvoLink publishes no per-model rate table, and there is no
   "quote" endpoint you can call before submitting.
2. We submit `POST /v1/videos/generations`. EvoLink accepts the task
   **and reserves credits for it in the same response** — the
   `usage.credits_reserved` field.
3. Only now, after the credits are already reserved, do we find out the
   number.

There is no step where a local `if (cost > budget) refuse` check could
have stopped the smoke test's 100.45-credit reservation, because the
number 100.45 did not exist anywhere — not in our code, not in EvoLink's
systems — until after step 2 had already happened. A "hard provider-side
spending cap" would require EvoLink to expose a pre-submission quote. It
doesn't. So we don't get to have one, and this codebase must not claim to.

**What `creditLedger.limit` actually is:** a **human authorization
threshold** — the maximum a human is willing to have reserved/spent on a
project before they want to be asked again. It's a policy number we
enforce on our own subsequent decisions (whether to allow the *next*
generation), not a technical guarantee about what any single provider call
can cost.

## What EvoLink tells us before generation

Nothing cost-specific. `GET /v1/credits` tells you your account's overall
balance (see Part 2/3 of this project's smoke-test history) — not what any
particular request will cost. No model has a published price. The only
thing resembling a pre-submission signal is the `usage` object's shape,
documented in the API reference — but its actual numbers aren't known
until you submit.

## What EvoLink tells us after generation

Two different numbers, at two different times, and they are **not the
same concept**:

- **`reservedCost`** (EvoLink's `usage.credits_reserved`) — returned
  immediately in the task-creation response. This is EvoLink's own
  estimate of what the task will cost, and it reserves that many credits
  against your account right then. It can be wrong (it's a reservation,
  not a receipt).
- **`actualCost`** — the real, final, settled cost. EvoLink's documented
  API (as verified in `docs/integrations/evolink-api.md`) **does not
  return this anywhere we've found**. Every generation job's `actualCost`
  field in this codebase stays `null` — not because nobody wired it up,
  but because there is nothing to wire it to. If that ever changes (a
  future EvoLink docs update, a webhook that includes it, etc.), the
  reconciliation code already knows what to do with it — see below.

## The ledger's fields, one at a time

`project.creditLedger` (see `services/approval-gate.js`):

| Field | Meaning | Can it be null/unknown? |
|---|---|---|
| `limit` | The human-authorized safety cap (`budgetLimit`). | Yes — `null` means no cap has been set. |
| `reserved` | Running total of every reconciled generation's `reservedCost`. The best number available at submission time. | No — starts at `0`, only ever a real number. |
| `actualSpent` | Running total of every reconciled generation's `actualCost`, **only** for generations where the provider actually reported one. | Yes — stays `null` until a provider ever reports a real final cost (never happens with EvoLink today). `null` here means "unknown," never "zero." |
| `overage` | `null` until reserved (or actualSpent, once known) exceeds `limit`. Once set: `{ generationId, amount, detectedAt, acknowledged, acknowledgedBy, acknowledgedAt }`. | Yes — `null` is the normal, healthy state. |
| `blocked` | `true` while an unacknowledged overage exists. Blocks every further generation for the project regardless of approval/budget status. | Boolean, never null. |

**Remaining budget** is deliberately *not* a stored field — it's always
computed fresh (`gate.getRemainingBudget(project)`), as
`limit - (actualSpent ?? reserved)`, so it can never drift out of sync
with the numbers it's derived from. It returns `null` when `limit` is
`null` (no cap means "remaining" is meaningless).

We use `reserved` as the fallback for "how much have we committed" because
EvoLink has already put a hold on those credits by the time we know the
number — treating them as available budget again before we know
otherwise would be the same mistake the smoke test just taught us not to
make.

## How human approval works

`project.approvals` (unchanged in spirit, extended in Stage 8.1):

- `estimatedCost` — a number the human sets when requesting approval, or
  `null` if they don't know it yet. This is a human's *stated* estimate at
  approval time, not a provider quote.
- `status` — `NONE → PENDING → APPROVED`/`REJECTED`, decided by a human via
  `decideApproval()`.
- `unknownCostAcknowledged` — see the unknown-cost policy below.

## The unknown-cost policy: `UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL`

Before this stage, `canProceed()` did `approvals.estimatedCost || 0` —
meaning a `null` (unknown) estimated cost silently became `0`, as if the
generation were free. That's exactly backwards: **not knowing the cost is
a reason for MORE caution, not less.**

The fix: `canProceed()` now refuses to proceed when `estimatedCost` is
`null`, unless a human has explicitly called
`gate.acknowledgeUnknownCost(project, { acknowledgedBy })` first. That
call:

- Cannot happen automatically — nothing in this codebase calls it except a
  human-driven action.
- Is recorded on the approval object (`unknownCostAcknowledged`,
  `unknownCostAcknowledgedBy`, `unknownCostAcknowledgedAt`) so the
  acknowledgement is preserved, not implied.
- Does not change what `estimatedCost` *is* (it stays `null` — still
  unknown) — it only records that a human knowingly chose to proceed
  without knowing it, subject to whatever budget cap is otherwise
  configured for the project.

This is exactly what happened, retroactively, for the "EVOLINK LIVE SMOKE
TEST" project: the human's approval note explicitly said "Pre-submission
EvoLink cost: UNKNOWN," which is a real acknowledgement — it's now
recorded as one via `acknowledgeUnknownCost`, rather than left as an
implicit `null` that the old code would have quietly treated as `0`.

## How overages are handled

`gate.reconcileGenerationCost(project, job)` is the one place that folds a
generation job's provider-reported numbers into the ledger. It's called
automatically by `generation-service.js`: once right after submission
(when `reservedCost` becomes known) and again after every status check
(in case a future provider ever adds `actualCost`). It's delta-based and
keyed by job id, so calling it more than once for the same job never
double-counts.

If reconciling a job pushes `remaining` below zero **for the first time**,
`reconcileGenerationCost` records an `overage` object and sets
`blocked: true`. From that point, `canProceed()` refuses every further
generation for that project — regardless of approval status or the
numeric budget check — until a human calls
`gate.acknowledgeOverage(project, { acknowledgedBy })`.

What this deliberately does **not** do:

- **No automatic refund.** EvoLink was already told to reserve the
  credits; nothing in this codebase can undo that, and no code here
  pretends to try.
- **No automatic cancellation of a completed generation.** The generation
  result (video, asset, lineage) is preserved exactly as it was — an
  overage is a budget-policy event, not a reason to discard real, paid-for
  output.
- **No silent continuation.** The project is blocked until a human looks
  at it. That's the whole point.

## Why we never pretend unknown cost is zero

Three different `null`s appear in this system, and all three mean "we
don't know," never "we know it's zero":

- `approvals.estimatedCost === null` — the human hasn't estimated a cost
  (or explicitly doesn't know one).
- `job.reservedCost === null` — the provider hasn't reserved anything yet
  (job not yet submitted).
- `creditLedger.actualSpent === null` — no provider has ever told us a
  real final cost.

Treating any of these as `0` would make the system *more* willing to
spend when it knows *less* — the opposite of what a safety gate is for.
Every arithmetic operation in `approval-gate.js` that touches these values
checks for `null`/`typeof === 'number'` explicitly rather than relying on
JavaScript's implicit falsy-coercion, specifically to avoid ever
re-introducing this bug.
