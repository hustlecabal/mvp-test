// pre-production-gate-service.js
//
// INT-2.5 — the PRE-PRODUCTION QUALITY GATE evaluator. Sits immediately
// after an APPROVED CreativeBlueprint (INT-2) and before Storyboard/
// BeatGraph production work. Answers "is this creative plan sufficiently
// complete, coherent, evidence-aligned, and technically producible to
// justify spending downstream production effort?" — never "will this
// video perform well?" No numerical score anywhere in this file.
//
// READ-ONLY AGAINST EVERY UPSTREAM ARTIFACT. This file never mutates a
// CreativeBlueprint, RecommendationSet, Recommendation, PatternSet,
// ObservationSet, Measurements, ReferenceVideo, or VisualBible record —
// it only READS them and writes its own new PreProductionGateResult via
// pre-production-gate-store.js. It never imports keyframe-generation-
// service.js, video-generation-service.js, generated-new-executor.js, any
// provider adapter, Apify, Anthropic, OpenAI, FFmpeg, Whisper, or TTS —
// confirmed by this file's own require() list below, and enforced by a
// dedicated security-boundary test.
//
// REUSE, NEVER DUPLICATE (spec Step 2): detectStructuralContradiction()
// and resolveEntityReference() are imported directly from
// creative-blueprint-service.js, never reimplemented. Every diagnostic
// INT-2 already computed and stored on the Blueprint at build time
// (MISSING_CONCEPT/MISSING_CORE_PROMISE/INVALID_ENTITY_REFERENCE/
// INVALID_RECOMMENDATION_PROVENANCE/CREATIVE_BRIEF_MISMATCH) is either
// directly re-derived from the Blueprint's own still-present fields
// (concept/corePromise/targetDuration — never dropped) or copied through
// from blueprint.diagnostics (continuityRequirements/recommendation
// decisions that failed validation are DROPPED by INT-2 before storage,
// so their diagnostic is the only surviving record of that failure — it
// cannot be honestly recomputed from the filtered Blueprint alone).
//
// FREE-TEXT HEURISTICS ARE WARNING-ONLY, NEVER BLOCKING (spec Part 2C,
// LOCKED): every check in this file that reads a free-text strategy field
// (visualStrategy, narrationStrategy, pacingStrategy, visualDirection)
// produces, at most, a WARNING. The one BLOCKER this file can produce for
// a genuinely unsupported production capability
// (UNSUPPORTED_CAPABILITY_NO_FALLBACK) is derived ONLY from a real,
// structured BeatGraph resolution (materialResolutionService.resolveBeatGraph
// — real hard-gate results, not a keyword guess) — never from text
// matching. When no BeatGraph is supplied, this blocker cannot fire at
// all, matching spec Part 2B's explicit instruction to "never pretend
// per-beat feasibility was evaluated."
//
// REJECT vs REVISE (spec Part 2D): a fixed, small set of blocker codes is
// classified REJECT-tier (structural, not locally fixable without
// reconsidering the underlying creative/production approach:
// CONTRADICTORY_STRUCTURE, UNSUPPORTED_CAPABILITY_NO_FALLBACK). Every
// other blocker code is REVISE-tier (a specific, locally fixable defect).
// machineAssessment is REJECT if any REJECT-tier blocker is present,
// REVISE if any REVISE-tier blocker is present (and no REJECT-tier one
// is), PROCEED otherwise. This is a deterministic function of the blocker
// code set alone — never a subjective judgment call embedded in code.

const projectStore = require('./project-store');
const creativeBlueprintStore = require('./creative-blueprint-store');
const recommendationStore = require('./recommendation-store');
const creativeStore = require('./creative-store');
const preProductionGateStore = require('./pre-production-gate-store');
const creativeBlueprintService = require('./creative-blueprint-service');
const materialResolutionService = require('./material-resolution-service');
const generationModelRegistry = require('./generation-model-registry');
const { VISUAL_TREATMENTS } = require('../schemas/visual-beat-schema');
const {
  GATE_ASSESSMENT_VALUES,
  HUMAN_DECISION_VALUES,
  createGateFinding,
  createGateInformation,
  createPreProductionGateResult,
} = require('../schemas/pre-production-gate-schema');

function blocker(code, message, category) {
  return createGateFinding({ code, message, category });
}
function warning(code, message, category) {
  return createGateFinding({ code, message, category });
}
function info(code, message) {
  return createGateInformation({ code, message });
}

