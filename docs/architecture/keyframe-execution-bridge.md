# Keyframe Execution Bridge — Investigation (Stage 13C)

Stage 13C. This is an **investigation**, not a generation stage: it
determines the correct architecture for eventually turning a
`KeyframePromptPackage` (Stage 13A) into a real image via the installed
Claude skills, without ever calling a real image API, spending a credit,
or bypassing `KEYFRAME_GENERATION_APPROVAL` (Stage 13B). No real image
provider is connected by this stage.

## Part 1 — Installed skill findings

Every skill file below was read directly from disk at
`/root/.claude/skills/synced/<name>/`. Nothing here is inferred — where
the installed files don't say, the field is `UNKNOWN`.

### banana-pro-director-2.0

| Question | Finding |
|---|---|
| Installed at | `/root/.claude/skills/synced/banana-pro-director-20/SKILL.md` (998 lines, no other files) |
| Required inputs | Conversational: a text character/outfit/scene description, and optionally user-uploaded reference images (studied "visual-only" by Claude, never invented) |
| Expected output | **Plain text.** A prompt in a fenced code block, delivered to the human in chat, after an interactive "pre-prompt confirmation" exchange |
| Execution mechanism | **None.** The skill is a prompt-writing grammar for Claude to follow. It does not call an API, does not shell out, does not create a file |
| Invokes an external API | No — not from the skill itself. The *prompt it writes* is meant to be run in **Higgsfield** (Banana Pro / Soul Cinema / GPT-2 are Higgsfield's own image models), but the skill never calls Higgsfield itself |
| Invokes another CLI | No |
| Creates files | No |
| Returns paths | No |
| Returns URLs | No |
| Requires user interaction | **Yes, extensively.** The skill's own "PRE-PROMPT CONFIRMATION RULE" mandates asking the user which tool to use (Banana Pro / GPT-2 / Soul Cinema), mirroring back a spec for confirmation, and waiting for a "sound good?" before ever producing a prompt. Explicitly not skippable except for a "minor iteration" carve-out |
| Can operate non-interactively | **No**, by the skill's own design |
| Exposes a command/CLI | No |
| Expects image attachments | Yes, conversationally — "study and lock" from a user-uploaded reference; the skill's own text confirms *"image attachment happens in the Higgsfield UI directly"* (line 951) and *"the prompt is text-only"* — reference images are uploaded by a **human**, directly into Higgsfield's UI, never handled programmatically by the skill or by Claude |
| Can consume our normalized KeyframePromptPackage | Not directly — the skill expects a live back-and-forth conversation, not a JSON document. Its *prompt-writing grammar*, however, can be informed by our package's structured fields (identityLock, wardrobeLock, environmentLock) — see Part 3 |

### cinema-worldbuilder-pro-2.0

| Question | Finding |
|---|---|
| Installed at | `/root/.claude/skills/synced/cinema-worldbuilder-pro-20/SKILL.md` (single file) |
| Required inputs | Conversational: uploaded reference images (optional) plus a scene description |
| Expected output | Plain text: a numbered reference list + an English prompt code block with inline `@image1`…`@image9` tags |
| Execution mechanism | **None.** Same as banana-pro-director-2.0 — a prompt-writing grammar only |
| Invokes an external API | No, from the skill itself. Its own instructions (Step 5) say: *"Run it in Higgsfield. Attach the reference images from the bullet list into the Seedance UI in the exact order listed... then paste the English code block into the prompt field."* This is an explicit, documented **human** step |
| Invokes another CLI | No |
| Creates files | No |
| Returns paths | No |
| Returns URLs | No |
| Requires user interaction | Yes — same pre-prompt confirmation pattern as banana-pro-director-2.0 |
| Can operate non-interactively | No |
| Exposes a command/CLI | No |
| Expects image attachments | Yes, conversationally; `@imageN` tags in the OUTPUT prompt are "functional Seedance syntax" but only function once a **human** has manually uploaded the corresponding images into Higgsfield's Seedance UI in matching order — the skill/Claude never uploads them |
| Can consume our normalized KeyframePromptPackage | Not directly (same reasoning as above) — see Part 3 for field-level mapping |

### video-prompt-builder

| Question | Finding |
|---|---|
| Installed at | `/root/.claude/skills/synced/video-prompt-builder/SKILL.md` + `references/effects-breakdown-reference.txt` |
| Required inputs | A creative brief (text) |
| Expected output | Plain text: a structured shot-by-shot effects-breakdown prompt for "Seedance 2.0" |
| Execution mechanism | **None** — prompt-writing only, same family as the other two |
| Invokes an external API | No |
| Invokes another CLI | No |
| Creates files / returns paths / returns URLs | No / No / No |
| Requires user interaction | Only a single optional clarifying question if the brief is too vague — otherwise can proceed directly to producing the text prompt |
| Can operate non-interactively | Closer to yes than the other two (no mandatory multi-step confirmation loop is documented), but it still only *writes text* — it has no execution mechanism at all, interactive or not |
| Exposes a command/CLI | No |
| Expects image attachments | Not applicable — it's a video-prompt (not image-reference) skill |
| Can consume our normalized KeyframePromptPackage | Not applicable to keyframe (image) execution — this skill targets full video shot lists, not single keyframes. Already adapted separately in `services/skill-adapters/video-prompt-builder-adapter.js` (Stage 11B), unrelated to this stage's image-execution question |

### Cross-cutting finding: the skill manifest confirms this

`/root/.claude/skills/synced/manifest.json` lists all three skills with
only `skillId`, `name`, `description`, `source: "custom"`, `updatedAt` —
**no execution/tool/command metadata of any kind.** This matches every
skill file's own content: these are markdown instruction sets for Claude
to follow while writing text, not executable programs.

### A separate, important discovery: the Higgsfield MCP connector

This Claude Code environment has a **separate MCP connector**
(`Higgsfield_MCP`, unrelated to our own `evolink-video-factory` MCP
server) exposing tools including `generate_image`, `generate_video`,
`media_upload`, `show_plans_and_credits`, and others, that — per its own
tool description — *can* call Higgsfield's real API programmatically.

**This was not invoked at any point during this investigation.** No tool
in that connector was called — not even a read-only one (checking
credits, listing models) — because doing so would mean calling a real
external API this stage was explicitly told not to touch, and its exact
behavior has not been verified against Higgsfield's own primary
documentation (only a secondary, tool-level description is available).
Its existence is recorded here because it is directly relevant to Part 2
and Part 9 below, not as an endorsement of using it.

## Part 2 — Execution location

**Given the Part 1 findings, none of the three installed skills expose
any programmatic execution path.** All three are prompt-writing aids
whose *documented, intended* execution step is a **human** manually
running the resulting text prompt inside Higgsfield's own web UI
(uploading reference images there, pasting the prompt, downloading the
result).

This directly answers the architecture question:

- **Architecture A** (Claude Code → Skill → Image → MCP/backend) is
  **not achievable today** — "Skill → Image" has no automated path; a
  human sits in that gap.
- **Architecture B** (Claude Code → MCP → Node backend → Image API →
  Asset) is what Stage 13B already built, using a *fake* image provider.
  It remains the right shape for a *real* provider — but connecting a
  real one requires verifying that provider's own API from primary docs
  first (Part 9), which is out of scope to *connect* this stage.
- **Architecture C** (Claude Code → MCP → Node backend → Claude/skill
  execution bridge → Image → Asset) is the **closest fit to reality**,
  with one honest correction: the "Claude/skill execution bridge" box is,
  today, **a human operating Higgsfield's UI**, not an automated bridge.
  Claude Code can prepare everything (the correct skill, the correct
  prompt-relevant fields, the correct reference assets) and, after a real
  image is produced and downloaded, hand it back to the backend for
  archiving — but Claude Code cannot execute the skill's image generation
  itself, and per Part 14, this stage stops before ever trying.

**Recommended architecture for this stage's deliverable: Architecture C,
implemented as two honestly-separated pieces:**
1. A **preparation** step (`prepare_keyframe_execution`, Part 7) — real,
   safe, non-generative, runs today.
2. A **fixture execution** step (Part 6) that proves the rest of the
   pipeline (package → normalized result → asset → archive → lineage)
   end-to-end using a local, deterministic substitute for "a human ran
   the skill's prompt in Higgsfield and downloaded the result" — never a
   real image, never a real network call.

See Part 15 for the full final recommendation.

## Part 3 — Skill → Keyframe Package mapping

Our `KeyframePromptPackage` (`schemas/keyframe-prompt-schema.js`, Stage
13A) already carries enough structured information for a human (or,
eventually, an automated bridge) to operate either image skill — nothing
new needed to be added to it for this stage:

### banana-pro-director-2.0

- **Input:** package `subject`, `identityLock[]` (facial/body/hair/skin
  description + identityConstraints per character), `wardrobeLock[]`
  (wardrobe + accessories + wardrobeOverride), `existingReferenceAssets`
  (which asset(s) a human would upload as the character reference)
- **Output:** a Higgsfield Banana Pro / Soul Cinema / GPT-2 text prompt
- **Execution method:** human, in Higgsfield's UI (Part 1/2)
- **Reference-image support:** yes — via `existingReferenceAssets`,
  already resolved by `keyframe-prompt-service.js`
- **Character consistency support:** yes — `identityLock`/`wardrobeLock`
  are exactly the structured data this skill's Mode 0/1 workflow needs
- **Environment support:** yes, for Mode 3 scene plates — via
  `environmentLock[]`
- **Expected artifact:** a single image (PNG/JPG), downloaded by the
  human from Higgsfield
- **Integration mechanism:** none automated today (Part 2) — a human
  bridges skill output to a real file
- **Unknowns:** whether/how the skill's six modes map onto our 9
  `FRAME_TYPES` beyond the CHARACTER_REFERENCE/WORLD_REFERENCE/
  DETAIL_FRAME grouping `keyframe-planner.js` already uses (Stage 12);
  exact Higgsfield model identifiers behind "Banana Pro"/"Soul
  Cinema"/"GPT-2" in the real API (Part 9)

### cinema-worldbuilder-pro-2.0

- **Input:** package `composition`, `camera`, `framing`, `lens`,
  `movementIntent`, `lighting`, `colour`, `atmosphere`,
  `continuityRequirements`, plus `identityLock`/`environmentLock` for
  `@imageN` anchoring
- **Output:** a Seedance text prompt with `@imageN` tags
- **Execution method:** human, in Higgsfield's Seedance UI (Part 1/2)
- **Reference-image support:** yes, same mechanism as above
- **Character consistency support:** yes — `Subject Lock`/`Cross-Frame
  Rules` map directly onto our `identityLock` + `continuityRequirements`
- **Environment support:** yes — `World Plate` maps onto
  `environmentLock`
- **Expected artifact:** for our purposes (single keyframes, not full
  shots) — a single image; the skill is really built for a video prompt,
  so only a subset of its output is relevant to a keyframe artifact
- **Integration mechanism:** none automated today
- **Unknowns:** whether Seedance's `@imageN` mechanism has ANY
  programmatic equivalent outside Higgsfield's own UI — not documented
  in the skill file, and not investigated further (would require calling
  the real API)

## Part 4 — Boundary design

```
Claude Code
    ↓
MCP (our evolink-video-factory server)
    ↓  prepare_keyframe_execution (Part 7 — read-only)
    ↓
execution instructions + safety verdict
    ↓
[TODAY: a human runs the skill's prompt in Higgsfield's UI and downloads a real file —
 no automated bridge exists yet, see Part 2]
    ↓
normalized KeyframeExecutionResult (Part 5)
    ↓
MCP/backend — services/keyframe-execution-bridge-service.js
    ↓
asset archive (reuses services/asset-archive-service.js, Stage 9A)
```

The backend enforces every check regardless of where execution actually
happened: `prepareKeyframeExecution()` (and the fixture executor) both
call straight into `services/keyframe-generation-service.js`'s existing,
already-tested safety gate — the exact same
approval/stale-package/budget/duplicate-protection logic Stage 13B
built, not a second copy of it. Claude Code cannot bypass those checks
by claiming the image came from "outside Node" — the gate runs
identically either way. See Part 8.

## Part 5 — Normalized execution result

`schemas/keyframe-execution-result-schema.js` defines:

```
{
  executionId,      // uuid, generated locally — never a Higgsfield-issued id, since none has been called
  keyframeId,
  packageId,
  packageVersion,
  status,           // 'BLOCKED' | 'COMPLETED' | 'FAILED'
  provider,         // e.g. 'fake-image' — never a real provider name until one is verified + connected
  model,
  skillId,          // e.g. 'banana-pro-director-2.0' — recorded, never executed
  artifactType,     // 'image'
  artifactPath,     // local archived path, only once actually archived
  artifactUrl,      // only ever a LOCAL fixture path in this stage — no invented remote URL, ever
  metadata,
  warnings,
}
```

Only fields the fixture path actually supports are ever populated —
nothing here invents a URL, a cost, or a real provider name.

## Part 6 — Fixture execution

`services/keyframe-execution-bridge-service.js`'s `runFixtureKeyframeExecution()`
proves the full cycle **by calling Stage 13B's already-safety-gated
`keyframeGenerationService.generateKeyframe()`** with the existing
`fake-image` provider (Stage 13B, Part 3) — deliberately not a second,
parallel pipeline. This is a conscious choice: Stage 13B's fixture
lifecycle (fake provider → local archive → asset → lineage → keyframe
status) already proves every one of Part 6's required properties (package
accepted, skill selected, execution result normalized, asset created,
lineage preserved, archive works, zero network) end-to-end, with 68
passing tests and a manual verification behind it. Rebuilding a second,
differently-named fixture pipeline here would duplicate that risk surface
for no benefit. What this stage adds is the **skill-execution framing**:
the completed job + asset get translated into the Part 5
`KeyframeExecutionResult` shape (`skillId` from the package's
`recommendedSkill`, `artifactType`/`artifactPath` from the archived
asset), and `prepareKeyframeExecution()` is new, read-only preparation
logic that didn't exist before.

