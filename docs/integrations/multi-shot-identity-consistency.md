# Multi-Shot Identity Consistency Experiment (Stage 20)

**Status: three real, human-approved EvoLink generations, human-reviewed
outputs.** No result was auto-approved or made canonical. This document
records the experiment design, the raw results, a scored comparison across
Stage 18's dimensions, and an explicit, evidence-based classification.

## 1. Hypothesis

One approved canonical character reference asset, reused unchanged, can
maintain recognisable character identity across materially different
compositions, poses, environments, and cinematography — not merely across
repeated near-identical shots.

## 2. Experiment Objective

Answer: *"Can one approved canonical character reference maintain
recognisable character identity across materially different compositions,
poses, environments, and cinematography?"*

This is explicitly a small **production-quality experiment**, not a
statistical validation. Three shots is enough to observe a pattern; it is
not enough to prove a general guarantee.

## 3. Character Description

**"Kade"** — a fictional sentinel-scout character, deterministically
rendered via SVG + Playwright (same method as Stages 17/18/19; not a real
person, not AI-generated). Six distinctive, independently checkable
identity features, as required:

1. **Head/face geometry** — angular octagonal charcoal-grey head
2. **Hair/head ornament** — twin curved cyan antennae, symmetric
3. **Eye characteristics** — a single glowing yellow horizontal visor bar
   (no separate eyes)
4. **Clothing** — a deep crimson trench coat with two black diagonal
   straps crossing the chest
5. **Colour palette** — charcoal / cyan / crimson / yellow / silver
6. **Distinctive accessory** — a silver circular shoulder badge with a red
   five-point star, worn on the left chest

## 4. Canonical Reference Description

- Asset ID: `690f6daf-514b-4e31-98f0-3a019ea8c094`
- Approval status: `APPROVED`
- Canonical selection: explicit, via Stage 19's
  `selectCanonicalReferenceAsset` workflow (`selectedBy:
  "stage-20-operator"`) — never automatic
- Associated with `char-kade` via `addEntityReferenceAsset` before
  selection, per Stage 19's "must already be associated" rule

## 5. Shot 1 Configuration — PORTRAIT (baseline identity)

| Field | Value |
|---|---|
| Purpose | Establish baseline identity |
| Composition | Medium shot, centered, character facing camera directly, relatively simple background |
| Camera | Eye level, medium shot, static |
| Lighting | Soft cinematic lighting, gentle key light with soft fill, minimal shadow |
| Frame type | `CHARACTER_REFERENCE` |

## 6. Shot 2 Configuration — ACTION (pose/movement pressure)

| Field | Value |
|---|---|
| Purpose | Test identity under pose and movement change |
| Composition | Full body, dynamic diagonal composition, off-centre framing, motion emphasis |
| Camera | Dynamic low angle, slight Dutch tilt, full body, wider lens |
| Lighting | Strong directional side lighting, harder shadows, higher contrast than Shot 1 |
| Movement | Mid-lunge, coat flaring, forward momentum — genuinely different pose from Shot 1 |
| Frame type | `ACTION_FRAME` |

## 7. Shot 3 Configuration — CINEMATIC ENVIRONMENT (environmental/cinematographic pressure)

| Field | Value |
|---|---|
| Purpose | Test identity under environmental and cinematographic pressure |
| Composition | Wide shot, environmental context dominates, three-quarter rear view |
| Camera | Wider camera distance, elevated three-quarter rear angle |
| Lighting | Cool, moody, atmospheric, volumetric fog — distinct from Shots 1 and 2 |
| Atmosphere | Thick industrial fog/haze |
| Character orientation | Walking away, **not facing camera** |
| Frame type | `ESTABLISHING_FRAME` |

## 8. Exact Prompts

All three share **identical** IDENTITY/WARDROBE/CONTINUITY text, sourced
only from the Visual Bible/Identity Lock — never hand-varied per shot.

**Shot 1:**
```
SUBJECT:
Kade, a charcoal-plated sentinel-scout with cyan antennae and a glowing yellow visor, standing in a simple studio portrait pose facing the camera

IDENTITY:
Preserve the established facial structure, hairstyle, skin characteristics, and body proportions defined for Kade (Character char-kade). Identity lock: must always have the angular octagonal charcoal head, twin curved cyan antennae, the single glowing yellow horizontal visor bar, the crimson trench coat with black diagonal straps, and the silver star badge

WARDROBE:
Use the established wardrobe for Kade: a deep crimson trench coat with two black diagonal straps crossing the chest.

ACTION:
Kade stands facing the camera directly, arms at sides, calm and alert.

COMPOSITION:
medium shot, centered, character facing camera directly, relatively simple background

CAMERA:
eye level, medium shot, static; framing: centered medium shot, headroom balanced

LIGHTING:
soft cinematic lighting, gentle key light with soft fill, minimal shadow

COLOUR:
preserve the charcoal, cyan, crimson, yellow, and silver colour scheme exactly

CONTINUITY:
Character Kade: colour scheme (charcoal/cyan/crimson/yellow/silver) must remain consistent across every shot
```