// ---------------------------------------------------------------------------
// Part 8 (spec) — production capability, MECHANICALLY DERIVED from the
// real, existing source-of-truth constants rather than a second, hand-
// copied table. Pulls TREATMENT_TO_ASSET_TYPES/DETERMINISTIC_TREATMENTS
// straight from material-resolution-service.js's own exports and
// VISUAL_TREATMENTS straight from visual-beat-schema.js's own export — if
// either changes, this table changes with it, which is exactly what the
// drift-detection regression test (pre-production-gate-service.test.js)
// exists to prove.
// ---------------------------------------------------------------------------
function deriveVisualTreatmentCapability(treatment) {
  // HYBRID is hand-audited, not mechanically derivable from any single
  // enum: video-assembly-service.js's own real, confirmed limitation is
  // that only the PRIMARY layer of a compiled beat is composited into the
  // final MP4 (OVERLAY/BACKGROUND/INSERT are real MaterialResolution
  // output but excluded via ASSEMBLY_LAYER_UNSUPPORTED) — no enum
  // anywhere expresses "which layers actually make it into the video."
  if (treatment === 'HYBRID') return 'PARTIALLY_SUPPORTED';
  const hasAssetReuse = (materialResolutionService.TREATMENT_TO_ASSET_TYPES[treatment] || []).length > 0;
  const hasDeterministicTemplate = materialResolutionService.DETERMINISTIC_TREATMENTS.includes(treatment);
  // generated-new-executor.js is registered for exactly two executorTypes
  // (GENERATED_NEW_STILL_IMAGE, GENERATED_NEW_VIDEO — schemas/material-
  // execution-schema.js), which correspond to exactly these two
  // VISUAL_TREATMENTS values. Hand-audited (no single exported constant
  // enumerates "which treatments the GENERATED_NEW bridge covers" today),
  // documented here rather than silently assumed.
  const hasGeneratedNewBridge = treatment === 'STILL_IMAGE' || treatment === 'AI_VIDEO';
  const hasBrollPath = treatment === 'BROLL_CLIP';
  if (hasAssetReuse || hasDeterministicTemplate || hasGeneratedNewBridge || hasBrollPath) return 'SUPPORTED';
  return 'UNSUPPORTED';
}

const VISUAL_TREATMENT_CAPABILITY = Object.fromEntries(VISUAL_TREATMENTS.map((t) => [t, deriveVisualTreatmentCapability(t)]));

// Part 8/15 (spec) — free-text recognition only, WARNING-tier only (Part
// 2C, locked). A miss here means UNKNOWN, never SUPPORTED — matching Part
// 21's "unknown never silently becomes PASS" rule at the text-scanning
// layer specifically. Hand-maintained (no schema enum represents "this
// free-text phrase implies this treatment") — documented as such, not
// mechanically derived, unlike VISUAL_TREATMENT_CAPABILITY above.
const VISUAL_TREATMENT_KEYWORDS = {
  STILL_IMAGE: /\b(still image|static frame|photograph)\b/i,
  AI_VIDEO: /\b(ai[- ]generated video|generated video clip|ai video)\b/i,
  BROLL_CLIP: /\b(b-roll|stock footage|archival footage)\b/i,
  MOTION_GRAPHIC: /\b(motion graphic|data visuali[sz]ation|animated chart)\b/i,
  KINETIC_TYPOGRAPHY: /\b(kinetic typography|animated text|kinetic text)\b/i,
  WHITEBOARD: /\b(whiteboard|sketch reveal|hand[- ]drawn animation)\b/i,
  HYBRID: /\b(hybrid|composite of|layered composition|multiple material types)\b/i,
};

// Hand-audited known gaps (spec Part 8's own explicit UNSUPPORTED list) —
// no VISUAL_TREATMENTS value represents either concept, so they cannot be
// reached via VISUAL_TREATMENT_KEYWORDS above at all. Surfaced as
// UNKNOWN_CAPABILITY (never a blocker — Part 2C) because a keyword match
// alone does not prove the Blueprint's eventual beats will actually
// contain one.
const KNOWN_UNSUPPORTED_PHRASES = {
  'transitions between scenes': /\b(crossfade|wipe transition|transition (effect|between))\b/i,
  'multi-character dialogue animation / lip-sync': /\b(lip[- ]sync|animated dialogue|animated conversation between|character dialogue animation)\b/i,
};

function scanTextForCapabilitySignals(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];
  for (const [treatment, pattern] of Object.entries(VISUAL_TREATMENT_KEYWORDS)) {
    if (!pattern.test(text)) continue;
    const capability = VISUAL_TREATMENT_CAPABILITY[treatment];
    if (capability === 'SUPPORTED') continue;
    if (capability === 'PARTIALLY_SUPPORTED') {
      findings.push(warning('PARTIALLY_SUPPORTED_CAPABILITY', `Text mentions "${treatment}", which is only PARTIALLY_SUPPORTED (non-PRIMARY layers are not composited into the final video by video-assembly-service.js) — could not be deterministically confirmed as fully producible.`, 'VISUAL_FEASIBILITY'));
    } else {
      findings.push(warning('UNKNOWN_CAPABILITY', `Text mentions "${treatment}", which this gate classifies ${capability} — could not be deterministically confirmed as producible from Blueprint text alone.`, 'VISUAL_FEASIBILITY'));
    }
  }
  for (const [label, pattern] of Object.entries(KNOWN_UNSUPPORTED_PHRASES)) {
    if (pattern.test(text)) {
      findings.push(warning('UNKNOWN_CAPABILITY', `Text appears to reference "${label}", a known gap in the current production pipeline — could not be deterministically confirmed as producible from Blueprint text alone.`, 'VISUAL_FEASIBILITY'));
    }
  }
  return findings;
}

