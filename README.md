# EvoLink Video Factory

A local AI video production system, orchestrated through Claude Code. The
goal: turn a video idea into a finished video through a controlled
pipeline — research, creative direction, script, storyboard, human
approval, generation, and QC — with real safeguards around spending and
human oversight at every step that matters.

Claude Code drives the system via an MCP server (122 tools) and/or a REST
API; a plain-JS browser frontend gives a human a read/decide surface over
the same backend. Everything is a small Node.js/Express service with
local JSON file storage — no database.

## Status: two pipelines, not yet connected

This is the single most important thing to know about the current state,
and it's tracked in detail in
[`docs/architecture/evolink-master-control-quality-blueprint.md`](docs/architecture/evolink-master-control-quality-blueprint.md)
(read that file for the authoritative, up-to-date picture — this README
summarizes it):

- **Pipeline A** — real, credit-spending AI generation. Creative brief →
  spec → visual bible → storyboard → keyframe generation → video
  generation, all through EvoLink, all approval-gated and budget-ledgered.
  Has a REST API, MCP tools, and frontend screens. **A real generation has
  already happened** (see `docs/architecture/budget-safety.md` for what
  that taught us about cost tracking).
- **Pipeline B** — deterministic, mostly-free material resolution/
  execution/rendering (reused assets, B-roll library, deterministic
  templates) plus real narration direction and real voice generation
  (offline, via espeak-ng + faster-whisper). Has no REST/MCP/UI yet —
  proven only in tests and scripts.

**These two pipelines have never been connected**, and there's no
orchestrator that walks a project through the full graph automatically —
every step today is triggered by hand (a human, or Claude Code, calling
one tool/endpoint at a time). The blueprint document names the exact
blockers standing in the way of a real end-to-end "Golden Video" and what
order to close them in.

## Project layout

```
server/
  index.js        Express app — ~90 REST endpoints (see below)
  schemas/        Shared data shapes: projects, scenes, shots, assets,
                  generation jobs, the state machine, plus per-feature
                  schemas (keyframes, beats, creative blueprints,
                  reference videos, human voice, ...)
  services/       Business logic — one file per concern. Roughly grouped:
                    - project/timeline/approval: project-store,
                      timeline-store, approval-gate, generation-*
                    - creative planning: creative-*, keyframe-*,
                      video-prompt-service, skill-*
                    - reference/identity: reference-library-service,
                      reference-video-*, identity-consistency-review-*
                    - Pipeline B: beat-graph-derivation-service,
                      material-resolution-service,
                      material-execution-service, material-executors/,
                      renderers/, timeline-compiler-service
                    - audio: narration-director-service,
                      voice-generation-service, voice/ (real TTS +
                      alignment adapters), caption-service
                    - media/assets: media-acquisition-service (free
                      stock media), asset-storage, asset-archive-service
                    - orchestration: production-orchestrator-service,
                      intelligence-orchestrator-service,
                      control-plane-service, operator-queue-service
  providers/      Generic provider interfaces (video + image), with
                  EvoLink adapters built strictly from EvoLink's official
                  docs (client/mapper/models), plus fake providers used
                  in tests
  mcp/            The MCP server Claude Code connects to (122 tools
                  across mcp/tools/*.js)
  test/           Automated tests (Node's built-in test runner) — real
                  pipelines preferred over mocks throughout
  data/           Local JSON storage (gitignored — real, private data)
  .venv/          Python virtualenv for faster-whisper (gitignored,
                  must be re-provisioned per environment — see below)
  .whisper-models/  Downloaded Whisper model cache (gitignored)

frontend/         Plain HTML/CSS/JS browser UI over the backend — no
                  framework, no build step, served statically by
                  server/index.js

docs/
  architecture/   How each subsystem works, in plain language — start
                  with evolink-master-control-quality-blueprint.md for
                  overall status, and production-ir.md/state-machine.md/
                  mcp.md for the foundational pieces
  integrations/   Research on external APIs (EvoLink, Google/Veo, image
                  providers), always fact/assumption/unknown-labeled and
                  sourced to the official docs page it came from
```

`src/`, `api/`, and the root `package.json` are an older Remotion/Vercel
template that predates this project and are unrelated to it.

## Running the backend

```bash
cd server
npm install
npm start
```

This serves the REST API and the frontend together on one origin
(`http://localhost:3000` by default) — open it in a browser for the
read/decide UI, or call the API directly.

## Running the MCP server

Claude Code discovers this automatically via `.mcp.json` in the repo
root. To run it manually:

```bash
cd server
node mcp/server.js
```

## System dependencies for the full test suite

Most of the backend only needs Node — but the real (non-mocked) audio and
video pipelines need real tools installed, since this project prefers
testing against real pipelines over mocks wherever practical:

```bash
# Video assembly / rendering (ffmpeg + ffprobe)
apt-get install -y ffmpeg

# Voice synthesis
apt-get install -y espeak-ng

# Word-level audio alignment (faster-whisper), in its own venv:
cd server
python3 -m venv .venv
.venv/bin/pip install faster-whisper
# The model itself downloads automatically on first real use.
```

These three are **ephemeral, container-scoped infrastructure** —
`.venv/` and `.whisper-models/` are gitignored and must be re-provisioned
in any fresh environment (a new sandbox, a new machine, CI, etc.).
Without them, the affected tests fail with clear, honest errors (never
silently skip or fake a result) — expect several hundred failures from a
totally fresh environment until these are installed; that's this gap,
not a code regression.

## Running the tests

```bash
cd server
npm test
```

All ~2,850 tests use temporary directories and never touch real project
data. Two tests are expected to fail without a `PIXABAY_API_KEY`
configured (see below) — that's a missing credential, not a bug.

## Environment variables / API keys

Configure these in `server/.env` (copy `server/.env.example` first) or
via your environment's secret/env-var settings. None of them are ever
committed, logged, or printed — a missing key fails clearly rather than
silently doing nothing or using a fake credential.

| Variable | What it's for | Required? |
|---|---|---|
| `EVOLINK_API_KEY` | Real image/video generation via EvoLink | Only for real generation — most of the system works without it |
| `PEXELS_API_KEY` | Free stock media search (Pexels) | Optional — provider reports itself unavailable without it |
| `PIXABAY_API_KEY` | Free stock media search (Pixabay) | Optional — same as above |