**Shot 2** (identical IDENTITY/WARDROBE block, different SUBJECT/ACTION/COMPOSITION/CAMERA/LIGHTING):
```
SUBJECT:
Kade, a charcoal-plated sentinel-scout with cyan antennae and a glowing yellow visor, captured mid-motion in a dynamic full-body action pose

ACTION:
Kade lunges forward mid-stride in a dynamic action pose, coat flaring behind, one arm extended forward, caught in motion.

COMPOSITION:
full body, dynamic diagonal composition, off-centre framing, motion emphasis

CAMERA:
dynamic low angle, slight Dutch tilt, full body; framing: wide enough to show the full body and coat motion; lens: wider lens for dynamic full-body action; movement: mid-lunge, coat flaring from movement, forward momentum

LIGHTING:
strong directional side lighting, harder shadows, higher contrast than Shot 1

CONTINUITY:
Character Kade: colour scheme (charcoal/cyan/crimson/yellow/silver) must remain consistent across every shot; Previous shot in scene: "Establish baseline identity: controlled portrait" — maintain visual continuity with it.
```

**Shot 3** (identical IDENTITY/WARDROBE block, different SUBJECT/ACTION/COMPOSITION/CAMERA/LIGHTING/ATMOSPHERE):
```
SUBJECT:
Kade, a charcoal-plated sentinel-scout with cyan antennae and a glowing yellow visor, walking away through a foggy industrial corridor, seen from a three-quarter rear angle, not facing the camera

ACTION:
Kade walks away from camera through a foggy industrial corridor, seen mostly from the side and back, three-quarter rear view, not facing camera.

COMPOSITION:
wide shot, environmental context dominates the frame, character smaller in frame than Shots 1-2, three-quarter rear view

CAMERA:
wider camera distance, elevated three-quarter rear angle; framing: wide environmental framing with the corridor extending into depth

LIGHTING:
cool, moody, atmospheric lighting with volumetric fog, distinct from the soft portrait light and the hard action light

CONTINUITY:
Character Kade: colour scheme (charcoal/cyan/crimson/yellow/silver) must remain consistent across every shot; Previous shot in scene: "Test identity under pose and movement change: dynamic action" — maintain visual continuity with it.
```

## 9. Model / Provider

`provider: evolink-image`, `model: gemini-3-pro-image-preview` — identical
for all three generations.

## 10. Reference Configuration

The **same** canonical reference asset (`690f6daf-514b-4e31-98f0-3a019ea8c094`)
was uploaded to EvoLink **once** and reused for all three generations —
never re-uploaded, never swapped, no additional reference images
introduced. Pre-flight verified before any generation: `GET` on the
uploaded URL returned HTTP 200, `image/png`, content-length 21,980 bytes —
byte-exact match to the source file.

## 11. Budget

- Available credits before the experiment: 524.14 (user-side), confirmed
  via the read-only credits endpoint — no generation call made to check
  this.
- Human safety cap: **60 credits**, covering all three generations
  combined. This is an authorization ceiling, not a provider price
  estimate — EvoLink documents no pre-submission quote, consistent with
  every prior stage's finding.
- Budget was reconciled after every single generation before the next was
  submitted (sequential execution, never parallel).

## 12. Actual Reserved Costs

| Shot | Reserved cost | Cumulative | Remaining of 60 |
|---|---:|---:|---:|
| 1 — Portrait | 8.5866 | 8.59 | 51.41 |
| 2 — Action | 8.5866 | 17.18 | 42.82 |
| 3 — Cinematic Environment | 8.5866 | 25.77 | 34.23 |

Budget was never blocked; all three generations completed within the cap
with a wide margin remaining (34.23 credits unused).

## 13. Results

Three images, delivered separately alongside this document: the source
canonical reference, and the three generated shots.

- **Shot 1 (Portrait):** medium shot, facing camera, soft lighting —
  matches the requested composition closely.
- **Shot 2 (Action):** dynamic full-body lunge, coat flaring, harder
  directional light — a genuinely different pose and lighting setup from
  Shot 1, as required.
- **Shot 3 (Cinematic Environment):** wide, three-quarter rear view,
  walking away through a foggy industrial corridor — genuinely different
  environment, camera distance, and orientation from Shots 1 and 2.

## 14. Identity Scoring Table

