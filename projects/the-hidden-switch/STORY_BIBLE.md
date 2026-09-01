# Story Bible (thin) — The Hidden Switch

Produced by the EvoLink orchestrator's Story phase. This project has no fictional
characters, locations, or factions to lock — it is a single real-narrator monologue —
so the full interview-driven `$story-bible-builder` pass was skipped as unnecessary
overhead. This document is the canon that later passes (scene architecture, visual
development, cinema direction) must not contradict.

## Premise

A creator spent years treating motivation as a discipline problem — waking up,
setting alarms, forcing themselves — and staying stuck. Then something shifted and
the same workload stopped feeling like effort. The video's engine is the gap between
those two states and the mechanism that explains it.

## Thesis

There are two fuel sources for motivation — extrinsic (money, praise, status,
avoiding punishment) and intrinsic — and the narrator was running on the weaker one
without knowing a stronger one existed. Extrinsic fuel produces more dopamine from
*wanting* a reward than from *getting* it, so every win goes flat within days,
which reads as burnout or laziness but is actually a fuel problem, not a character
problem.

## Register & Voice (locked — do not smooth out)

- Raw, unfiltered, first-person, real-time-thinking cadence: false starts, trailing
  "—", self-interruption ("I mean I worked more"), filler restarts ("I don't know.
  Like."). This is a performance choice, not a transcription artifact — TTS delivery
  and any on-screen text must preserve it, not clean it into polished prose.
- No fictional distancing — "I" is the narrator, addressing the viewer directly.
  Treat this like the `talking-head`/`animated-explainer` register, not `cinematic`.

## The hook

Template: **"About Me" (Past Result).** Cold open on the result ("best three months
of work in my life") before the mechanism is explained — the entire monologue exists
to answer "why."

## Recurring visual motif — the hidden engine (track this like a continuity prop)

The race-car-with-a-hidden-engine image is planted in the hook (Phase 1: "pushing a
car uphill... someone finally told me there was an engine inside it the whole time")
before it is explained (Phase 2: race car filled with regular gas vs. what it was
built for). Treat this as a single recurring visual asset with a stable identity —
`motif_hidden_engine_001` — not two unrelated illustrations. Whatever visual
treatment Phase 1 uses for it, Phase 2's explanation and any later reveal/payoff
beat must visually rhyme with it (same car, same visual language), or the plant/payoff
breaks.

## Production decisions (confirmed with the user)

- **No animation.** Real B-roll/stock/archival footage only — no motion graphics,
  no illustrated diagrams, no kinetic typography. The only on-screen graphic in the
  entire piece is a single closing text overlay (see end-tag below).
- **Narration provider: Fish Audio TTS** (`fish_audio_tts`), explicitly requested.
  Voice selection is deferred to OpenMontage's own asset stage.
- **Pipeline: `documentary-montage`.** The only OpenMontage pipeline that retrieves
  real footage from stock/archive libraries (Pexels, Archive.org, Wikimedia, etc.)
  from a written brief rather than assuming footage is already supplied. Tradeoffs
  accepted: a single fixed tone register (`dreamlike` — EvoLink's pick, not the
  user's; flag for override if it reads wrong once real footage is in), a
  long-form runtime well past this pipeline's documented 30s–3min sweet spot, and
  its mandatory music/end-tag contract (resolved below).
- **Music: opted out.** No music-generation/search API is currently configured —
  recorded as an explicit `music_plan.source = "none"` opt-out, not a silent
  omission.
- **End-tag: opted in.** A single closing line fades in as a text overlay over the
  final shot (`"The engine was already there."` — EvoLink's pick, ties off the
  motif plant/payoff; two alternates logged in `scene_plan.json` if this doesn't
  land). This is a static text card, not motion graphics, consistent with the
  no-animation constraint.

## Known open items (do not resolve by inventing)

The user-supplied source script covers only Phase 1 (0–20s) and part of Phase 2
(cut off mid-sentence: "...thinking — okay when I hit this—"). Everything past that
point — the rest of Phase 2, the reveal (Phase 3), the discovery story (Phase 4),
the framework (Phase 5), application/proof (Phase 6), nuance/objections (Phase 7),
the call to action (Phase 8), and the resolution (Phase 9) — is EvoLink-authored
placeholder content, per explicit instruction to extend the draft rather than stop
at the gap. Every placeholder passage is bracketed `[[PLACEHOLDER]]` in
`script.json` so it's easy to find and replace piece by piece.

Ranked by how likely each placeholder is to need full replacement rather than light
editing, once real material exists:

- **Highest fabrication risk:** Phase 4's discovery story invents a specific person
  (a retired department mentor) and incident (a missed promotion). If the real
  story differs at all in its particulars, this phase should be rewritten from
  scratch, not patched.
- **Named mechanism, not confirmed:** Phase 3/5 name the second fuel as intrinsic
  motivation, broken into a choice/progress/connection framework (Self-Determination
  Theory territory). This is a plausible, defensible answer given the two-fuel setup
  Phase 2 already established, but it is EvoLink's inference, not the user's stated
  answer.
- **Structural, lower risk:** Phases 6–9 (application, nuance, invitation,
  resolution) follow generically from whatever Phase 3–5 end up saying, so they're
  more likely to survive with edits than need a full rewrite.

The full arc now runs ~933s (~15.5 min) against the script header's original
~20-minute target — see `script.json.metadata.runtime_note` and
`scene_plan.json.metadata.duration_seconds_note` for why that gap wasn't padded to
match. Closing it legitimately means either real material replacing a placeholder
phase (which will change its length), or deliberately expanding one phase (more
application examples, more objections addressed).