## Part 7 — MCP boundary

One new tool: `prepare_keyframe_execution` — read-only, never generates
anything. Returns the keyframe, its current prompt package, the
recommended skill (from the existing `services/skill-orchestrator.js`),
resolved reference assets, plain-language execution instructions (what a
human would need to do in Higgsfield today), and a safety verdict
(reusing `keyframeGenerationService.canGenerateKeyframe()` — the exact
Stage 13B eligibility check, not a new one).

A second tool, `run_fixture_keyframe_execution`, was added for the
fixture proof required by Part 6 — it still enforces every Stage 13B
safety check (via the same `generateKeyframe()` call) and only ever
touches the local fake-image provider. No `raw_skill_execution`,
`execute_any_skill`, `raw_command`, or `arbitrary_shell` tool exists, and
none will be added until a real, verified, explicitly-authorized
execution path exists.

## Part 8 — Human approval

Confirmed: both `prepareKeyframeExecution()` and
`runFixtureKeyframeExecution()` call into
`services/keyframe-generation-service.js`'s existing checks
(`canGenerateKeyframe()` / `generateKeyframe()`), which already enforce
`KEYFRAME_GENERATION_APPROVAL`, prompt-package staleness, the shared
project budget/unknown-cost policy, and in-flight duplicate protection —
unchanged from Stage 13B. An unapproved (or otherwise blocked) request to
either new function returns `{ status: 'BLOCKED', ... }` and never
reaches even the fixture provider, let alone a real one.