// Part 9 (spec) — deterministic category -> Blueprint strategy field map,
// reusing INT-1F's own real observation/pattern category vocabulary
// (confirmed against real data during the INT-2.5 audit: TIMING,
// STRUCTURE, SHOT_RHYTHM, PACING, NARRATION, OPENING, OPENING_STRUCTURE,
// SILENCE, VISUAL_CHANGE, TEXT_PRESENCE, SPEECH_DENSITY, CO_OCCURRENCE).
// A category mapping to `null` is never evaluated (no guess is better
// than an invented one) — TIMING and CO_OCCURRENCE have no single
// unambiguous Blueprint field to check against and are left unevaluated
// here rather than assigned an arbitrary field.
const CATEGORY_TO_STRATEGY_FIELD = {
  OPENING: 'hookStrategy',
  OPENING_STRUCTURE: 'hookStrategy',
  PACING: 'pacingStrategy',
  SHOT_RHYTHM: 'pacingStrategy',
  STRUCTURE: 'narrativeStrategy',
  NARRATION: 'narrationStrategy',
  SPEECH_DENSITY: 'narrationStrategy',
  SILENCE: 'narrationStrategy',
  VISUAL_CHANGE: 'visualStrategy',
  TEXT_PRESENCE: 'visualStrategy',
  TIMING: null,
  CO_OCCURRENCE: null,
};

// Part 10 (spec) — narrow, documented category-opposition table. Fires
// only on ACCEPT/EDIT decisions whose SOURCE RECOMMENDATIONS' categories
// land on opposite sides of one of these pairs. Never a general semantic
// contradiction engine.
const OPPOSING_CATEGORY_PAIRS = [
  ['PACING', 'SILENCE'],
  ['SHOT_RHYTHM', 'SILENCE'],
  ['PACING', 'NARRATION'],
  ['SHOT_RHYTHM', 'NARRATION'],
];

const FAST_PACING_PATTERN = /\b(fast|rapid|quick|snappy|high[- ]energy)\b/i;
const SLOW_PACING_PATTERN = /\b(slow|reflective|deliberate|unhurried|measured|contemplative)\b/i;

// ---------------------------------------------------------------------------
// Individual dimension checks. Each returns { blockers: [], warnings: [] }.
// ---------------------------------------------------------------------------

// Dimension A (Completeness) + I (Structural feasibility). Concept/
// corePromise/targetDuration are re-derived directly from the Blueprint's
// own still-present fields (never dropped/filtered by INT-2, so a live
// recheck is honest and cheap). Structural contradiction is re-derived by
// CALLING creative-blueprint-service.js's own detectStructuralContradiction()
// directly — reused, never reimplemented.
function checkCompletenessAndStructure(blueprint) {
  const blockers = [];
  if (!blueprint.concept || String(blueprint.concept).trim().length === 0) {
    blockers.push(blocker('MISSING_CONCEPT', 'concept is required', 'COMPLETENESS'));
  }
  if (!blueprint.corePromise || String(blueprint.corePromise).trim().length === 0) {
    blockers.push(blocker('MISSING_CORE_PROMISE', 'corePromise is required', 'COMPLETENESS'));
  }
  if (blueprint.targetDuration === null || blueprint.targetDuration === undefined) {
    blockers.push(blocker('MISSING_TARGET_DURATION', 'targetDuration is required', 'COMPLETENESS'));
  } else if (typeof blueprint.targetDuration !== 'number' || !Number.isFinite(blueprint.targetDuration) || blueprint.targetDuration <= 0) {
    blockers.push(blocker('INVALID_TARGET_DURATION', `targetDuration "${blueprint.targetDuration}" must be a positive number of seconds`, 'COMPLETENESS'));
  }
  const contradiction = creativeBlueprintService.detectStructuralContradiction(blueprint.targetDuration, blueprint.structuralDirection);
  if (contradiction) {
    blockers.push(blocker('CONTRADICTORY_STRUCTURE', contradiction.message, 'STRUCTURAL_FEASIBILITY'));
  }
  return { blockers, warnings: [] };
}

