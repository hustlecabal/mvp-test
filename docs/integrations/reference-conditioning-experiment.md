# Reference-Conditioning A/B Experiment (Stage 18)

**Status: one controlled paired trial, real EvoLink calls, human-reviewed.**
No result was auto-approved or made canonical. This document records the
experiment design, the raw results, a scored comparison, and an explicit
separation between what was *observed*, what was *measured*, and what can
honestly be *concluded* about causality.

## Hypothesis

An approved reference image, passed to EvoLink's `image_urls` field
alongside a Keyframe Prompt Package's derived prompt, materially improves
character identity consistency compared with the same prompt and model
with no reference image.

## Experiment Design

Stage 17 validated that the reference pipeline works end-to-end, but its
one real call included a reference from the start — it could not isolate
whether the reference *itself* was doing anything the text prompt wasn't
already doing on its own. This stage closes that gap with a genuine
paired comparison: **the prompt, model, and every generation parameter
are held identical between two trials; the only variable is the presence
of the reference image.**

- **Character:** "Miro" — a fresh, deterministic, locally-rendered
  fictional character (SVG + Playwright, same method as Stage 17's
  "Zek"), not a real person, not AI-generated. Chosen specifically for
  checkable, unusual identity features: a diamond-shaped head, a single
  curved off-centre horn, heterochromia eyes, a two-tone caped outfit
  with a graphic trim, and a distinct pendant accessory.
- **One Keyframe Prompt Package**, built once, reused verbatim for both
  trials (guarantees byte-identical prompt text — no risk of
  accidentally writing a more detailed prompt for one trial).
- **Trial A (control):** `providerName: 'evolink-image'`, same prompt,
  `imageParameters: { model, size: 'auto', quality: '1K' }` — **no**
  `referenceImageUrls`.
- **Trial B (reference):** identical call, **plus**
  `referenceImageUrls: [{ assetId, url }]` pointing at the same approved,
  pre-uploaded, pre-flight-verified reference image.
