// creative-production-compiler-service.js
//
// THE MISSING COMPILER SEAM:
//
//   Canonical Creative Production Contract (schemas/creative-schema.js's
//   Storyboard + VisualBible + GenerationUnit[])
//     -> compileCreativeProjectToTimeline()
//   -> a real, already-connected creative-schema.js Storyboard + the exact
//      context object beat-graph-derivation-service.js's deriveBeatGraph()
//      / production-orchestrator-service.js's startProduction() already
//      accept
//     -> the EXISTING, UNMODIFIED production pipeline
//     -> real MP4
//
// WHY "TIMELINE IR" MEANS THIS, NOT schemas/production-schema.js's
// createTimelineIR()/createGenerationRequest(): confirmed by direct
// inspection before writing this file (per this milestone's own
// instruction) — production-orchestrator-service.js's real, tested,
// end-to-end path reads `creativeStore.getStoryboard(projectId)` directly
// and derives a BeatGraph from it (beat-graph-derivation-service.js); it
// never constructs or consumes a production-schema.js TimelineIR/
// GenerationRequest/GenerationJob anywhere in that path (those are used by
// a SEPARATE, human-gated real-provider-generation subsystem —
// generation-service.js — the orchestrator explicitly never calls, per
// its own header's FINANCIAL BOUNDARY section). Compiling into that dormant
// shape would produce a Timeline IR with no real consumer, failing this
// milestone's own success criterion ("pass the resulting Timeline IR
// through the EXISTING production pipeline ... without manually rewriting
// the project"). Compiling into a real Storyboard + context is the only
// shape the existing, unmodified orchestrator actually runs.
//
// NO DUPLICATE TIMELINE COMPILATION LOGIC: this file does not replicate
// anything services/timeline-compiler-service.js already does (that file
// turns an already-resolved-and-executed BeatGraph into compiled Shot/
// transition records — a LATER stage than this one). This file's own job
// is earlier and narrower: turn Creative Production Contract objects into
// the Storyboard + context INPUT that stage's whole chain (deriveBeatGraph
// -> resolveBeatGraph -> executeMaterial -> render -> compileTimeline ->
// assembleTimeline) already knows how to run, unmodified.
//
// THE CORE SEAM THIS FILE ADDS: deriveBeatGraph() maps exactly one
// StoryboardShot -> one VisualBeat (by design — see that file's own
// header). A creative Shot with 2+ GenerationUnits therefore cannot reach
// two atomic generation operations by being handed to deriveBeatGraph()
// as-is. This compiler resolves that by producing, for each GenerationUnit,
// its OWN synthetic StoryboardShot record — shotId = the GenerationUnit's
// own stable id (never a fresh crypto.randomUUID(), so compiling the same
// project twice yields byte-identical compiled shot/edge ids — Section
// "IDEMPOTENCY") — inheriting the parent creative Shot's scene/character/
// location/prop/camera/lighting fields verbatim (no canonical record is
// duplicated: these are reference ids/free-text fields, copied, never
// re-created). deriveBeatGraph/resolveBeatGraph/executeMaterial/
// compileTimeline/assembleTimeline/production-orchestrator-service.js are
// completely unmodified by this file.

const validator = require('./creative-production-contract-validator');
const { createStoryboard, createStoryboardShot } = require('../schemas/creative-schema');

function diag(code, message, objectType, objectId) {
  return { code, message, objectType, objectId: objectId || null };
}

// Section 9 — "Sequence -> Timeline Scene grouping/order." Sequences are
// never a new grouping construct at compile time: if real Sequence records
// are supplied, this returns storyboard.scenes REORDERED to match
// Sequence.order -> Sequence.sceneIds[] listing order (informational
// reordering only — scene CONTENT is never touched). Scenes belonging to
// no sequence keep their original relative order, appended after every
// sequenced scene. With no sequences supplied, scenes pass through
// unchanged — this is the common case and the only one every prior
// milestone's demos have exercised.
function orderScenesBySequence(scenes, sequences) {
  if (!Array.isArray(sequences) || sequences.length === 0) return scenes;
  const sceneById = new Map(scenes.map((s) => [s.sceneId, s]));
  const ordered = [];
  const placed = new Set();
  for (const sequence of [...sequences].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    for (const sceneId of sequence.sceneIds || []) {
      const scene = sceneById.get(sceneId);
      if (scene && !placed.has(sceneId)) {
        ordered.push(scene);
        placed.add(sceneId);
      }
    }
  }
  for (const scene of scenes) {
    if (!placed.has(scene.sceneId)) ordered.push(scene);
  }
  return ordered;
}