## Part 9 — Real provider research (Higgsfield)

Researched from Higgsfield's own primary documentation
(`docs.higgsfield.ai`) — no API call was made, no credential was used or
requested.

| Question | Finding | Source |
|---|---|---|
| API endpoint | Base `https://platform.higgsfield.ai/`; example model path `/higgsfield-ai/soul/standard` | docs.higgsfield.ai/docs |
| Authentication | Header `Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}`, credentials created in Higgsfield Cloud | docs.higgsfield.ai/docs/authentication.md |
| Model identifier | Only `higgsfield-ai/soul/standard` ("flagship text-to-image model") is shown in the public guide | docs.higgsfield.ai/docs/guides/images.md |
| Request schema | `{ "prompt", "aspect_ratio", "resolution" }` shown for the one documented model; varies per model | docs.higgsfield.ai/docs/guides/images.md |
| Image/reference inputs | **UNKNOWN** — not shown in the fetched excerpt of the images guide | — |
| Response schema | Initial response: `status`, `request_id`, `status_url`, `cancel_url` | docs.higgsfield.ai/docs |
| Task lifecycle | Asynchronous — submit, then poll `status_url` (or webhook) | docs.higgsfield.ai/docs, docs.higgsfield.ai/docs/how-to/webhooks.md |
| Pricing | Per-request, model/parameter-dependent; example shown: 1.500 credits / $0.094; credits expire 1 year after being added; failed/moderated/canceled requests are refunded | docs.higgsfield.ai/docs/concepts/billing-and-retention.md |
| Rate limits | Concurrency-based, account/model-dependent, no published fixed number (example error shows a sample limit of 4); no documented requests-per-minute limit; no `Retry-After` header | docs.higgsfield.ai/docs/concepts/rate-limits.md |
| Artifact URLs / expiry | Output files available for **at least 7 days**, then may be removed — must be downloaded for permanent storage | docs.higgsfield.ai/docs/concepts/billing-and-retention.md |
| Download mechanism | **UNKNOWN** — not shown in the fetched excerpts (presumably a URL in the completed-status response, not confirmed) | — |

