# Creative Production Contract (Milestone 2)

**Status: implemented (canonical data model + structural validation only — no production run).** Extends `schemas/creative-schema.js`'s existing Storyboard/Visual Bible family additively. Does not fork it, does not touch `schemas/production-schema.js`'s Timeline IR, and does not touch the separate Editorial Spine (`schemas/story-argument-schema.js`/`schemas/story-structure-schema.js`, Tasks B–E of the prior milestone).

## 1. Phase 0 audit finding — three pre-existing, disconnected object families

Before this milestone, the repository already had:

1. **Timeline IR** (`production-schema.js`) — the real executable layer: `Scene`/`Shot`/`Asset`/`GenerationJob`. A `Shot` assumes exactly one generation call — the concrete gap this milestone's `GenerationUnit` split fixes.
2. **Storyboard / Visual Bible** (`creative-schema.js`) — the creative-planning layer: `Character`/`Location`/`Prop` (each with a canonical-reference-asset pattern) and `VisualBible`/`Storyboard`/`StoryboardScene`/`StoryboardShot`. Its own header already documented that it is not yet connected to Timeline IR. **This is the closest existing match to the milestone's requested hierarchy** (Character/Location/Prop with stable ids and canonical references; `StoryboardShot` already had camera/framing/lens/movement/lighting fields and a bare `narrativeBeat` string) and is the family this milestone extends.
3. **Editorial Spine** (`story-argument-schema.js`/`story-structure-schema.js`) — strategy/story-argument intelligence, connects straight to production via `beat-graph-derivation-service.js`, has no Character/Location/Prop or camera vocabulary at all. Left untouched.

An earlier, ad hoc "Project Contract" pass (this session, prior to this milestone) lived only in scratch space and duplicated a thinner version of what `creative-schema.js` already had. It is superseded by this milestone; nothing from it was carried into the repository.

## 2. What was added (all additive — see each field's own comment in `creative-schema.js`)

- `CONTRACT_VERSION`, `MAX_GENERATION_UNIT_DURATION_SECONDS` (10, hard), `PREFERRED_GENERATION_UNIT_DURATION_RANGE` (3–8), `GENERATION_METHODS`, `CONTINUATION_STRATEGIES`.
- `createCharacterState`/`createLocationState`/`createPropState`/`createCameraState`/`createFrameState` — the Frame State Contract (Section 4), reused identically inside `GenerationUnit.startState`/`endState`.
- `createGenerationUnit` — the atomic ≤10s request, sitting between `StoryboardShot` and a future `production-schema.js` `GenerationJob`.
- `createNarrativeBeat` — promoted from `StoryboardShot.narrativeBeat` (kept, unchanged, as a legacy string field) into a real linkable object.
- `createSequence` — groups scenes into a narrative movement; no prior equivalent existed.
- `Character`/`Location`/`Prop.stateTimeline` — delta-only, fold-forward snapshots keyed by `sceneId` (see `resolveStateAtScene` in the validator). A snapshot only sets the fields that changed; unset fields carry forward from the last snapshot that set them — never silently reset, never restated in full every scene.
- `VisualBible` gained the handful of fields `Section 12 (Visual System)` asked for that weren't already covered by its existing `camera`/`composition`/`lighting`/`colour`/`textureMaterials`/`atmosphere` fields: `genre`, `lensLanguage`, `cameraMovementLanguage`, `depthOfFieldLanguage`, `grain`, `transitionLanguage`, `typography`. No separate `VisualSystem` object was created.
- `StoryboardScene` gained `locationId`/`characterIds`/`propIds`/`narrativeBeatIds` — the authoritative per-scene cast/prop/location list a shot's own references must be a subset of.
- `StoryboardShot` gained `narrativeBeatIds`, `characterStates`, `blocking`, `atmosphere`, `emotionalIntent`, `transitionIn`/`transitionOut`, `generationUnitIds`, `stale`/`staleReason`. `duration`/`purpose`/`action`/`sceneId` remain the required core; everything new is optional/derived.
- `Storyboard` gained `sequenceIds`.

Not built as new objects, by design (smallest-coherent-model test, Section applies to each):
- **VisualSystem** — folded into `VisualBible` (see above).
- **AudioTimeline** — reuses the existing `scriptRefId` join convention (`narration-schema.js`/`audio-schema.js`) plus their existing `startTime`/timing fields.
- **ContinuityGraph** — derived, not stored (`deriveContinuityGraph` in the validator), from the stable-id references the schema already carries.

## 3. Structural validation (`services/creative-production-contract-validator.js`)

Deterministic checks only (Section 15/17): GenerationUnit duration > 10s, invalid `generationMethod`/`continuationStrategy`, dangling character/location/prop/generationUnit references, shot references a character/prop its scene doesn't declare, GenerationUnit with the wrong parent shot, duplicate/impossible unit ordering, incompatible sequential frame continuity, dangling start/end frame asset references (when a known-asset set is supplied), and a GenerationUnit state referencing a character its shot never declared. Returns every violation found (a report), never a first-failure gate.

`resolveStateAtScene(stateTimeline, sceneId, sceneOrder)` folds a delta-only timeline forward. `deriveContinuityGraph`/`findDownstreamOfCharacterChange` answer "what depends on this" from existing references — no graph database.

**Explicitly not attempted here** (Section 18): identity drift, wardrobe drift, camera plausibility, lighting/environment continuity, shot purpose, B-roll relevance — anything requiring subjective judgment. See `services/creative-qa-interface.js` for that contract's formal (unimplemented) shape.

## 4. Invalidation (Section 16)

No change to `SHOT_PLANNING_STATUSES` (a shared enum with real existing consumers — too risky to widen for this). Instead, `stale`/`staleReason` were added additively to `StoryboardShot` and `GenerationUnit`. Nothing is auto-deleted; `findDownstreamOfCharacterChange` reports affected objects for a caller to mark.

## 5. OpenMontage boundary (Section 20)

No OpenMontage integration exists in this repository. `services/openmontage-adapter-interface.js` defines only the attachment point (`compile(canonicalProject) -> OpenMontageProductionPackage`) — no implementation, never called from anywhere yet.

## 6. Skill ownership (Section 13/14)

| Canonical field | Owning specialist |
|---|---|
| `VisualBible.world`, narrative canon | Story Bible Builder (produces prose; an extraction step into these fields is a future milestone) |
| `Character.identityConstraints`, `wardrobe`, `stateTimeline` wardrobe entries, `referenceAssets`/canonical reference history | Character Builder / Banana Pro Director 3.0 (their own "re-lock" versioning is the same pattern `canonicalReferenceHistory` already models) |
| `Location`/`Prop` reference assets, scene plates | Banana Pro Director 3.0 (Mode 3 — scene plates) |
| `StoryboardShot.camera`/`framing`/`lens`/`movement`, `GenerationUnit.startState`/`endState`/`promptDraft` | Cinema Director (its own "Last Frame" and "Cross-Frame Rules" blocks map directly onto the Frame State Contract) |

Skill output is never canonical automatically — the standing rule (`SKILL OUTPUT → VALIDATE → ORCHESTRATOR WRITES PROJECT STATE`) is unchanged.

## 7. Backward compatibility

Every new field defaults to `null`/`[]`/`false`. An existing `Character`/`Location`/`Prop`/`Storyboard`/`StoryboardShot` record loaded through these same factories is unaffected — no migration required. `test/p0-4a-blueprint-storyboard-contract.test.js`'s exact-field-set regression tests were updated to include the new field names (the old fields are all still present, unchanged).