// Fields copied VERBATIM from the parent creative Shot onto every one of
// its compiled per-GenerationUnit sub-shots — every one is either a
// reference id array (never duplicating the canonical Character/Location/
// Prop record itself) or a free-text field the parent shot already
// authored once for the whole shot. duration/shotId/order are set
// per-unit below, never copied from the parent.
const INHERITED_SHOT_FIELDS = [
  'purpose', 'narrativeBeat', 'visualDescription', 'subject', 'action',
  'camera', 'framing', 'lens', 'movement', 'lighting', 'soundNotes',
  'characterReferences', 'locationReferences', 'propReferences', 'referenceAssets',
  'continuityRequirements', 'recommendationIds', 'visualTreatment', 'transition',
];

function inheritedShotFields(shot) {
  const out = {};
  for (const field of INHERITED_SHOT_FIELDS) out[field] = shot[field];
  return out;
}

// ---------------------------------------------------------------------------
// compileCreativeProjectToTimeline(project, options)
//
//   project.storyboard        — a real createStoryboard() object (required)
//   project.visualBible       — a real createVisualBible() object (required)
//   project.generationUnits   — createGenerationUnit() records (required)
//   project.sequences         — createSequence() records (optional)
//   project.knownAssetIds     — Set<string>, passed through to the
//                                validator's dangling-frame-asset check
//                                (optional — omit to skip that one check,
//                                exactly like the validator itself)
//
//   options.treatments/narrationSegments/narrativeRoles/visualObjectives
//     — keyed by the ORIGINAL creative StoryboardShot.shotId (the natural
//     key a caller already has — these decisions are made about a
//     director-designed Shot, not about an individual GenerationUnit).
//     Remapped below onto the compiled per-unit shotIds:
//       treatments/narrativeRoles/visualObjectives -> applied to EVERY
//         compiled unit of that shot (the same overall visual approach/
//         role/objective genuinely does describe the whole shot).
//       narrationSegments -> applied ONLY to the shot's FIRST (lowest
//         GenerationUnit.order) compiled unit, so narration is never
//         duplicated across a shot's multiple atomic generations. This
//         codebase's own "the compiler should not rewrite narration"
//         instruction is honored literally: the text itself is never
//         touched, only which single compiled shotId it is attached to.
//   options.edges — additional caller-supplied BeatEdges keyed by ORIGINAL
//     shotId pairs (e.g. a TRANSITIONS_TO between two different creative
//     shots); remapped onto the LAST unit of the `from` shot and the FIRST
//     unit of the `to` shot. Continuation edges derived from
//     GenerationUnit.continuesFromGenerationUnitId (Section "FRAME
//     CONTINUITY") are added automatically and need no caller input.
//
// Returns { ok:false, diagnostics } (never compiles) when
// validateCreativeProductionContract() fails. Returns
// { ok:true, storyboard, context, provenance, generationUnitsById }
// otherwise, where `storyboard`+`context` are exactly what
// deriveBeatGraph(storyboard, context) / production-orchestrator-
// service.js's startProduction(projectId, { ...context, outputDir })
// already accept, unmodified.
// ---------------------------------------------------------------------------
function compileCreativeProjectToTimeline(project, options = {}) {
  const { storyboard, visualBible, generationUnits = [], sequences = [], knownAssetIds = null } = project;

  const validation = validator.validateCreativeProductionContract({ storyboard, visualBible, generationUnits, knownAssetIds });
  if (!validation.ok) {
    return { ok: false, diagnostics: validation.diagnostics };
  }

  const orderedScenes = orderScenesBySequence(storyboard.scenes, sequences);
  const unitsByShotId = new Map();
  for (const unit of generationUnits) {
    if (!unitsByShotId.has(unit.shotId)) unitsByShotId.set(unit.shotId, []);
    unitsByShotId.get(unit.shotId).push(unit);
  }

  const compiledShots = [];
  const provenance = []; // [{ compiledShotId, generationUnitId, parentShotId, sceneId }]
  const edges = [];
  const diagnostics = [];
  const treatments = {};
  const narrationSegments = {};
  const narrativeRoles = {};
  const visualObjectives = {};

  const firstCompiledShotIdByOriginalShot = new Map();
  const lastCompiledShotIdByOriginalShot = new Map();

  let globalShotOrder = 0;
  for (const scene of orderedScenes) {
    const shotsInScene = storyboard.shots.filter((s) => s.sceneId === scene.sceneId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const shot of shotsInScene) {
      const units = (unitsByShotId.get(shot.shotId) || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (units.length === 0) {
        diagnostics.push(diag('SHOT_HAS_NO_GENERATION_UNITS', `shot ${shot.shotId} has no GenerationUnits — nothing compiled for it`, 'StoryboardShot', shot.shotId));
        continue;
      }
      globalShotOrder += 1;

      units.forEach((unit, index) => {
        const compiledShotId = unit.id; // stable — see file header re: idempotency
        const compiledShot = createStoryboardShot({
          ...inheritedShotFields(shot),
          shotId: compiledShotId,
          sceneId: shot.sceneId,
          order: globalShotOrder * 1000 + (unit.order ?? index + 1), // deterministic, collision-free across the whole compiled storyboard
          duration: unit.durationSeconds,
          status: 'DRAFT',
        });
        compiledShots.push(compiledShot);
        provenance.push({ compiledShotId, generationUnitId: unit.id, parentShotId: shot.shotId, sceneId: scene.sceneId, order: compiledShot.order });

        if (index === 0) firstCompiledShotIdByOriginalShot.set(shot.shotId, compiledShotId);
        lastCompiledShotIdByOriginalShot.set(shot.shotId, compiledShotId);

        // --- FRAME CONTINUITY (declared only — never inferred) ---
        if (unit.continuesFromGenerationUnitId) {
          const predecessor = generationUnits.find((u) => u.id === unit.continuesFromGenerationUnitId);
          const frameMatch = predecessor && predecessor.endFrameAssetId && unit.startFrameAssetId && predecessor.endFrameAssetId === unit.startFrameAssetId;
          edges.push({
            fromShotId: unit.continuesFromGenerationUnitId,
            toShotId: compiledShotId,
            kind: 'DEPENDS_ON', // never TRANSITIONS_TO — that triggers a real, unsupported FFmpeg transition in video-assembly-service.js; this is a declared temporal/state continuation, not a visual transition effect
            note: frameMatch ? `continues from ${predecessor.id}'s approved end frame (${predecessor.endFrameAssetId})` : `continues from ${unit.continuesFromGenerationUnitId} (state-only)`,
          });
        }

        // --- per-unit context, remapped from the ORIGINAL shot's caller-supplied options ---
        if (Object.prototype.hasOwnProperty.call(options.treatments || {}, shot.shotId)) treatments[compiledShotId] = options.treatments[shot.shotId];
        if (Object.prototype.hasOwnProperty.call(options.narrativeRoles || {}, shot.shotId)) narrativeRoles[compiledShotId] = options.narrativeRoles[shot.shotId];
        if (Object.prototype.hasOwnProperty.call(options.visualObjectives || {}, shot.shotId)) visualObjectives[compiledShotId] = options.visualObjectives[shot.shotId];
      });

      if (Object.prototype.hasOwnProperty.call(options.narrationSegments || {}, shot.shotId)) {
        narrationSegments[firstCompiledShotIdByOriginalShot.get(shot.shotId)] = options.narrationSegments[shot.shotId];
      }
    }
  }

  // --- caller-supplied cross-shot edges (e.g. TRANSITIONS_TO between two director-designed shots), remapped last-unit -> first-unit ---
  for (const rawEdge of options.edges || []) {
    const fromShotId = lastCompiledShotIdByOriginalShot.get(rawEdge.fromShotId);
    const toShotId = firstCompiledShotIdByOriginalShot.get(rawEdge.toShotId);
    if (!fromShotId || !toShotId) {
      diagnostics.push(diag('DANGLING_EDGE_REFERENCE', `edge references shot "${rawEdge.fromShotId}" or "${rawEdge.toShotId}" with no compiled GenerationUnit`, 'StoryboardShot', rawEdge.fromShotId));
      continue;
    }
    edges.push({ fromShotId, toShotId, kind: rawEdge.kind, note: rawEdge.note || null });
  }

  const compiledStoryboard = createStoryboard({
    id: storyboard.id,
    projectId: storyboard.projectId,
    sequenceIds: storyboard.sequenceIds,
    blueprintId: storyboard.blueprintId,
    scenes: orderedScenes,
    shots: compiledShots,
  });

  return {
    ok: true,
    storyboard: compiledStoryboard,
    context: { treatments, narrationSegments, narrativeRoles, visualObjectives, visualBible, edges },
    provenance,
    generationUnitsById: new Map(generationUnits.map((u) => [u.id, u])),
    diagnostics,
  };
}

module.exports = { compileCreativeProjectToTimeline, orderScenesBySequence };
