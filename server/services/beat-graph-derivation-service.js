// beat-graph-derivation-service.js
//
// P0-1 — the STORYBOARD -> BEATGRAPH bridge. Implements exactly the design
// in the completed P0-1 audit (chat record, this stage) and
// docs/architecture/evolink-master-control-quality-blueprint.md — nothing
// reinterpreted, nothing added beyond what those documents specify.
//
//   Storyboard -> VisualBeat(s) -> BeatGraph
//
// PURE AND DETERMINISTIC. Never mutates its inputs, never persists
// anything, never calls a provider/network/EvoLink, never calls Material
// Resolution or Material Execution, never infers a creative decision this
// file wasn't explicitly told. Given identical (storyboard, context), the
// output is identical apart from unavoidable timestamps (createVisualBeat/
// createBeatGraph's own versionFields().updatedAt and this function's own
// createdAt) — beat identity itself is stable (see below), not
// timestamp-like.
//
// DEFAULT MAPPING: exactly one StoryboardShot -> one VisualBeat. Never
// split automatically — StoryboardShot has no structured sub-unit field
// (no narrationSegments[], no beat markers) for an automatic split to key
// off; inventing a boundary the schema doesn't record would be exactly
// the "arbitrary splitting logic" the audit forbids. Automatic splitting
// is not implemented here, at all.
//
// IDENTITY (audit Part 4/Part 1 safety check, this stage): beat.id =
// shot.shotId — confirmed collision-free (no store cross-references
// VisualBeat.id against StoryboardShot.shotId in a shared namespace;
// compareBeats/BeatEdge only ever read beat.id, never beat.shotId).
// beat.shotId is ALSO set to shot.shotId — VisualBeat already has this
// dedicated field for exactly this purpose ("a beat MAY exist without a
// storyboard shot"); populating it when the source IS known is a
// zero-interpretation use of an existing field, not a new identity model.
//
// CRITICAL NON-INFERENCE RULE, restated because it is the one rule this
// whole file exists to enforce: visualTreatment, narrationSegment,
// startTime, motionRequirements, costPriority, qualityPriority, and
// fallbackStrategy are NEVER derived from StoryboardShot's own free-text
// fields (visualDescription/subject/action/soundNotes/etc.), no matter how
// suggestive the wording. narrationSegment is set ONLY from the explicit,
// caller-supplied context.narrationSegments map — never from anything
// else. Everything else in that list simply stays at createVisualBeat's
// own null/[]/'MEDIUM' defaults, which this file never overrides.
//
// INT-2.5-P0 refinement: visualTreatment is set from EITHER of two
// EXPLICIT, STRUCTURED sources — never free text, never inferred — with a
// documented precedence: the caller-supplied context.treatments[shotId]
// override wins when present; otherwise the shot's own already-validated
// StoryboardShot.visualTreatment (P0-4A) is used; otherwise null. Likewise
// recommendationIds is copied through verbatim from the shot's own
// already-validated StoryboardShot.recommendationIds[] — a pure
// provenance carry-through, never a new inference.

const { VISUAL_TREATMENTS, VISUAL_MODES, createVisualBeat, createIdentityRequirements, createNarrationSegment } = require('../schemas/visual-beat-schema');
const { BEAT_EDGE_KINDS, createBeatEdge, createBeatGraph } = require('../schemas/beat-graph-schema');
const { NARRATIVE_ROLES } = require('./narration-director-service');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Part 3's explicit, conservative mapping — a PRIORITY choice among
// already-authored fields, never a synthesis/concatenation of them (that
// would read as inventing a combined description the shot never wrote as
// one phrase). Same "first non-empty wins" rule for both target fields.
function firstNonEmpty(...values) {
  for (const v of values) {
    if (nonEmptyString(v)) return v;
  }
  return '';
}

