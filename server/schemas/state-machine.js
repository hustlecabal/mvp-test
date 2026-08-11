// state-machine.js
//
// The MVP production state machine. A project's `status` field (already
// used since Stage 2) holds one of the states below, and this file is the
// only place that decides which moves between states are legal.
//
// Generation states are the only states where the system would actually
// call a paid provider. This file does not duplicate the approval/budget
// logic from Stage 3 — it calls services/approval-gate.js and refuses to
// enter a generation state unless the gate says yes.

const gate = require('../services/approval-gate');

const STATES = [
  'PLANNING',
  'RESEARCH',
  'CREATIVE_REVIEW',
  'SCRIPTING',
  'SCRIPT_REVIEW',
  'VISUAL_DEVELOPMENT',
  'VISUAL_REVIEW',
  'STORYBOARD',
  'GENERATION_REVIEW',
  'CALIBRATION',
  'KEYFRAME_GENERATION',
  'KEYFRAME_REVIEW',
  'MOTION_GENERATION',
  'FINAL_REVIEW',
  'COMPLETE',
];

// States that actually spend provider credits. See docs/architecture/
// state-machine.md for what each state means in full.
const GENERATION_STATES = ['CALIBRATION', 'KEYFRAME_GENERATION', 'MOTION_GENERATION'];

// Which state(s) each state is allowed to move to next. Review states can
// send work back a step (rejected) as well as forward (approved).
const TRANSITIONS = {
  PLANNING: ['RESEARCH'],
  RESEARCH: ['CREATIVE_REVIEW'],
  CREATIVE_REVIEW: ['SCRIPTING', 'RESEARCH'],
  SCRIPTING: ['SCRIPT_REVIEW'],
  SCRIPT_REVIEW: ['VISUAL_DEVELOPMENT', 'SCRIPTING'],
  VISUAL_DEVELOPMENT: ['VISUAL_REVIEW'],
  VISUAL_REVIEW: ['STORYBOARD', 'VISUAL_DEVELOPMENT'],
  STORYBOARD: ['GENERATION_REVIEW'],
  GENERATION_REVIEW: ['CALIBRATION', 'STORYBOARD'],
  CALIBRATION: ['KEYFRAME_GENERATION', 'GENERATION_REVIEW'],
  KEYFRAME_GENERATION: ['KEYFRAME_REVIEW'],
  KEYFRAME_REVIEW: ['MOTION_GENERATION', 'KEYFRAME_GENERATION'],
  MOTION_GENERATION: ['FINAL_REVIEW'],
  FINAL_REVIEW: ['COMPLETE', 'MOTION_GENERATION'],
  COMPLETE: [],
};

// A one-sentence, plain-English explanation of each state. This is the
// canonical source for that text — docs/architecture/state-machine.md
// mirrors it for human readers, and get_project_status (Stage 5's MCP
// tool) reads it directly instead of re-describing states itself.
const STATE_MEANINGS = {
  PLANNING: 'Project just created; nothing decided yet.',
  RESEARCH: 'Gathering facts and background for the topic.',
  CREATIVE_REVIEW: 'Human reviews research and creative direction so far.',
  SCRIPTING: 'Writing the script from the approved direction.',
  SCRIPT_REVIEW: 'Human reviews the script.',
  VISUAL_DEVELOPMENT: 'Defining the visual bible, characters, and locations.',
  VISUAL_REVIEW: 'Human reviews the visual direction.',
  STORYBOARD: 'Breaking the script into scenes and shots.',
  GENERATION_REVIEW:
    'Human reviews the full storyboard and shot plan before anything is generated or spent.',
  CALIBRATION: 'A small, cheap test generation to sanity-check prompts/settings before a full batch.',
  KEYFRAME_GENERATION: 'Generating still keyframes for approved shots.',
  KEYFRAME_REVIEW: 'Human reviews generated keyframes.',
  MOTION_GENERATION: 'Animating approved keyframes into video.',
  FINAL_REVIEW: 'Human reviews the assembled video.',
  COMPLETE: 'The project is finished.',
};

function describeState(state) {
  return STATE_MEANINGS[state] || 'Unknown state.';
}

function getNextStates(state) {
  return TRANSITIONS[state] || [];
}

function isValidState(state) {
  return STATES.includes(state);
}

function isGenerationState(state) {
  return GENERATION_STATES.includes(state);
}

function canTransition(fromState, toState) {
  if (!isValidState(fromState) || !isValidState(toState)) {
    return false;
  }
  return TRANSITIONS[fromState].includes(toState);
}

// Attempts to move a project into toState. Returns { ok: true, project } on
// success. On failure, returns { ok: false, reason } and leaves the
// project's status completely unchanged.
function transition(project, toState) {
  const fromState = project.status;

  if (!isValidState(toState)) {
    return { ok: false, reason: `"${toState}" is not a known production state.` };
  }
  if (!canTransition(fromState, toState)) {
    return { ok: false, reason: `Cannot move from ${fromState} to ${toState}.` };
  }
  if (isGenerationState(toState)) {
    const { allowed, reason } = gate.canProceed(project);
    if (!allowed) {
      return { ok: false, reason: `Blocked by approval/budget gate: ${reason}` };
    }
  }

  project.status = toState;
  return { ok: true, project };
}

module.exports = {
  STATES,
  GENERATION_STATES,
  TRANSITIONS,
  STATE_MEANINGS,
  describeState,
  getNextStates,
  isValidState,
  isGenerationState,
  canTransition,
  transition,
};
