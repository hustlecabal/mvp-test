# Skill Orchestration Layer

Stage 11B. The thin coordination layer between our Creative IR (Stage
11A) and the Claude skills audited before this stage. This stage
establishes *contracts* — it does not execute anything.

```
USER
 ↓
CREATIVE ARTIFACTS        (Creative Brief -> Master Spec -> Visual Bible -> Storyboard, Stage 11A)
 ↓
CLAUDE ORCHESTRATOR        (Claude Code — reads artifacts, picks a skill, supplies context)
 ↓
SPECIALIST SKILL           (e.g. video-prompt-builder — writes a prompt, doesn't generate media)
 ↓
ADAPTER                    (translates the skill's raw output into our canonical shape)
 ↓
NORMALIZED CREATIVE ARTIFACT
 ↓
HUMAN REVIEW
 ↓
KEYFRAME
 ↓
VIDEO
```

This stage builds everything through **ADAPTER**. Everything below
"HUMAN REVIEW" is future work — no keyframe system, no execution, no
generation.

## Why Claude is the orchestrator

The read-only skill audit that preceded this stage found something
important: **no audited skill is an orchestrator.** Every one of them
(`video-prompt-builder`, `cinema-worldbuilder-pro-2.0`,
`banana-pro-director-2.0`, `UGC Decoder`, `UGC Builder`) is a
**specialist** — it takes a description and hands back a prompt for a
human (or another tool) to run. `brand-video-editor` is an **editor** —
it works on already-existing footage. None of them read our Creative IR,
none of them know our storyboard shape, and none of them decide which of
the *other* skills to use for a given shot.

That coordination job — "given this storyboard shot, which specialist
should write its prompt, and how do I turn that specialist's answer into
something our system understands" — has to be done by something that can
read our project data AND reason about which skill fits. That's Claude
Code, not a skill and not our Node backend (see the execution boundary
below).

## Why Node is not the AI agent

The Node application (`server/`) is our **production state and execution
layer** — it persists projects, generation jobs, assets, budgets, and
(as of Stage 11A) creative artifacts, and it's the only thing allowed to
actually call EvoLink. It has no language model in it, and this stage
does not add one. `services/skill-orchestrator.js` and everything under
`services/skill-adapters/` are **plain, deterministic JavaScript** —
static data lookups, string parsing, and object shaping. There is no
"call Claude from Node" code anywhere in this stage, and there shouldn't
be: that would blur the one boundary this whole architecture depends on.

### The execution boundary, stated precisely

```
Claude Code:
    reads project artifacts (via the MCP creative-planning tools, Stage 11A)
    ↓
    chooses a skill (via list_creative_skills / get_skill_compatibility, or its own judgment)
    ↓
    supplies skill context (runs the skill itself, in its own environment)
    ↓
    receives the skill's raw output
    ↓
    [future stage] runs it through the matching adapter, gets a normalized result
    ↓
    calls MCP update tools (update_storyboard, etc.) to persist the result
    ↓
Node backend persists artifacts
```

Node never invokes a skill. Claude Code never has direct filesystem
access to `server/data/`. The MCP tools are the only door between them,
and (this stage) that door currently only opens one way — read-only skill
discovery. No `execute_skill` tool exists yet.

## What a specialist skill is

A **SPECIALIST** produces creative planning output — a prompt, a shot
list, a production package — but never generates an image or video
itself and never calls a provider. `video-prompt-builder` and
`cinema-worldbuilder-pro-2.0` are both specialists: their entire job ends
with handing back text. This is exactly why they're safe to build
adapters for at this stage — there is no generation risk to gate.

An **EDITOR** (`brand-video-editor`) works on already-existing media,
and can trigger real rendering/generation behind its own explicit gates.
It has a registry entry (so the orchestrator knows it exists) but no
adapter yet — it belongs to a later, post-production stage.

## What an adapter is

An adapter (`services/skill-adapters/*.js`) is a pure function:
`adapt(input, context) → normalizedResult`. It takes our structured data
(e.g. a storyboard shot) plus the raw text a skill produced
(`context.skillOutputText` — supplied by the caller; **the adapter never
runs the skill itself**), and returns a normalized result. Every adapter
declares, per Part 2 of this stage:

- `requiredInputs` — what our `input` object must contain
- `supportedOutputs` — what `outputType` values it can produce
- `unsupportedFields` — what it deliberately does *not* translate

If a required input is missing, the adapter throws an
`AdapterValidationError` immediately — it never guesses or silently
proceeds with partial data.

## What normalized creative data means

Every adapter returns the same shape (`services/skill-adapters/adapter-contract.js`'s
`createNormalizedResult`):

```js
{
  skillId,           // which skill produced this
  sourceArtifact,    // what our data this was built from (e.g. "storyboardShot")
  outputType,        // e.g. "shot-prompt", "cinematic-shot-prompt"
  content,           // the RAW specialist output — preserved as-is
  structuredData,     // OUR normalized representation
  warnings,          // anything the adapter couldn't cleanly translate
  generatedAt,
}
```

`content` and `structuredData` are kept **deliberately separate**.
`content` is evidence — useful for a human to double-check the adapter
did its job correctly, or to re-parse later if the adapter improves — but
it is never treated as the source of truth. Only `structuredData` is
meant to ever be written back into our Creative IR (via a future stage's
`update_storyboard` call), and only after a human has reviewed it.

## Why platform-specific syntax must stay outside our canonical IR

`cinema-worldbuilder-pro-2.0`'s prompts embed Higgsfield-specific
`@image1`, `@image2`, … tags — instructions to *Higgsfield's own UI* about
which uploaded reference image anchors where. That syntax means nothing
to EvoLink, to a human reading our storyboard later, or to any other
platform we might target in the future. If it leaked into
`storyboardShot.referenceAssets` as a literal string, our canonical data
would silently become coupled to one specific external tool's UI
conventions.

`services/skill-adapters/cinema-worldbuilder-adapter.js` handles this by
translating `@imageN` occurrences into `referenceAssets: [{ index, descriptor }]`
entries (matched against the skill's own "attach these in order" list) and
**stripping the tags themselves** from every structured text field. It
also runs a runtime self-check — if `@image` ever appears anywhere in
`structuredData` after that translation, the adapter throws rather than
returning silently-contaminated data. That guarantee is directly tested
(see `server/test/skill-adapters.test.js`).

## Why we are not executing skills automatically yet

Per Part 9 of this stage: the orchestrator must not automatically call
multiple skills, modify creative artifacts, generate prompts or media, or
submit anything to EvoLink. Only three read-only MCP tools exist
(`list_creative_skills`, `get_creative_skill`, `get_skill_compatibility`)
— no `execute_skill` tool. The reasoning is simple: an adapter's contract
should be proven correct against real skill output *before* anything is
allowed to call it automatically. Two adapters exist and are fully
tested against fixtures; the next stage, after this one is reviewed, is
what would actually wire "Claude runs a skill → adapter normalizes it →
MCP tool persists it" into one flow.

## How this eventually feeds the storyboard/keyframe workflow

A future stage will let Claude Code: read a storyboard shot via
`get_storyboard`, use `get_skill_compatibility`/`recommendSkill()`-equivalent
reasoning to pick a specialist, actually run that skill, pass its output
through the matching adapter here, review the normalized result, and call
`update_storyboard`/`create_storyboard_shot` to save the reviewed prompt
back onto the shot (in `promptDraft` and the structured camera/movement/
lighting fields it already has, per Stage 11A). Only after a human
approves that plan does the existing Stage 3/8.1 approval/budget gate and
`request_generation` ever get involved — completely unchanged by
anything in this stage.