// Dimension H (Continuity) + E-adjacent CREATIVE_BRIEF_MISMATCH. These
// diagnostics were computed by INT-2 against inputs (raw
// continuityRequirements before filtering, the linked CreativeBrief) that
// are no longer independently available on the filtered, persisted
// Blueprint — copying them through from blueprint.diagnostics is the only
// faithful way to represent them, never silently dropped (spec Part 5).
function checkCopiedThroughBlueprintDiagnostics(blueprint) {
  const blockers = [];
  const warnings = [];
  for (const d of blueprint.diagnostics || []) {
    if (d.code === 'INVALID_ENTITY_REFERENCE') {
      warnings.push(warning('INVALID_ENTITY_REFERENCE', d.message, 'CONTINUITY'));
    } else if (d.code === 'CREATIVE_BRIEF_MISMATCH') {
      warnings.push(warning('CREATIVE_BRIEF_MISMATCH', d.message, 'AUDIENCE_CONTEXT'));
    } else if (d.code === 'INSUFFICIENT_EVIDENCE_RECOMMENDATION') {
      // P0 Hardening (finding C) — a human's ACCEPT/EDIT of a recommendation
      // below INT-1E's minimum evidence threshold is dropped by INT-2's own
      // buildCreativeBlueprintDraft() (the decision never enters
      // recommendationDecisions), but the diagnostic IS recorded there.
      // Copied through here as a BLOCKER — the same "gate is the stricter
      // layer" precedent already applied to INVALID_RECOMMENDATION_PROVENANCE
      // just above. Without this, a human's evidence-based decision could be
      // silently dropped while both layers report clean.
      blockers.push(blocker('INSUFFICIENT_EVIDENCE_RECOMMENDATION', d.message, 'EVIDENCE_ALIGNMENT'));
    }
  }
  return { blockers, warnings };
}

// Dimension D (Evidence alignment). INDEPENDENT re-verification against
// the REAL RecommendationSet supplied to the gate (never trusting
// blueprint.diagnostics alone, and never inventing a missing id — spec
// Part 5D). Also re-checks the RecommendationSet's own identity actually
// matches what the Blueprint claims it was built from.
function checkRecommendationProvenance(blueprint, recommendationSet) {
  const blockers = [];
  // PRODUCTION UNBLOCK, Part 2 — creator-led Blueprint, no RecommendationSet
  // to check provenance against. Not applicable, never a fabricated pass.
  if (!recommendationSet) return { blockers, warnings: [] };
  if (recommendationSet.id !== blueprint.recommendationSetId || recommendationSet.projectId !== blueprint.projectId) {
    blockers.push(blocker('INVALID_RECOMMENDATION_PROVENANCE', `the supplied RecommendationSet ("${recommendationSet.id}") does not match this Blueprint's own recommendationSetId ("${blueprint.recommendationSetId}")`, 'EVIDENCE_ALIGNMENT'));
    return { blockers, warnings: [] };
  }
  const byId = new Map((recommendationSet.recommendations || []).map((r) => [r.id, r]));
  for (const decision of blueprint.recommendationDecisions || []) {
    if (!byId.has(decision.recommendationId)) {
      blockers.push(blocker('INVALID_RECOMMENDATION_PROVENANCE', `recommendationDecision references recommendationId "${decision.recommendationId}", which does not resolve in RecommendationSet "${recommendationSet.id}"`, 'EVIDENCE_ALIGNMENT'));
    }
  }
  // Also surface the same finding INT-2 itself already recorded (a
  // decision that was REJECTED-at-Blueprint-build-time for bad
  // provenance never appears in recommendationDecisions at all, so the
  // loop above cannot see it — copied through here so it is never lost).
  for (const d of blueprint.diagnostics || []) {
    if (d.code === 'INVALID_RECOMMENDATION_PROVENANCE') {
      blockers.push(blocker('INVALID_RECOMMENDATION_PROVENANCE', d.message, 'EVIDENCE_ALIGNMENT'));
    }
  }
  return { blockers, warnings: [] };
}

// Dimension C (Strategic alignment) + K (rework risk: DEFER) + L (open
// questions). WARNING-only by construction — never claims a recommendation
// WAS implemented, only that alignment "could not be deterministically
// verified" when the relevant field is empty (spec Part 9's own required
// phrasing).
function checkRecommendationAlignmentAndReworkRisk(blueprint, recommendationSet) {
  const warnings = [];
  // PRODUCTION UNBLOCK, Part 2 — creator-led Blueprint: no accepted
  // recommendations exist to check alignment/rework-risk against, so
  // blueprint.recommendationDecisions is necessarily empty and this loop
  // has nothing to do — but openQuestions is still a real, independent
  // Blueprint field worth checking regardless of RecommendationSet
  // presence, so this function does not early-return entirely.
  const byId = recommendationSet ? new Map((recommendationSet.recommendations || []).map((r) => [r.id, r])) : new Map();

  for (const decision of blueprint.recommendationDecisions || []) {
    if (decision.decision === 'DEFER') {
      warnings.push(warning('DEFERRED_RECOMMENDATION_DECISION', `recommendation "${decision.recommendationId}" was explicitly DEFERred — left unresolved, may become expensive rework if not revisited before production`, 'REWORK_RISK'));
      continue;
    }
    if (decision.decision !== 'ACCEPT' && decision.decision !== 'EDIT') continue;
    const recommendation = byId.get(decision.recommendationId);
    if (!recommendation) continue; // already reported as INVALID_RECOMMENDATION_PROVENANCE above
    const field = CATEGORY_TO_STRATEGY_FIELD[recommendation.category];
    if (field === undefined || field === null) continue; // no unambiguous field to check — never guess
    const value = blueprint[field];
    if (!value || String(value).trim().length === 0) {
      warnings.push(warning('RECOMMENDATION_ALIGNMENT_UNVERIFIED', `Accepted recommendation "${decision.recommendationId}" (category "${recommendation.category}") — alignment could not be deterministically verified: Blueprint's own "${field}" is empty.`, 'STRATEGIC_ALIGNMENT'));
    }
  }

  if (Array.isArray(blueprint.openQuestions) && blueprint.openQuestions.length > 0) {
    warnings.push(warning('OPEN_QUESTION_UNRESOLVED', `${blueprint.openQuestions.length} open question(s) remain unresolved on this Blueprint`, 'REWORK_RISK'));
  }

  return { blockers: [], warnings };
}