// Identity-reference validation (audit Part 7) — reuses the EXACT lookup
// shape services/creative-store.js's own findReferenceEntity() reads
// (bible[arrayField].find(e => e[idField] === id)), inlined rather than
// requiring creative-store.js itself: that module also owns file I/O
// (ensureRecord/saveRecord) this derivation must never depend on to stay
// pure. context.visualBible is the caller's ALREADY-FETCHED
// creativeStore.getVisualBible(projectId) result — the same "pass in
// already-fetched context data" convention material-resolution-service.js
// already established for context.brollSegments. No new lookup/
// persistence system is introduced; when visualBible isn't supplied,
// identity references are simply left unchecked (not an error — Part 7
// only requires validation "IF the derivation context provides the
// necessary project data").
const REFERENCE_ENTITY_CONFIG = [
  { shotField: 'characterReferences', arrayField: 'characters', idField: 'characterId', code: 'UNKNOWN_CHARACTER_REFERENCE' },
  { shotField: 'locationReferences', arrayField: 'locations', idField: 'locationId', code: 'UNKNOWN_LOCATION_REFERENCE' },
  { shotField: 'propReferences', arrayField: 'props', idField: 'propId', code: 'UNKNOWN_PROP_REFERENCE' },
];

function findUnknownReferences(shot, visualBible) {
  if (!visualBible) return [];
  const problems = [];
  for (const cfg of REFERENCE_ENTITY_CONFIG) {
    const refs = Array.isArray(shot[cfg.shotField]) ? shot[cfg.shotField] : [];
    if (refs.length === 0) continue;
    const known = new Set((Array.isArray(visualBible[cfg.arrayField]) ? visualBible[cfg.arrayField] : []).map((e) => e[cfg.idField]));
    for (const ref of refs) {
      if (!known.has(ref)) problems.push({ code: cfg.code, ref });
    }
  }
  return problems;
}

// Duplicate-order detection (audit Part 9) — a Storyboard-authoring
// correctness signal, computed over EVERY shot regardless of whether that
// shot is later accepted/rejected for an unrelated reason (this is about
// the source Storyboard's own ordering, not this derivation's output).
// Warning-only: never renumbers, never "fixes" the order.
function findDuplicateOrders(shots) {
  const byScene = new Map(); // sceneId -> Map(order -> [shotId,...])
  for (const shot of shots) {
    if (!shot || !shot.shotId || shot.order === null || shot.order === undefined) continue;
    const sceneKey = shot.sceneId || '';
    if (!byScene.has(sceneKey)) byScene.set(sceneKey, new Map());
    const orderMap = byScene.get(sceneKey);
    if (!orderMap.has(shot.order)) orderMap.set(shot.order, []);
    orderMap.get(shot.order).push(shot.shotId);
  }
  const duplicates = [];
  for (const orderMap of byScene.values()) {
    for (const shotIds of orderMap.values()) {
      if (shotIds.length > 1) duplicates.push(...shotIds);
    }
  }
  return new Set(duplicates);
}

function diagnostic(code, shotId, message) {
  return { code, shotId: shotId || null, message };
}