Scored 0–5 per dimension by direct visual comparison against the source
reference. Subjective visual judgement — no automated similarity metric
was used (see Limitations).

| Dimension | Shot 1 | Shot 2 | Shot 3 |
|---|---:|---:|---:|
| Head/face geometry | 5 | 5 | 4 |
| Hair/head ornament | 5 | 5 | 5 |
| Clothing | 4 | 4 | 5 |
| Colour palette | 5 | 5 | 5 |
| Eyes/facial characteristics | 5 | 5 | 4 |
| Distinctive accessory | 5 | 5 | 2 |
| Silhouette | 5 | 5 | 5 |
| Overall identity resemblance | 5 | 4 | 4 |
| **TOTAL** | **39** | **38** | **34** |

- Maximum possible score: 40 per shot
- Shot 1: 39/40 (97.5%)
- Shot 2: 38/40 (95.0%)
- Shot 3: 34/40 (85.0%)
- **Average score: 37/40 (92.5%)**
- **Weakest dimension:** Distinctive accessory (5 + 5 + 2 = 12/15) — driven
  entirely by Shot 3, where the badge is on the character's front-left
  chest and the shot is a rear three-quarter view. The badge is not
  merely rendered poorly — it is **not visible at all** because it is
  behind the camera's line of sight, exactly as it would be for a real,
  physical character photographed from behind. This is evidence of
  spatially coherent rendering (the model didn't paint a badge floating on
  the character's back), not evidence of identity drift.
- **Strongest dimensions:** Hair/head ornament and Colour palette, both
  15/15 — the antennae and the five-colour palette held perfectly across
  all three lighting setups (soft studio, hard directional, cool
  atmospheric fog), which is the more meaningful signal for "does the
  reference actually survive different cinematography."
- **Identity degradation, Shot 1 → Shot 2:** −1 point (39 → 38, −2.6%) —
  minimal; the pose and lighting changed substantially but identity barely
  moved.
- **Identity degradation, Shot 1 → Shot 3:** −5 points (39 → 34, −12.8%) —
  larger, but concentrated almost entirely in one dimension (accessory
  visibility) that is explainable by camera geometry rather than by the
  reference losing influence over the character's rendering.

## 15. Lineage Verification

| Field | Shot 1 | Shot 2 | Shot 3 |
|---|---|---|---|
| Asset ID | `3da6c152-41e7-4a70-9486-55c7b98246df` | `c4815321-8c75-494d-a43e-d58b2eacc848` | `a95bac21-14e7-4c55-b377-99c25b5b7e27` |
| Generation ID | `036f596a-2423-42f9-9db7-6fa8745f431b` | `f18bb66a-4acf-4231-8407-f28c1ba3b681` | `3baf58cf-3012-4ed3-8d69-6140b03a2bbd` |
| Keyframe ID | `8f7dab14-8d14-484e-afd1-5e5af53da1a7` | `7c9470ae-b027-4f54-92f9-b924dd652285` | `58814d23-8e4d-4b84-ad42-ee3c0c5ffd5c` |
| Prompt package ID | `1e20b577-d573-4f9a-952a-e05d828a47b7` | `6d25c9ed-1307-42ba-8582-b60e725e7704` | `d478084e-c68d-4acd-93d3-67a93cf2ab2a` |
| Package version | 1 | 1 | 1 |
| Reference asset ID | `690f6daf-514b-4e31-98f0-3a019ea8c094` | `690f6daf-514b-4e31-98f0-3a019ea8c094` | `690f6daf-514b-4e31-98f0-3a019ea8c094` |
| Reference role | CHARACTER | CHARACTER | CHARACTER |
| Reference canonical? | true | true | true |
| Provider | evolink-image | evolink-image | evolink-image |
| Model | gemini-3-pro-image-preview | gemini-3-pro-image-preview | gemini-3-pro-image-preview |
| Reserved cost | 8.5866 | 8.5866 | 8.5866 |
| Approval status | NONE | NONE | NONE |
| Storage status | STORED | STORED | STORED |

**All three point back to the exact same canonical reference asset.**
Confirmed directly from each asset's own `references` array (not inferred)
— no divergence, no substitution, no additional reference introduced.

## 16. Operator Queue Result

After all three generations, `buildProjectQueue` reports:

| Keyframe | Category | Asset count | Approved count | Reference status |
|---|---|---:|---:|---|
| Shot 1 | `IMAGE_RETURNED` | 1 | 0 | `CANONICAL_AVAILABLE` |
| Shot 2 | `IMAGE_RETURNED` | 1 | 0 | `CANONICAL_AVAILABLE` |
| Shot 3 | `IMAGE_RETURNED` | 1 | 0 | `CANONICAL_AVAILABLE` |

Summary: `totalKeyframes: 3`, `needsAttention: 3`, `assetsAwaitingReview:
3`, `completionPercentage: 0`. No queue category logic was modified for
this experiment; the existing Stage 14/19 computation produced this
correctly from the real generation results with zero changes.
`getCanonicalReferenceAsset` confirms the canonical reference is still
`690f6daf-...` with an empty history — never replaced.

## 17. Limitations

- **n = 3 shots, one character, one reviewer.** This is a single small
  production experiment, explicitly not a statistically powered study.
  Three data points establish a pattern worth taking seriously; they do
  not establish a general guarantee for all characters, poses, or
  environments.
- **Subjective scoring**, same caveat as Stage 18 — no automated
  similarity metric was used.
- **The accessory-visibility drop in Shot 3 is a compositional
  consequence, not necessarily an identity failure** — but this
  interpretation is itself a judgement call. A stricter reading would
  simply say "the badge was not visible," full stop, and note that a
  production pipeline requiring accessory verification in every shot
  would need front/side coverage, not just rear angles.
- **One canonical reference image only** (a front-facing portrait-style
  illustration). Whether a reference that itself showed the character from
  multiple angles would perform even better at extreme angles like Shot 3
  is untested here.
- **Both non-reference and reference-conditioned generation were not
  directly compared in this stage** (that was Stage 18's job, on a
  different character). Stage 20 assumes reference conditioning helps
  (per Stage 18) and asks a different question: does ONE reference keep
  working across very different shots, which it does not by itself prove
  causation, only observe the outcome.

## 18. Conclusion

**Classification: STRONG CONSISTENCY.**

Across three genuinely different shots — a calm centered portrait under
soft light, a dynamic mid-air lunge under hard directional light, and a
distant three-quarter rear view walking through cool atmospheric fog —
the same single canonical reference asset produced a character that
remained immediately, confidently recognisable as Kade in every case.
Average score 37/40 (92.5%); the only shot to drop meaningfully below the
others (Shot 3, 34/40) did so almost entirely because of one dimension
(accessory) that was not visible from the requested camera angle, not
because the character's core identity markers (head geometry, antennae,
visor, coat, colour palette) degraded. The two dimensions most directly
tied to "does the reference still influence rendering under totally
different lighting and environment" — hair/head ornament and colour
palette — scored a perfect 15/15 across all three shots.