// Dimension B (Coherence, partial) — Part 11 conflict detection.
function checkRecommendationConflicts(blueprint, recommendationSet) {
  const warnings = [];
  // PRODUCTION UNBLOCK, Part 2 — creator-led Blueprint: no
  // RecommendationSet, so blueprint.recommendationDecisions is necessarily
  // empty and acceptedOrEdited below will simply be []. Not a fabricated
  // pass — there is genuinely nothing to check conflicts between.
  const byId = recommendationSet ? new Map((recommendationSet.recommendations || []).map((r) => [r.id, r])) : new Map();
  const acceptedOrEdited = (blueprint.recommendationDecisions || [])
    .filter((d) => d.decision === 'ACCEPT' || d.decision === 'EDIT')
    .map((d) => byId.get(d.recommendationId))
    .filter(Boolean);

  // Same-category, same-derivation, multiple accepted RECURRING_PATTERN_
  // APPLICATION recommendations implying mutually exclusive structural
  // choices for the SAME slot (e.g. two different accepted "opening"
  // patterns).
  const byCategory = new Map();
  for (const rec of acceptedOrEdited) {
    if (rec.recommendationType !== 'RECURRING_PATTERN_APPLICATION') continue;
    if (!byCategory.has(rec.category)) byCategory.set(rec.category, []);
    byCategory.get(rec.category).push(rec);
  }
  for (const [category, recs] of byCategory) {
    if (recs.length > 1) {
      warnings.push(warning('RECOMMENDATION_CONFLICT', `${recs.length} accepted recommendations share category "${category}" (ids: ${recs.map((r) => r.id).join(', ')}) — may imply mutually exclusive structural choices for the same creative slot.`, 'RECOMMENDATION_CONFLICT'));
    }
  }

  // Documented pacing/rhythm vs narration/silence opposition.
  for (const [catA, catB] of OPPOSING_CATEGORY_PAIRS) {
    const sideA = acceptedOrEdited.filter((r) => r.category === catA);
    const sideB = acceptedOrEdited.filter((r) => r.category === catB);
    if (sideA.length > 0 && sideB.length > 0) {
      warnings.push(warning('RECOMMENDATION_CONFLICT', `Both "${catA}" (ids: ${sideA.map((r) => r.id).join(', ')}) and "${catB}" (ids: ${sideB.map((r) => r.id).join(', ')}) recommendations were accepted — a documented opposition pair that may represent conflicting creative direction.`, 'RECOMMENDATION_CONFLICT'));
    }
  }

  return { blockers: [], warnings };
}

// Dimension B (Coherence, partial) — deterministic free-text pacing check.
function checkPacingCoherence(blueprint) {
  const warnings = [];
  const pacingText = blueprint.pacingStrategy || '';
  const narrationPacingText = (blueprint.narrationDirection && blueprint.narrationDirection.pacingIntent) || '';
  if (!pacingText || !narrationPacingText) return { blockers: [], warnings };
  const pacingFast = FAST_PACING_PATTERN.test(pacingText);
  const pacingSlow = SLOW_PACING_PATTERN.test(pacingText);
  const narrationFast = FAST_PACING_PATTERN.test(narrationPacingText);
  const narrationSlow = SLOW_PACING_PATTERN.test(narrationPacingText);
  if ((pacingFast && narrationSlow) || (pacingSlow && narrationFast)) {
    warnings.push(warning('PACING_DIRECTION_CONFLICT', `pacingStrategy ("${pacingText}") and narrationDirection.pacingIntent ("${narrationPacingText}") appear to describe opposite pacing — could not be deterministically resolved; a human should confirm intent.`, 'COHERENCE'));
  }
  return { blockers: [], warnings };
}