// Public entry point.
//   storyboard — a real schemas/creative-schema.js createStoryboard() object
//   context — {
//     treatments: { [shotId]: one of VISUAL_TREATMENTS },        // explicit only, never inferred
//     narrationSegments: { [shotId]: createNarrationSegment() shape }, // explicit only, never inferred
//     visualBible: a real schemas/creative-schema.js createVisualBible() object, // optional, read-only
//
//     // PHASE 1 EDITORIAL SPINE, Part 6/7 — the SAME "explicit, structured,
//     // never inferred from free text" discipline as treatments/
//     // narrationSegments above, extended to the three new pieces of
//     // editorial intent an upstream Story Structure can now supply
//     // (services/story-structure-service.js's buildBeatGraphContext()).
//     // This does NOT weaken the file's own anti-inference rule — it is
//     // the proper upstream structured input the header above already
//     // calls for, so this derivation is never asked to guess narrative
//     // meaning out of a shot's own prose.
//     narrativeRoles: { [shotId]: one of NARRATIVE_ROLES },       // explicit only, never inferred
//     visualObjectives: { [shotId]: { visualObjective, visualMode: one of VISUAL_MODES, visualPriority, visualChangeRequired } }, // explicit only, never inferred
//     edges: [{ fromShotId, toShotId, kind: one of BEAT_EDGE_KINDS, note }], // explicit only, never inferred — both shotIds must resolve to a beat this derivation actually produced, or the edge is dropped with a diagnostic
//   }
function deriveBeatGraph(storyboard, context = {}) {
  const createdAt = new Date().toISOString();

  if (!storyboard || !Array.isArray(storyboard.scenes) || !Array.isArray(storyboard.shots)) {
    return {
      beatGraph: null,
      status: 'FAILED',
      diagnostics: [diagnostic('INVALID_STORYBOARD', null, 'a Storyboard with scenes[] and shots[] arrays is required')],
      derivedBeatCount: 0,
      rejectedBeatCount: 0,
      createdAt,
    };
  }

  const diagnostics = [];

  // --- validate context shape (Part 5/7) — a malformed context input is
  // surfaced, then ignored (treated as "not supplied"), never a fatal
  // error for the whole derivation. ---
  let treatments = context.treatments;
  if (treatments !== undefined && !isPlainObject(treatments)) {
    diagnostics.push(diagnostic('INVALID_CONTEXT', null, 'context.treatments must be a plain object keyed by shotId — ignored'));
    treatments = {};
  } else {
    treatments = treatments || {};
  }

  let narrationSegments = context.narrationSegments;
  if (narrationSegments !== undefined && !isPlainObject(narrationSegments)) {
    diagnostics.push(diagnostic('INVALID_CONTEXT', null, 'context.narrationSegments must be a plain object keyed by shotId — ignored'));
    narrationSegments = {};
  } else {
    narrationSegments = narrationSegments || {};
  }

  const visualBible = isPlainObject(context.visualBible) ? context.visualBible : null;
  if (context.visualBible !== undefined && !visualBible) {
    diagnostics.push(diagnostic('INVALID_CONTEXT', null, 'context.visualBible must be a plain object — ignored, identity references left unchecked'));
  }

  // PHASE 1 EDITORIAL SPINE, Part 6/7 — same validate-then-ignore-if-
  // malformed discipline as treatments/narrationSegments above.
  let narrativeRoles = context.narrativeRoles;
  if (narrativeRoles !== undefined && !isPlainObject(narrativeRoles)) {
    diagnostics.push(diagnostic('INVALID_CONTEXT', null, 'context.narrativeRoles must be a plain object keyed by shotId — ignored'));
    narrativeRoles = {};
  } else {
    narrativeRoles = narrativeRoles || {};
  }

  let visualObjectives = context.visualObjectives;
  if (visualObjectives !== undefined && !isPlainObject(visualObjectives)) {
    diagnostics.push(diagnostic('INVALID_CONTEXT', null, 'context.visualObjectives must be a plain object keyed by shotId — ignored'));
    visualObjectives = {};
  } else {
    visualObjectives = visualObjectives || {};
  }

  const rawEdges = Array.isArray(context.edges) ? context.edges : [];
  if (context.edges !== undefined && !Array.isArray(context.edges)) {
    diagnostics.push(diagnostic('INVALID_CONTEXT', null, 'context.edges must be an array — ignored'));
  }

  const sceneIds = new Set(storyboard.scenes.filter((s) => s && s.sceneId).map((s) => s.sceneId));
  const duplicateOrderShotIds = findDuplicateOrders(storyboard.shots);
  for (const shotId of duplicateOrderShotIds) {
    diagnostics.push(diagnostic('DUPLICATE_SHOT_ORDER', shotId, `shot "${shotId}" shares its order value with another shot in the same scene`));
  }

  const beats = [];
  let rejectedBeatCount = 0;

  for (const shot of storyboard.shots) {
    if (!shot || !shot.shotId) continue; // structurally unidentifiable — nothing downstream could reference it either

    // --- scene existence (Part 9) ---
    if (shot.sceneId && !sceneIds.has(shot.sceneId)) {
      diagnostics.push(diagnostic('MISSING_SCENE', shot.shotId, `shot "${shot.shotId}" references sceneId "${shot.sceneId}", which is not present in this Storyboard`));
      rejectedBeatCount += 1;
      continue;
    }

    // --- duration (Part 5/6) — ABSENT is non-fatal, INVALID is fatal for
    // this one beat only, never silently repaired. ---
    let duration = null;
    if (shot.duration === null || shot.duration === undefined) {
      diagnostics.push(diagnostic('SHOT_DURATION_MISSING', shot.shotId, `shot "${shot.shotId}" has no duration — beat.duration left null`));
    } else if (typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration <= 0) {
      diagnostics.push(diagnostic('SHOT_DURATION_INVALID', shot.shotId, `shot "${shot.shotId}" duration must be a positive number, got ${JSON.stringify(shot.duration)}`));
      rejectedBeatCount += 1;
      continue;
    } else {
      duration = shot.duration;
    }

    // --- identity reference validation (Part 7) ---
    const unknownRefs = findUnknownReferences(shot, visualBible);
    if (unknownRefs.length > 0) {
      for (const problem of unknownRefs) {
        diagnostics.push(diagnostic(problem.code, shot.shotId, `shot "${shot.shotId}" references unknown id "${problem.ref}"`));
      }
      rejectedBeatCount += 1;
      continue;
    }

    // --- explicit treatment override, OR the shot's own validated
    // visualTreatment (Part 4/5, refined INT-2.5-P0) — never inferred from
    // free text either way.
    //
    // PRECEDENCE (deliberate, documented, tested): context.treatments[shotId]
    // wins over shot.visualTreatment wins over null. context.treatments is
    // the CALLER's directly-supplied override for THIS derivation call
    // (may reflect a decision not yet saved back to the Storyboard, or a
    // deliberate one-off correction); shot.visualTreatment is the
    // Storyboard's own already-persisted, already-validated (P0-4A —
    // creative-store.js rejects an unrecognized value at write time) field.
    // Both are real, human-authored decisions; neither is ever invented or
    // synthesized here — a caller supplying context.treatments always
    // means exactly what it always meant, and a shot with no override and
    // no visualTreatment of its own stays null exactly as before this
    // patch. ---
    let visualTreatment = null;
    if (Object.prototype.hasOwnProperty.call(treatments, shot.shotId)) {
      const t = treatments[shot.shotId];
      if (!VISUAL_TREATMENTS.includes(t)) {
        diagnostics.push(diagnostic('INVALID_VISUAL_TREATMENT', shot.shotId, `treatments["${shot.shotId}"] value "${t}" is not one of ${VISUAL_TREATMENTS.join(', ')}`));
        rejectedBeatCount += 1;
        continue;
      }
      visualTreatment = t;
    } else if (typeof shot.visualTreatment === 'string' && VISUAL_TREATMENTS.includes(shot.visualTreatment)) {
      visualTreatment = shot.visualTreatment;
    }

    // --- explicit narration override only (Part 4/5) — never inferred ---
    let narrationSegment = null;
    if (Object.prototype.hasOwnProperty.call(narrationSegments, shot.shotId)) {
      const seg = narrationSegments[shot.shotId];
      if (!isPlainObject(seg)) {
        diagnostics.push(diagnostic('INVALID_NARRATION_SEGMENT', shot.shotId, `narrationSegments["${shot.shotId}"] must be a plain object`));
        rejectedBeatCount += 1;
        continue;
      }
      narrationSegment = createNarrationSegment(seg);
    }

    // --- creative-intent warning (Part 8) — non-fatal ---
    const mechanicalVisualIntent = firstNonEmpty(shot.visualDescription, shot.subject, shot.action);
    const narrativePurpose = firstNonEmpty(shot.purpose, shot.narrativeBeat);
    if (!nonEmptyString(shot.purpose) && !nonEmptyString(shot.narrativeBeat) && !nonEmptyString(shot.visualDescription)) {
      diagnostics.push(diagnostic('MISSING_VISUAL_INTENT', shot.shotId, `shot "${shot.shotId}" has no purpose, narrativeBeat, or visualDescription`));
    }

    // --- explicit narrativeRole override only (Part 6) — never inferred,
    // never fuzzy-classified from shot.purpose/narrativeBeat text. Same
    // precedence style as visualTreatment above: an invalid value is a
    // rejected beat (a caller-supplied editorial decision that doesn't
    // resolve to a real role is a real authoring error, not something to
    // silently drop to null), a missing one simply stays null. ---
    let narrativeRole = null;
    if (Object.prototype.hasOwnProperty.call(narrativeRoles, shot.shotId)) {
      const role = narrativeRoles[shot.shotId];
      if (!NARRATIVE_ROLES.includes(role)) {
        diagnostics.push(diagnostic('INVALID_NARRATIVE_ROLE', shot.shotId, `narrativeRoles["${shot.shotId}"] value "${role}" is not one of ${NARRATIVE_ROLES.join(', ')}`));
        rejectedBeatCount += 1;
        continue;
      }
      narrativeRole = role;
    }

    // --- explicit visual objective override only (Part 7) — an explicit
    // visualObjective TEXT wins over the mechanical firstNonEmpty fallback
    // (same "explicit override wins" precedence as visualTreatment/
    // narrativeRole above); visualMode/visualPriority/visualChangeRequired
    // have no mechanical fallback at all — they stay null unless this
    // upstream, structured input supplies them. ---
    let visualIntent = mechanicalVisualIntent;
    let visualMode = null;
    let visualPriority = null;
    let visualChangeRequired = null;
    if (Object.prototype.hasOwnProperty.call(visualObjectives, shot.shotId)) {
      const vo = visualObjectives[shot.shotId];
      if (!isPlainObject(vo)) {
        diagnostics.push(diagnostic('INVALID_VISUAL_OBJECTIVE', shot.shotId, `visualObjectives["${shot.shotId}"] must be a plain object`));
        rejectedBeatCount += 1;
        continue;
      }
      if (vo.visualMode !== undefined && vo.visualMode !== null && !VISUAL_MODES.includes(vo.visualMode)) {
        diagnostics.push(diagnostic('INVALID_VISUAL_OBJECTIVE', shot.shotId, `visualObjectives["${shot.shotId}"].visualMode "${vo.visualMode}" is not one of ${VISUAL_MODES.join(', ')}`));
        rejectedBeatCount += 1;
        continue;
      }
      if (nonEmptyString(vo.visualObjective)) visualIntent = vo.visualObjective;
      visualMode = vo.visualMode !== undefined ? vo.visualMode : null;
      visualPriority = vo.visualPriority !== undefined ? vo.visualPriority : null;
      visualChangeRequired = vo.visualChangeRequired !== undefined ? vo.visualChangeRequired : null;
    }

    const beat = createVisualBeat({
      id: shot.shotId, // Part 1/4 — stable identity, confirmed collision-free
      projectId: storyboard.projectId,
      sceneId: shot.sceneId,
      shotId: shot.shotId, // the schema's own dedicated provenance field
      sequence: shot.order, // ordinal only — never converted into startTime
      startTime: null, // Part 6 — never manufactured; no context input for it exists in this stage
      duration,
      narrativePurpose,
      visualIntent,
      narrativeRole, // null unless explicitly supplied via context.narrativeRoles — never inferred
      visualMode, // null unless explicitly supplied via context.visualObjectives — never inferred
      visualPriority,
      visualChangeRequired,
      visualTreatment, // null unless explicitly supplied — never inferred
      // INT-2.5-P0 — copied through verbatim from the source shot's own
      // already-validated (P0-4A) recommendationIds[]. Never re-resolved,
      // never re-validated here (that already happened at write time via
      // creative-store.js) — this is a pure provenance carry-through, not
      // a new validation layer.
      recommendationIds: Array.isArray(shot.recommendationIds) ? shot.recommendationIds : [],
      narrationSegment, // null unless explicitly supplied — never inferred
      camera: shot.camera !== undefined ? shot.camera : null,
      lighting: shot.lighting !== undefined ? shot.lighting : null,
      identityRequirements: createIdentityRequirements({
        characterReferences: Array.isArray(shot.characterReferences) ? shot.characterReferences : [],
        locationReferences: Array.isArray(shot.locationReferences) ? shot.locationReferences : [],
        propReferences: Array.isArray(shot.propReferences) ? shot.propReferences : [],
      }),
      continuityRequirements: Array.isArray(shot.continuityRequirements) ? shot.continuityRequirements : [],
      transition: shot.transition !== undefined ? shot.transition : null,
      status: 'PLANNED',
      // motionRequirements, costPriority, qualityPriority, fallbackStrategy,
      // styleRequirements, materials, graphics, audioEvents all stay at
      // createVisualBeat's own defaults — never set here (Part 4).
    });

    beats.push(beat);
  }

  const totalShots = storyboard.shots.filter((s) => s && s.shotId).length;
  const derivedBeatCount = beats.length;
  const status = totalShots === 0 ? 'DERIVED' : derivedBeatCount === totalShots ? 'DERIVED' : derivedBeatCount === 0 ? 'FAILED' : 'PARTIAL';

  // PHASE 1 EDITORIAL SPINE, Part 6 — populates real BeatEdge relationships
  // FROM EXPLICIT, ALREADY-DECIDED STRUCTURED INPUT ONLY (context.edges),
  // never inferred from beat content — the same discipline every other
  // field in this file already follows. Beat identity is beat.id ===
  // shot.shotId (see file header), so an edge's fromShotId/toShotId are
  // validated against the shotIds this derivation actually produced a beat
  // for — a dangling reference (a rejected shot, or a typo) is dropped with
  // a diagnostic, never silently invented or half-applied.
  const producedBeatIds = new Set(beats.map((b) => b.id));
  const edges = [];
  for (const rawEdge of rawEdges) {
    if (!isPlainObject(rawEdge)) {
      diagnostics.push(diagnostic('INVALID_BEAT_EDGE', null, 'each context.edges entry must be a plain object — dropped'));
      continue;
    }
    const { fromShotId, toShotId, kind, note } = rawEdge;
    if (!BEAT_EDGE_KINDS.includes(kind)) {
      diagnostics.push(diagnostic('INVALID_BEAT_EDGE', fromShotId || null, `edge kind "${kind}" is not one of ${BEAT_EDGE_KINDS.join(', ')} — dropped`));
      continue;
    }
    if (!producedBeatIds.has(fromShotId) || !producedBeatIds.has(toShotId)) {
      diagnostics.push(diagnostic('DANGLING_BEAT_EDGE', fromShotId || null, `edge references fromShotId "${fromShotId}" / toShotId "${toShotId}", and at least one does not resolve to a beat this derivation produced — dropped`));
      continue;
    }
    edges.push(createBeatEdge({ fromBeatId: fromShotId, toBeatId: toShotId, kind, note: note || null }));
  }

  const beatGraph = createBeatGraph({ projectId: storyboard.projectId, beats, edges });

  return {
    beatGraph,
    status,
    diagnostics,
    derivedBeatCount,
    rejectedBeatCount,
    createdAt,
  };
}

module.exports = { deriveBeatGraph };