- Both trials generated against the same keyframe (two separate
  generation attempts, exactly as Stage 16's "calling generateKeyframe
  again... creates a genuinely new attempt" already supports) — never two
  different keyframes, which would have risked prompt drift.

## Model

`gemini-3-pro-image-preview` (EvoLink) — identical for both trials.

## Exact Prompt (identical for both trials, verbatim)

```
SUBJECT:
Miro, a small forest-spirit mascot character, standing in a simple studio portrait pose facing the camera

IDENTITY:
Preserve the established facial structure, hairstyle, skin characteristics, and body proportions defined for Miro (Character char-miro). Identity lock: must always have the diamond-shaped indigo head, the single curved lime-green horn off-centre right, heterochromia eyes (copper left, lime green right), the copper cape with lime-green zigzag trim, and the round deep-red pendant with a white cross

WARDROBE:
Use the established wardrobe for Miro: a copper-orange cape with a lime-green zigzag trim along its edge, deep indigo tunic underneath.

ACTION:
Miro stands facing the camera, arms at sides, in a simple studio portrait pose.

COMPOSITION:
centered portrait, plain neutral grey background

CAMERA:
medium shot, eye level, straight-on

LIGHTING:
even, soft studio lighting

COLOUR:
preserve the deep indigo, copper, lime green, and deep red colour scheme exactly

CONTINUITY:
Character Miro: colour scheme (deep indigo/copper/lime green/deep red) must remain consistent
```

## Control Configuration (Trial A)

| Field | Value |
|---|---|
| Provider | `evolink-image` |
| Model | `gemini-3-pro-image-preview` |
| Reference images | **none** |
| Generation ID | `b3883b7c-b9b9-40ee-8e0f-8c33fa0a3cf5` |
| EvoLink task ID | `task-unified-1786517266-ek2yqr1k` |
| Reserved cost | 8.5156 credits |
| Archived asset ID | `cce93dc8-02e2-4638-912d-d0a24d99a582` |
| Status | `COMPLETED` |

## Reference Configuration (Trial B)

| Field | Value |
|---|---|
| Provider | `evolink-image` |
| Model | `gemini-3-pro-image-preview` |
| Reference asset ID | `f1f32fda-cece-4bf4-bb7d-ebf3cb1ea97b` (roleType `CHARACTER`) |
| Reference URL (EvoLink-hosted, pre-flight verified HTTP 200 / `image/png` / byte-exact 27,622 bytes) | `https://files.evolink.ai/0045VXK3HXJ31OWPKP/images/png/f1f32fda-cece-4bf4-bb7d-ebf3cb1ea97b.png` |
| Generation ID | `e5ca5812-069c-49c2-9718-5bd6a751ec94` |
| EvoLink task ID | `task-unified-1786517323-foviwmxe` |
| Reserved cost | 8.5866 credits |
| Archived asset ID | `1b8f5b4d-2f13-48f5-b945-96245117cb1d` |
| Status | `COMPLETED` |

**A note on the `references` lineage field:** both trials' archived assets
record `references: ["f1f32fda-..."]` in our own database. This reflects
the keyframe's *associated* reference asset for lineage purposes — it is
populated from the prompt package regardless of whether that reference
was actually transmitted to EvoLink. What was actually **sent to the
provider** is the authoritative signal, and it differed exactly as
intended: Trial A's submitted request body had no `image_urls` field at
all (confirmed — `job.parameters` for Trial A contains only `{model,
size, quality}`, no `referenceImageUrls`); Trial B's did. This distinction
matters and is called out explicitly so the lineage field is never
mistaken for proof of what reached the provider.

## Results

Reference images below (delivered separately): the source reference,
Trial A's control output, and Trial B's reference-conditioned output.

### Scoring Table

Each dimension scored 0–5 by direct visual comparison against the source
reference image. Scoring is my own subjective visual judgement — no
automated image-similarity model was used (see Limitations).

| Dimension | Control (A) | Reference (B) | Difference |
|---|---:|---:|---:|
| 1. Head/face geometry | 2 | 4 | +2 |
| 2. Hair/head ornament (horn) | 2 | 4 | +2 |
| 3. Clothing (cape + trim) | 3 | 4 | +1 |
| 4. Colour palette | 4 | 5 | +1 |
| 5. Eyes/facial characteristics | 4 | 5 | +1 |
| 6. Distinctive accessory (pendant) | 4 | 4 | 0 |
| 7. Overall silhouette | 2 | 4 | +2 |
| 8. Overall identity resemblance | 3 | 4 | +1 |
| **Total** | **24** | **34** | **+10** |

- **Control total:** 24 / 40
- **Reference total:** 34 / 40
- **Absolute improvement:** +10 points
- **Percentage improvement:** +41.7% relative to the control total

### What each score is based on (brief, per dimension)

1. **Head geometry** — the reference is a sharp, flat-edged rhombus. Trial
   A softened this into a rounded, generic "toy head" shape. Trial B kept
   sharp, angular planes much closer to the reference's actual geometry.
2. **Horn** — the reference horn is a single thin blade in one smooth
   curve. Trial A's horn curls more like a ram's horn (a plausible but
   different reading of "curved horn" in text). Trial B's horn is a
   single smooth curve, closely matching the reference's specific shape.
3. **Clothing** — both got the colours and zigzag trim; Trial B's trim
   placement (right at the shoulder line) matches the reference more
   precisely than Trial A's (trim also runs along the lower hem, which
   the reference doesn't show).
4. **Colour palette** — both are close; Trial B is marginally more
   saturated/accurate, especially the red pendant.
5. **Eyes** — both preserved the correct heterochromia (orange left, lime
   right) — itself notable since this is an unusual, easy-to-flip detail.
   Trial B's eyes are rounder, closer to the reference's perfect circles;
   Trial A's are more oval/cartoon-styled.
6. **Pendant** — both included the object correctly; scored identically.
7. **Silhouette** — the prompt requested a "centered portrait." Trial A
   ignored this and rendered a full standing figure with visible legs.
   Trial B respected the portrait framing and a narrower build closer to
   the reference's slim proportions.
8. **Overall resemblance** — Trial B is a materially closer visual match
   on nearly every axis without contradicting the shared text prompt.

## Provider Metadata Signal

EvoLink's task response exposes no explicit "reference used: yes/no"
field — its fields are limited to `id`/`object`/`model`/`status`/
`progress`/`results`/`usage` (unchanged from Stage 15/16's findings). But
one *quantifiable, objective* signal is present: **reserved cost**. Trial
A (no reference) reserved 8.5156 credits — the exact same figure as
Stage 16's earlier no-reference call on a different character. Trial B
(with reference) reserved 8.5866 credits — the exact same figure as
Stage 17's earlier with-reference call. This consistency (not a
coincidence across two unrelated characters and sessions) is real,
measured evidence that EvoLink's own systems register and price the
reference image as a genuine additional input, not a field that's
silently ignored.

## Observed vs. Measured vs. Causal — kept explicitly separate

- **Observed:** side-by-side visual inspection shows Trial B is
  noticeably closer to the reference image than Trial A, particularly in
  head geometry, horn shape, eye roundness, and overall framing/silhouette.
- **Measured:** the 8-dimension scoring gives Control 24/40 vs. Reference
  34/40 — a +10 point (+41.7%) difference. This is a subjective visual
  score, not an algorithmic metric; a different human rater could score
  it differently, though the direction (B closer than A) is unambiguous
  to the eye.
- **Causal:** because model, prompt, and every other parameter were held
  identical between the two trials — the only variable was the presence
  of the reference image — this experiment is a genuine controlled
  comparison, unlike Stage 17's single uncontrolled trial. The
  improvements observed are concentrated in exactly the kind of detail
  text alone under-specifies (the precise curve of a horn, the roundness
  of an eye, the exact framing crop) rather than in details the text
  prompt spelled out explicitly (colours, presence of a pendant) — where
  both trials scored similarly. That pattern is consistent with the
  reference image genuinely conditioning the output beyond the text.
  **However, this is one paired trial (n=1 per condition).** A single
  comparison cannot rule out ordinary generation-to-generation stochastic
  variance — it is possible a second no-reference attempt would, by
  chance, land closer to the reference, or a second reference-conditioned
  attempt further away. **The experiment provides real, directionally
  consistent evidence that reference conditioning improves identity
  consistency; it does not, on its own, statistically prove it.**

## Limitations

- **n = 1 per condition.** No repeated trials to characterize
  run-to-run variance. A properly powered experiment would run each
  condition multiple times.
- **Subjective scoring.** All 16 dimension-scores were assigned by visual
  judgement, not an automated similarity metric (e.g. embedding distance,
  a vision-model-based scorer). This introduces rater bias, even with an
  attempt at rigor.
- **EvoLink exposes no explicit reference-usage flag** in its task
  response — the only provider-side corroboration is the reserved-cost
  pattern, which is suggestive, not definitive proof that the reference
  pixels (rather than, say, just its presence as an attached file) were
  used in the model's reasoning.
- **Single character, single pose/composition.** Results may not
  generalize to other character types, poses, or compositions (e.g. an
  action pose, multiple characters, an environment reference instead of
  a character reference).
- **The reference-conditioned image is still an interpretation, not a
  reproduction.** Even Trial B diverges from the source in real ways
  (3D-toy rendering style vs. the reference's flat vector style, a more
  rounded torso, a visible pendant cord not in the reference) — "closer"
  is not "identical," and should not be read as such.

## Conclusion

This controlled, paired experiment found that adding an approved
reference image — with the prompt, model, and every other parameter held
identical — produced a keyframe that scored materially closer to the
source character across 6 of 8 checkable identity dimensions (2 tied, 0
worse), for a +10 point (+41.7%) improvement in total score. The
improvement concentrated specifically in geometric/stylistic details the
text prompt did not pin down precisely, which is the pattern one would
expect if the reference image is genuinely being used as visual
conditioning rather than merely attached and ignored. This is real,
directionally consistent evidence in favor of the hypothesis — but it
comes from a single paired trial, scored subjectively, on one character.

## Recommendation for the Next Stage

Reference conditioning is worth relying on for production keyframes
where identity consistency matters, but this single experiment is not a
sufficient basis to treat it as fully proven or to relax human review. A
reasonable next step (not undertaken in this stage, and requiring its own
explicit authorization and budget):

1. **Repeat this exact design 2–3 more times** (same character, same
   prompt, same model) to see whether the direction and magnitude of the
   improvement holds, or was partly a single-sample artifact.
2. **Try a second, unrelated character** to check the result isn't
   specific to Miro's particular geometry.
3. Consider an **automated similarity metric** (e.g. an embedding-based
   image comparator) as a second, less subjective scoring method
   alongside human visual review.
4. Continue requiring human review before canonical selection regardless
   of reference use — this experiment is evidence the reference *helps*,
   not evidence that unattended automatic approval would ever be safe.

## Safety Verification

- Real image generation calls this stage: **exactly 2** (1 control + 1
  reference)
- Automatic retries: **0**
- Real video generation calls: **0**
- Credits spent (reserved): 17.1022 (8.5156 + 8.5866), against a 40-credit
  human safety cap — never exceeded, no overage
- API key: never logged, printed, or exposed anywhere in this stage
- Reference asset (`f1f32fda-...`) approval status: unchanged, still
  `APPROVED`
- Both generated assets: `approvalStatus: NONE` — neither auto-approved
- Keyframe `canonicalAssetId`: `null` — nothing auto-selected as canonical
- Operator Queue: correctly reports `IMAGE_RETURNED`, `assetCount: 2`,
  `approvedAssetCount: 0` for this keyframe, with zero queue-logic changes
- Original production smoke-test project
  (`9b6a78b3-7238-4469-8280-5c4281216343`): verified byte-identical
  (`status: CALIBRATION`, `reserved: 100.45`, `blocked: true`, unchanged)
- Full test suite: 772/772 passing, unchanged from before this stage (no
  test files were added or modified — this stage made no production code
  changes, only used the existing, already-tested Stage 16/17 pipeline)