// Dimension G (Narration feasibility).
function checkNarrationFeasibility(blueprint) {
  const warnings = [];
  const nd = blueprint.narrationDirection;
  if (!nd) return { blockers: [], warnings };
  const hasDirectionIntent = Boolean((nd.voiceRole && nd.voiceRole.trim()) || (nd.deliveryCharacter && nd.deliveryCharacter.trim()));
  if (hasDirectionIntent && !nd.voiceProfile) {
    warnings.push(warning('NARRATION_DIRECTION_INCOMPLETE', 'narrationDirection specifies a voiceRole/deliveryCharacter but no voiceProfile has been validated — narration direction may be incomplete.', 'NARRATION_FEASIBILITY'));
  }
  if (nd.voiceProfile) {
    const requiredKeys = ['genderPresentation', 'ageImpression', 'accent', 'language', 'speakingStyle', 'emotionalTone', 'energy', 'pace', 'pitch', 'deliveryNotes'];
    const malformed = requiredKeys.some((k) => typeof nd.voiceProfile[k] !== 'string');
    if (malformed) {
      warnings.push(warning('INVALID_VOICE_PROFILE', 'narrationDirection.voiceProfile does not match the expected VoiceProfile shape (schemas/audio-schema.js).', 'NARRATION_FEASIBILITY'));
    }
  }
  return { blockers: [], warnings };
}

// Dimension F (Visual feasibility) — free-text only, WARNING-tier only.
function checkVisualFeasibilityFromText(blueprint) {
  const warnings = [
    ...scanTextForCapabilitySignals(blueprint.visualStrategy),
    ...scanTextForCapabilitySignals(blueprint.visualDirection),
    ...scanTextForCapabilitySignals(blueprint.narrationStrategy),
  ];
  return { blockers: [], warnings };
}

// Dimension J (Production complexity) — reuses INT-2's own already-
// computed, already-stored productionConsiderations verbatim (never
// recomputed, never turned into a numeric score).
function checkProductionComplexity(blueprint) {
  const warnings = (blueprint.productionConsiderations || []).map((p) => warning('HIGH_PRODUCTION_COMPLEXITY', p.note, 'PRODUCTION_COMPLEXITY'));
  return { blockers: [], warnings };
}

// Dimension F/L (BeatGraph-dependent) — the ONE place a genuinely
// structured, resolver-confirmed UNSUPPORTED finding can become a
// BLOCKER (never from free text — spec Part 2C). Only runs when a
// BeatGraph was actually supplied; otherwise this whole dimension is
// honestly UNKNOWN (spec Part 2B/L), never PASS.
function checkBeatGraphDerivedCapability(projectId, beatGraph) {
  if (!beatGraph) {
    return {
      blockers: [],
      warnings: [],
      information: [
        info('BEATGRAPH_UNAVAILABLE', 'No BeatGraph was supplied — per-beat production-capability confirmation and BeatGraph-derived cost signals are UNKNOWN, not evaluated, and not assumed to be fine.'),
        info('COST_STATUS', 'UNKNOWN — no BeatGraph was supplied, so no material-strategy counts exist to estimate from. Never treated as free/zero.'),
      ],
      costStatus: 'UNKNOWN',
    };
  }

  const resolution = materialResolutionService.resolveBeatGraph(projectId, beatGraph);
  const blockers = [];
  const warnings = [];
  const information = [info('BEATGRAPH_AVAILABLE', `BeatGraph supplied with ${resolution.summary.totalBeats} beat(s); ${resolution.summary.resolvedBeats} resolved, ${resolution.summary.unresolvedBeats} unresolved.`)];

  if (resolution.summary.unresolvedBeats > 0) {
    const reasons = resolution.summary.unresolvedReasons.map((r) => `beat "${r.beatId}" (${r.rejectedBy.join(', ')})`).join('; ');
    blockers.push(blocker('UNSUPPORTED_CAPABILITY_NO_FALLBACK', `${resolution.summary.unresolvedBeats} beat(s) have no viable material candidate under any MATERIAL_SOURCES: ${reasons}`, 'PRODUCTION_CAPABILITY'));
  }

  // Cost signal (spec Part 7) — ESTIMATED, never KNOWN (no real
  // per-Blueprint spend-linkage mechanism exists anywhere in this
  // codebase — confirmed during the INT-2.5 audit), never a monetary
  // figure. costTier distribution, computed the same way material-
  // resolution-service.js's own scoreCost() phase already does (via
  // generationModelRegistry.cheapestSatisfying), never re-derived
  // pricing logic of its own.
  const costTierCounts = {};
  for (const r of resolution.resolutions) {
    if (r.status !== 'RESOLVED' || !r.selectedMaterial || r.selectedMaterial.materialSource !== 'GENERATED_NEW') continue;
    const cheapest = generationModelRegistry.cheapestSatisfying(r.selectedMaterial.modelRequirements || {})[0];
    const tier = cheapest ? cheapest.costTier : 'UNPRICED';
    costTierCounts[tier] = (costTierCounts[tier] || 0) + 1;
  }
  information.push(
    info(
      'GENERATION_CANDIDATE_INFO',
      `estimatedGenerationCandidates: ${resolution.summary.estimatedGenerationCandidates}, zeroCostDeterministicCount: ${resolution.summary.zeroCostDeterministicCount}, costTier distribution: ${JSON.stringify(costTierCounts)} (costTier is human-assigned metadata, never a real monetary price).`
    )
  );
  information.push(info('COST_STATUS', 'ESTIMATED — derived from BeatGraph material-strategy counts and generation-model-registry costTier metadata; no real provider price quote exists for any model this system uses (confirmed: no pre-submission cost API).'));

  return { blockers, warnings, information, costStatus: 'ESTIMATED' };
}

