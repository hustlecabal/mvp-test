# Production State Machine

Every project has a `status` field (introduced in Stage 2, already
`"PLANNING"` by default). This document defines the full set of states it
can move through, and the rules for which moves are legal.

Code: `server/schemas/state-machine.js`.

## How this connects to the approval/budget gate

Three states — `CALIBRATION`, `KEYFRAME_GENERATION`, `MOTION_GENERATION` —
are **generation states**: the only points where the system would actually
call a paid provider and spend credits. The state machine does not
re-implement approval or budget logic — it calls the existing gate
(`services/approval-gate.js`, built in Stage 3) via `gate.canProceed(project)`
before allowing entry into any generation state. If the gate says no, the
transition is refused and the project's status does not change.

## The states

| State | Meaning | Allowed | Prohibited | Approval required? | Can move to |
|---|---|---|---|---|---|
| `PLANNING` | Project just created, nothing decided yet. | Setting title/topic, initial notes. | Any generation. | No. | `RESEARCH` |
| `RESEARCH` | Gathering facts and background for the topic. | Filling in `research`. | Any generation. | No. | `CREATIVE_REVIEW` |
| `CREATIVE_REVIEW` | Human reviews research and creative direction so far. | Reading/reviewing. | Any generation. | Human review decision (approve → move on, reject → back to research). | `SCRIPTING`, `RESEARCH` |
| `SCRIPTING` | Writing the script from the approved direction. | Filling in `script`, `story`. | Any generation. | No. | `SCRIPT_REVIEW` |
| `SCRIPT_REVIEW` | Human reviews the script. | Reading/reviewing. | Any generation. | Human review decision. | `VISUAL_DEVELOPMENT`, `SCRIPTING` |
| `VISUAL_DEVELOPMENT` | Defining the visual bible, characters, locations. | Filling in `visualBible`, `characters`, `locations`. | Any generation. | No. | `VISUAL_REVIEW` |
| `VISUAL_REVIEW` | Human reviews the visual direction. | Reading/reviewing. | Any generation. | Human review decision. | `STORYBOARD`, `VISUAL_DEVELOPMENT` |
| `STORYBOARD` | Breaking the script into scenes and shots. | Filling in `scenes`, `shots` (prompts, composition, etc. — no generation yet). | Any generation. | No. | `GENERATION_REVIEW` |
| `GENERATION_REVIEW` | Human reviews the full storyboard and shot plan before anything is generated or spent. | Reading/reviewing, requesting approval via the gate. | Any generation. | **Yes** — this is where a human should call the gate's approval/budget endpoints (Stage 3) before continuing. | `CALIBRATION`, `STORYBOARD` |
| `CALIBRATION` | A small, cheap test generation to sanity-check prompts/settings before committing to a full batch. | Calling a provider for a limited test. | Skipping the gate. | **Yes — gate-enforced.** | `KEYFRAME_GENERATION`, `GENERATION_REVIEW` |
| `KEYFRAME_GENERATION` | Generating still keyframes for approved shots. | Calling a provider for keyframes. | Skipping the gate. | **Yes — gate-enforced.** | `KEYFRAME_REVIEW` |
| `KEYFRAME_REVIEW` | Human reviews generated keyframes. | Reading/reviewing, approving/rejecting individual assets. | Any further generation. | Human review decision. | `MOTION_GENERATION`, `KEYFRAME_GENERATION` |
| `MOTION_GENERATION` | Animating approved keyframes into video. | Calling a provider for motion/video. | Skipping the gate. | **Yes — gate-enforced.** | `FINAL_REVIEW` |
| `FINAL_REVIEW` | Human reviews the assembled video. | Reading/reviewing. | Any generation. | Human review decision. | `COMPLETE`, `MOTION_GENERATION` |
| `COMPLETE` | The project is finished. | Nothing further. | Everything — this is a terminal state. | N/A | *(none — terminal)* |

"Approval required? — gate-enforced" means the *code itself* refuses the
transition unless `gate.canProceed(project)` returns `allowed: true`. Other
"human review decision" states are conceptual checkpoints — the state
machine allows moving forward or backward, but doesn't yet force a
particular review step to happen through the API (that's future work, once
there's a frontend or MCP tool actually driving these transitions).

## Review states can send work backward

Most states only move forward. The five `*_REVIEW` states (plus
`GENERATION_REVIEW`) can also send the project back one step if the human
reviewing it isn't satisfied — e.g. `SCRIPT_REVIEW` can return to
`SCRIPTING` for a rewrite. This mirrors how creative review actually works:
approve and move on, or send it back for another pass.

## What this stage does *not* do

- It does not add any new API endpoints for triggering transitions — the
  state machine is a library (`schemas/state-machine.js`) ready to be
  called from a future endpoint, MCP tool, or the frontend.
- It does not call EvoLink, MCP, or any creative skill.
- It does not change how `PATCH /projects/:id` validates `status` — that
  endpoint still accepts any string, same as Stage 2. Enforcing the state
  machine's rules on that endpoint is a reasonable next step, but wasn't
  part of this stage's scope.