**Critical unresolved gap:** the skill files name "Banana Pro," "Soul
Cinema," and "GPT-2" as the models to target, but the only model
identifier confirmed in the public API guide is
`higgsfield-ai/soul/standard`. Whether/how "Banana Pro" and "GPT-2" map
to real API model identifiers is **UNKNOWN** — not guessed here, and not
something this stage attempts to resolve, since doing so would mean
either guessing (forbidden) or querying the live API/dashboard (out of
scope — would mean calling a real endpoint).

**Because of this gap alone, the real Higgsfield API is NOT verified
sufficiently to connect**, independent of this stage's explicit
instruction not to connect any provider regardless.

## Part 10 — EvoLink

Not modified. EvoLink remains the video provider
(`providers/evolink/`). Nothing in this investigation found evidence
that EvoLink exposes an image-generation model — the skills investigated
here are all Higgsfield-targeted, not EvoLink-targeted. If EvoLink is
ever confirmed (from EvoLink's own primary docs) to offer a suitable
image model, it would be recorded as a possible *additional* future
image provider, evaluated on its own — never as a replacement for
investigating Higgsfield, and not connected in this stage either way.

## Part 11 — Security

No API key, environment variable dump, or credential was requested,
printed, or logged anywhere in this investigation or its code. No `env`,
`printenv`, or `set` command was run. See the Final Report's safety
search section for the grep-verified proof.

## Part 15 — Final decision

**RECOMMENDED ARCHITECTURE: C** (Claude Code → MCP → Node backend →
skill execution bridge → Image → Asset), **with the "skill execution
bridge" honestly implemented as a human-in-the-loop step today**, not a
fully automated one — because that is what the installed skills actually
support (Part 1/2). Architecture B (direct Node → Image API) remains the
right long-term shape *once* a real provider's API is fully verified
(Part 9 found Higgsfield's is only partially verified, with the
Banana-Pro/Soul-Cinema/GPT-2 model-identifier gap being the blocker).

- **Why:** the installed skills are prompt-writers, not executors — no
  installed skill can be invoked programmatically today, by Claude Code
  or by Node. Any architecture that assumes automatic Skill→Image
  execution today would be fiction.
- **Skill execution location:** a human, operating Higgsfield's own web
  UI, following the text prompt the skill (via Claude Code) produced.
- **Image provider:** none connected. Higgsfield is the only candidate
  identified, and its model-identifier mapping for the skills' named
  tools (Banana Pro/Soul Cinema/GPT-2) is unverified.
- **Credential location:** N/A — no credential exists in this system for
  any image provider. If Higgsfield were ever connected, its API key
  would live in an environment variable read only by a new
  `providers/higgsfield/` module, exactly like `EVOLINK_API_KEY` today —
  never in a skill file, never logged.
- **How Claude Code invokes it:** it doesn't, today. Claude Code can call
  `prepare_keyframe_execution` to get everything needed to follow the
  skill's own prompt-writing workflow with a human.
- **How MCP controls it:** `prepare_keyframe_execution` is read-only and
  gate-checked; no execution tool exists. `run_fixture_keyframe_execution`
  exists solely to prove the downstream pipeline with a local fixture,
  and is itself fully gated by the same checks.
- **How approval is enforced:** identically to Stage 13B —
  `KEYFRAME_GENERATION_APPROVAL` plus the shared budget/unknown-cost
  policy plus package-staleness plus duplicate protection, all
  re-verified inside `keyframe-generation-service.js`, which both new
  functions call into rather than reimplementing.
- **How the generated image returns to the backend:** today, a human
  would need to supply the downloaded file/URL through a future ingestion
  tool (not built this stage, since it would only matter once a real
  provider is connected). The fixture path proves this step using the
  existing `fake-image` provider instead.
- **How it is archived:** `services/asset-archive-service.js` (Stage
  9A), unchanged, exactly as Stage 13B already uses it.
- **How it becomes a reusable reference:** unchanged from Stage 13B —
  `approve_generated_keyframe` sets the asset's `approvalStatus` to
  `APPROVED`, at which point `keyframe-prompt-service.js`'s existing
  reference-reuse check picks it up automatically.