// Part 4/Locked Decision D — REJECT-tier vs REVISE-tier blocker
// classification. A fixed, small, documented set of structural-only
// codes; every other blocker is a locally-fixable defect.
const REJECT_TIER_BLOCKER_CODES = new Set(['CONTRADICTORY_STRUCTURE', 'UNSUPPORTED_CAPABILITY_NO_FALLBACK']);

function determineAssessment(blockers) {
  if (blockers.some((b) => REJECT_TIER_BLOCKER_CODES.has(b.code))) return 'REJECT';
  if (blockers.length > 0) return 'REVISE';
  return 'PROCEED';
}

function buildReasoning(assessment, blockers, warnings) {
  const parts = [`Machine assessment: ${assessment}.`, `${blockers.length} blocker(s), ${warnings.length} warning(s).`];
  if (blockers.length > 0) {
    parts.push(`First blocker: [${blockers[0].code}] ${blockers[0].message}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------
function evaluatePreProductionGate(projectId, blueprintId, { beatGraph } = {}) {
  if (!projectStore.getProject(projectId)) {
    return { ok: false, reason: `no project found with id "${projectId}"` };
  }
  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId);
  if (!blueprint) {
    return { ok: false, reason: `no CreativeBlueprint found with id "${blueprintId}"` };
  }
  // PRODUCTION UNBLOCK, Part 2 — a creator-led Blueprint legitimately has
  // no recommendationSetId (never evidence-led at all); only require a
  // RecommendationSet to actually resolve when the Blueprint references
  // one. recommendationSet stays null otherwise, and the evidence-specific
  // checks below (checkRecommendationProvenance/AlignmentAndReworkRisk/
  // Conflicts) treat that as "not applicable", never as a fabricated pass.
  let recommendationSet = null;
  if (blueprint.recommendationSetId) {
    recommendationSet = recommendationStore.getRecommendationSet(projectId, blueprint.recommendationSetId);
    if (!recommendationSet) {
      return { ok: false, reason: `no RecommendationSet found with id "${blueprint.recommendationSetId}" (referenced by Blueprint "${blueprintId}")` };
    }
  }
  const visualBible = creativeStore.getVisualBible(projectId); // may be null — continuity checks below tolerate that (blueprint.continuityRequirements is already validated/filtered by INT-2)

  const blockers = [];
  const warnings = [];
  const information = [];

  if (blueprint.status !== 'APPROVED') {
    blockers.push(blocker('BLUEPRINT_NOT_APPROVED', `Blueprint status is "${blueprint.status}", not APPROVED — human strategy approval (INT-2) is a precondition for this gate.`, 'HUMAN_AUTHORITY'));
  }

  if (!recommendationSet) {
    information.push(info('NO_RECOMMENDATION_SET', 'This Blueprint has no linked RecommendationSet (creator-led — no reference-video evidence was used). Evidence provenance, alignment, and conflict checks are not applicable and were skipped.'));
  }

  for (const result of [
    checkCompletenessAndStructure(blueprint),
    checkCopiedThroughBlueprintDiagnostics(blueprint),
    checkRecommendationProvenance(blueprint, recommendationSet),
    checkRecommendationAlignmentAndReworkRisk(blueprint, recommendationSet),
    checkRecommendationConflicts(blueprint, recommendationSet),
    checkPacingCoherence(blueprint),
    checkNarrationFeasibility(blueprint),
    checkVisualFeasibilityFromText(blueprint),
    checkProductionComplexity(blueprint),
  ]) {
    blockers.push(...result.blockers);
    warnings.push(...result.warnings);
  }

  const beatGraphResult = checkBeatGraphDerivedCapability(projectId, beatGraph);
  blockers.push(...beatGraphResult.blockers);
  warnings.push(...beatGraphResult.warnings);
  information.push(...beatGraphResult.information);

  const decisionCounts = { ACCEPT: 0, REJECT: 0, EDIT: 0, DEFER: 0 };
  for (const d of blueprint.recommendationDecisions || []) {
    if (decisionCounts[d.decision] !== undefined) decisionCounts[d.decision] += 1;
  }
  information.push(info('RECOMMENDATION_DECISION_COUNTS', JSON.stringify(decisionCounts)));
  information.push(info('AUDIENCE_CONTEXT_STATUS', blueprint.targetAudience ? `targetAudience: "${blueprint.targetAudience}"` : 'targetAudience is unspecified — no Channel Bible exists in this system to supply it otherwise.'));
  if (blueprint.supersedesBlueprintId) {
    information.push(info('BLUEPRINT_REVISION_INFO', `this Blueprint supersedes an earlier revision ("${blueprint.supersedesBlueprintId}")`));
  }

  void visualBible; // read for parity with the spec's REQUIRED input list; continuity findings are already sourced from blueprint.diagnostics (see checkCopiedThroughBlueprintDiagnostics), which INT-2 itself already validated against this exact VisualBible at draft-build time

  const assessment = determineAssessment(blockers);
  const reasoning = buildReasoning(assessment, blockers, warnings);

  const gateResult = createPreProductionGateResult({
    projectId,
    blueprintId: blueprint.id,
    blueprintRevision: blueprint.id,
    blueprintUpdatedAt: blueprint.updatedAt,
    machineAssessment: assessment,
    blockers,
    warnings,
    information,
    reasoning,
    costStatus: beatGraphResult.costStatus,
  });

  const saved = preProductionGateStore.addGateResult(projectId, gateResult);
  if (!saved.ok) return { ok: false, reason: saved.reason };
  return { ok: true, gateResult: saved.gateResult };
}

// P0 Hardening (finding E) — a PROCEED/REVISE/REJECT verdict is only ever
// true of the EXACT Blueprint content it was computed against. If the
// Blueprint has since been edited (editCreativeBlueprintDraft) or replaced
// by a new revision, its updatedAt no longer matches what this gate result
// captured at evaluation time — the result is stale and must not be acted
// on as if it still describes the current Blueprint. Returns { stale, reason }
// rather than throwing, so callers can produce a normal ok:false response.
function isGateResultStale(projectId, gateResult) {
  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, gateResult.blueprintId);
  if (!blueprint) {
    return { stale: true, reason: `the Blueprint ("${gateResult.blueprintId}") this gate result was computed against no longer exists` };
  }
  if (blueprint.updatedAt !== gateResult.blueprintUpdatedAt) {
    return { stale: true, reason: `this gate result was computed against Blueprint "${gateResult.blueprintId}" as of ${gateResult.blueprintUpdatedAt}, but the Blueprint has since changed (now updated at ${blueprint.updatedAt}) — re-run the gate against the current Blueprint before acting on it` };
  }
  return { stale: false, reason: null };
}

// Spec Part 11 — human decision handling. REQUEST_REVISION/REJECT
// delegate to the EXISTING creative-blueprint-service.js review machinery
// (never a second Blueprint state-transition system). OVERRIDE requires a
// non-empty humanRationale. ACCEPT/OVERRIDE never touch the Blueprint's
// own status — the gate is advisory infrastructure, not a technical lock
// (spec Part 4/11).
//
// P0 Hardening (finding E) — ACCEPT/OVERRIDE are BLOCKED once the gate
// result is stale (Rule 4: a gate result must not outlive the exact
// Blueprint state it was computed against). REQUEST_REVISION/REJECT are
// NOT blocked — they act on the Blueprint itself (via reviewCreativeBlueprint)
// and remain valid regardless of what the Blueprint currently looks like.
function decideGateResult(projectId, gateResultId, { decision, decidedBy, rationale } = {}) {
  if (!HUMAN_DECISION_VALUES.includes(decision)) {
    return { ok: false, reason: `"${decision}" is not a recognized human decision` };
  }
  const gateResult = preProductionGateStore.getGateResult(projectId, gateResultId);
  if (!gateResult) {
    return { ok: false, reason: `no PreProductionGateResult found with id "${gateResultId}"` };
  }
  if (decision === 'OVERRIDE' && (!rationale || String(rationale).trim().length === 0)) {
    return { ok: false, reason: 'OVERRIDE requires a non-empty humanRationale' };
  }

  if (decision === 'ACCEPT' || decision === 'OVERRIDE') {
    const staleness = isGateResultStale(projectId, gateResult);
    if (staleness.stale) return { ok: false, reason: `cannot ${decision} a stale gate result: ${staleness.reason}` };
  }

  if (decision === 'REQUEST_REVISION' || decision === 'REJECT') {
    const blueprintReview = creativeBlueprintService.reviewCreativeBlueprint(projectId, gateResult.blueprintId, { decision, reviewedBy: decidedBy, note: rationale });
    if (!blueprintReview.ok) return { ok: false, reason: `Blueprint review failed: ${blueprintReview.reason}` };
  }

  const updated = preProductionGateStore.recordHumanDecision(projectId, gateResultId, { humanDecision: decision, humanDecidedBy: decidedBy, humanRationale: rationale !== undefined ? rationale : null });
  if (!updated) return { ok: false, reason: 'failed to record human decision' };
  return { ok: true, gateResult: updated };
}

module.exports = {
  GATE_ASSESSMENT_VALUES,
  VISUAL_TREATMENT_CAPABILITY,
  CATEGORY_TO_STRATEGY_FIELD,
  REJECT_TIER_BLOCKER_CODES,
  deriveVisualTreatmentCapability,
  scanTextForCapabilitySignals,
  determineAssessment,
  evaluatePreProductionGate,
  decideGateResult,
  isGateResultStale,
};
