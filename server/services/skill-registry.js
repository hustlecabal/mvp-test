// skill-registry.js
//
// Stage 11B — a static, read-only catalogue of the Claude skills audited
// for the creative production workflow. This file has NO behavior: it's
// plain data, straight from the read-only skill audit performed before
// this stage (each skill's actual SKILL.md was inspected on disk; nothing
// here is invented). See docs/architecture/skill-orchestration.md.
//
// Field meanings:
//   id                — the skill's identifier (matches its skill folder name)
//   name              — display name (from the skill's own frontmatter)
//   role              — SPECIALIST | EDITOR | ORCHESTRATOR | UNKNOWN
//                       (no audited skill is an ORCHESTRATOR — that role is
//                       Claude Code itself; see docs/architecture/skill-orchestration.md)
//   purpose           — one-line description of what the skill does
//   inputType         — what kind of input the skill's own docs say it expects
//   outputType        — what kind of output the skill's own docs say it produces
//   platformCoupling  — 'LOW' (mostly provider-agnostic text), or the name of
//                       the external platform its output syntax is tied to
//                       (e.g. 'HIGGSFIELD', 'TOPVIEW_CANVAS', 'HYPERFRAMES_LOCAL')
//   generationRisk    — 'NONE' (never generates media itself — hands off a
//                       prompt for a human/tool to run elsewhere) or
//                       'INDIRECT_GATED' (can trigger real generation, but
//                       only through its own mandatory human-confirmation gates)
//   enabled           — whether the skill is actually installed/available in
//                       this environment (false for the two that were not found)
//   adapter           — the adapter id in services/skill-adapters/, or null if
//                       no adapter has been built yet (Part 8: a skill can still
//                       be *recommended* with adapter: null — it's just not
//                       executable yet)
//   notes             — anything else worth recording from the audit

const SKILLS = [
  {
    id: 'video-prompt-builder',
    name: 'video-prompt-builder',
    role: 'SPECIALIST',
    purpose: 'Turns a creative brief into shot-by-shot Seedance-oriented video prompts (effects timeline, effects inventory, density map, energy arc).',
    inputType: 'creative-brief',
    outputType: 'shot-prompt',
    platformCoupling: 'LOW',
    generationRisk: 'NONE',
    enabled: true,
    adapter: 'video-prompt-builder',
    notes: 'Prompt-only. Output is plain text with 4 fixed sections, no platform-specific tag syntax (e.g. no @image tokens) — the most portable of the audited skills.',
  },
  {
    id: 'cinema-worldbuilder-pro-2.0',
    name: 'cinema-worldbuilder-pro-2.0',
    role: 'SPECIALIST',
    purpose: 'Cinematography-rigorous Seedance prompt construction — five-mode grammar with explicit Frame Map / Subject Lock / Movement / Last Frame / Camera Capture blocks.',
    inputType: 'scene-and-references',
    outputType: 'cinematic-shot-prompt',
    platformCoupling: 'HIGGSFIELD',
    generationRisk: 'NONE',
    enabled: true,
    adapter: 'cinema-worldbuilder-pro-2.0',
    notes: 'Prompt-only. Its terminology maps closely to our storyboard shot fields, but its output embeds Higgsfield-specific @imageN tags that must never reach our canonical model directly.',
  },
  {
    id: 'banana-pro-director-2.0',
    name: 'banana-pro-director-2.0',
    role: 'SPECIALIST',
    purpose: 'Writes locked image prompts for character face-lock, outfit references, character sheets, scene plates, and detail shots (Higgsfield Banana Pro / Soul Cinema / GPT-2).',
    inputType: 'character-or-scene-description',
    outputType: 'image-prompt',
    platformCoupling: 'HIGGSFIELD',
    generationRisk: 'NONE',
    enabled: true,
    adapter: null,
    notes: 'No adapter built yet — recommendable (Part 8) for a future keyframe/reference-image stage, but not executable through this orchestrator today.',
  },
  {
    id: 'brand-video-editor',
    name: 'brand-video-editor',
    role: 'EDITOR',
    purpose: 'End-to-end post-production editing of an existing video into brand-consistent motion graphics (renders scene MP4s via HyperFrames CLI; optional Higgsfield image-gen).',
    inputType: 'video-and-brand-assets',
    outputType: 'rendered-video',
    platformCoupling: 'HYPERFRAMES_LOCAL',
    generationRisk: 'INDIRECT_GATED',
    enabled: true,
    adapter: null,
    notes: 'Downstream post-production stage, not part of the shot-generation loop this MVP is building. Its own skill definition enforces 3 mandatory human-confirmation gates before any generation/render.',
  },
  {
    id: 'ugc-decoder',
    name: 'UGC Decoder',
    role: 'SPECIALIST',
    purpose: 'Reverse-engineers a reference UGC ad (or a description) into a full text production package: model prompt, product prompt, per-scene video prompts, Canvas assembly guide.',
    inputType: 'reference-or-brief',
    outputType: 'production-package',
    platformCoupling: 'TOPVIEW_CANVAS',
    generationRisk: 'NONE',
    enabled: true,
    adapter: null,
    notes: 'UGC-ad-format specific; assembly guidance targets Topview Canvas, not this project. Not core to the MVP pipeline.',
  },
  {
    id: 'ugc-builder',
    name: 'UGC Builder',
    role: 'SPECIALIST',
    purpose: 'Builds an original UGC production package from scratch (no reference needed) — same 5-step package as UGC Decoder.',
    inputType: 'creative-brief',
    outputType: 'production-package',
    platformCoupling: 'TOPVIEW_CANVAS',
    generationRisk: 'NONE',
    enabled: true,
    adapter: null,
    notes: 'Same platform coupling and MVP-relevance notes as ugc-decoder.',
  },
  {
    id: 'director',
    name: 'director',
    role: 'UNKNOWN',
    purpose: null,
    inputType: null,
    outputType: null,
    platformCoupling: null,
    generationRisk: null,
    enabled: false,
    adapter: null,
    notes: 'NOT AVAILABLE in this environment — no skill definition found on disk during the read-only audit. Every field left null/UNKNOWN rather than guessed.',
  },
  {
    id: 'xianxia-visual-director',
    name: 'xianxia-visual-director',
    role: 'UNKNOWN',
    purpose: null,
    inputType: null,
    outputType: null,
    platformCoupling: null,
    generationRisk: null,
    enabled: false,
    adapter: null,
    notes: 'NOT AVAILABLE in this environment — no skill definition found on disk during the read-only audit. Every field left null/UNKNOWN rather than guessed.',
  },
];

function listSkills() {
  return SKILLS;
}

function getSkill(skillId) {
  return SKILLS.find((s) => s.id === skillId) || null;
}

module.exports = { SKILLS, listSkills, getSkill };