This is real, observed evidence that a single canonical reference remains
useful across materially different production contexts within this
pipeline. It is not proof that this will hold for every character, every
pose, or an unlimited number of shots — see Limitations.

## 19. Recommendation

1. **Treat one canonical reference as production-viable** for a shot list
   that varies pose, lighting, and environment, based on this experiment's
   evidence — but continue requiring human review before any generated
   asset is approved or made canonical, exactly as this experiment did.
2. **For shots that need to verify a specific accessory or detail**,
   ensure the shot's camera angle can actually see it, or accept that
   detail can't be confirmed from that angle — this is a shot-planning
   consideration, not a pipeline defect.
3. **A future stage**, if pursued, could test: (a) more characters, (b)
   more shots per character for a less anecdotal sample, (c) an automated
   similarity metric alongside human scoring, and (d) whether a
   multi-angle reference set (not just one image) improves extreme-angle
   shots like Shot 3's rear view.
4. Do not relax the human-review/human-canonical-selection requirement on
   the strength of this one experiment — three shots is encouraging
   evidence, not a basis for automation.

## Safety Verification

- Real image generation calls this stage: **exactly 3** (Portrait, Action,
  Cinematic Environment)
- Automatic retries: **0**
- Real video generation calls: **0**
- Credits spent (reserved): 25.7598 (3 × 8.5866), against a 60-credit
  human safety cap — never approached, no overage
- API key: never logged, printed, or exposed anywhere in this stage
- Canonical reference asset (`690f6daf-...`): unchanged, still `APPROVED`,
  still canonical, history empty (never replaced)
- All three generated assets: `approvalStatus: NONE` — none auto-approved
- Operator Queue: correctly reports 3× `IMAGE_RETURNED`,
  `approvedAssetCount: 0`, `referenceStatus: CANONICAL_AVAILABLE` for all
  three, with zero queue-logic changes
- Original production smoke-test project
  (`9b6a78b3-7238-4469-8280-5c4281216343`): verified byte-identical
  (`status: CALIBRATION`, `reserved: 100.45`, `blocked: true`, unchanged)
- Full test suite: 855/855 passing, unchanged from before this stage (no
  test files were added or modified — this stage made no production code
  changes, only used the existing, already-tested Stage 16-19 pipeline)
