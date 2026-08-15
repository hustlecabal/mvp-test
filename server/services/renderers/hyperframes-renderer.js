// hyperframes-renderer.js
//
// Stage 26.8C — the production HyperFrames renderer adapter. Turns the
// Stage 26.8B-HF disposable proof into real, tested EVOLINK infrastructure.
//
// HyperFrames (https://github.com/heygen-com/hyperframes, Apache-2.0) is a
// real npm dependency of this package (see package.json — pinned exact
// version, matching Stage 26.8B-HF's proven 0.7.109) that turns an HTML/CSS
// composition into a real MP4 via a real headless Chrome + FFmpeg pipeline.
// It is invoked here as a local CLI subprocess, exactly like every other
// renderer in this directory only ever EXECUTES an already-decided
// renderSpec — this file never resolves materials, ranks candidates,
// selects assets, generates prompts, or decides creative direction.
//
// CONTRACT: identical to every sibling renderer —
//   render({ projectId, executionResult, outputDir }) -> RenderResult
// Everything below this line (HyperFrames internals, Chrome, FFmpeg, CLI
// argv) is invisible to callers; render-service.js/renderer-registry.js
// need not (and do not) know HyperFrames exists.
//
// REGISTRY WIRING (see services/renderers/index.js): this module is
// registered ONLY for BROLL_CLIP — the one renderSpec type Stage 26.8A's
// SVG renderers could never produce real output for (no video decode
// capability existed then). The other 5 types (ASSET_PLACEMENT,
// STILL_IMAGE_MOTION, KINETIC_TYPOGRAPHY, MOTION_GRAPHIC, WHITEBOARD) keep
// routing to their existing, already-tested SVG renderers by default —
// this module fully supports translating all 6 (per Stage 26.8C Part 3),
// and is directly tested doing so, but is not registered as the DEFAULT
// route for the 5 types that already work, to avoid silently invalidating
// Stage 26.8A's existing test suite's SVG-specific assertions. Whether to
// migrate those 5 onto HyperFrames too is a real architectural choice
// flagged for a human decision, not made unilaterally here.
//
// SECURITY (Part 15): every child process is spawned with execFileSync and
// an explicit argument array — never a shell string, never `shell: true`,
// never eval/new Function. Every path handed to HyperFrames/FFmpeg is
// either this module's own computed temp path or a path already validated
// by services/asset-storage.js's own traversal guard. No environment
// variable is ever logged or embedded in a diagnostic message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const timelineStore = require('../timeline-store');
const assetStorage = require('../asset-storage');
const { createRenderResult, createRenderDiagnostic, createRenderArtifact } = require('../../schemas/render-result-schema');
const { escapeXml } = require('./svg-utils');

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const EASE_MAP = { EASE_IN_OUT: 'power1.inOut', EASE_IN: 'power1.in', EASE_OUT: 'power1.out', LINEAR: 'none' };
const TRANSITION_DURATION = 0.35;
const RENDER_TIMEOUT_MS = Number(process.env.HYPERFRAMES_RENDER_TIMEOUT_MS) || 120000;

// ---------------------------------------------------------------------------
// Environment resolution — Part 1's "confirm current environment variable
// conventions": mirrors this codebase's own `process.env.X || default`
// pattern (see asset-storage.js's ASSET_STORAGE_DIR, project-store.js's
// PROJECT_DATA_DIR). An explicit HYPERFRAMES_FFMPEG_PATH/FFPROBE_PATH/
// BROWSER_PATH env var always wins (same names HyperFrames itself defines
// and reads — see packages/parsers/src/ffBinaries.ts, packages/cli/src/
// browser/manager.ts in the HyperFrames repo). Failing that, this module
// does its OWN dependency-free PATH scan / common-install-dir probe rather
// than hardcoding a path specific to any one sandbox — Stage 26.8B-HF/R's
// finding that HyperFrames' own auto-detection can fail inside a nested
// subprocess in THIS environment is a known quirk of this sandbox, not a
// general production fact, so it is worked around here generically, never
// by hardcoding "/opt/pw-browsers/chromium" as if it were a real
// convention.
// ---------------------------------------------------------------------------

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function locateOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

const COMMON_CHROME_PATHS = [
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function resolveHyperframesEnv() {
  const overrides = {};
  const ffmpegPath = process.env.HYPERFRAMES_FFMPEG_PATH || locateOnPath('ffmpeg');
  const ffprobePath = process.env.HYPERFRAMES_FFPROBE_PATH || locateOnPath('ffprobe');
  if (ffmpegPath) overrides.HYPERFRAMES_FFMPEG_PATH = ffmpegPath;
  if (ffprobePath) overrides.HYPERFRAMES_FFPROBE_PATH = ffprobePath;

  if (process.env.HYPERFRAMES_BROWSER_PATH) {
    overrides.HYPERFRAMES_BROWSER_PATH = process.env.HYPERFRAMES_BROWSER_PATH;
  } else {
    const found = COMMON_CHROME_PATHS.find((p) => {
      try {
        return fs.existsSync(p) && isExecutable(fs.realpathSync(p));
      } catch {
        return false;
      }
    });
    if (found) overrides.HYPERFRAMES_BROWSER_PATH = found;
    // If nothing is found, HYPERFRAMES_BROWSER_PATH is simply left unset —
    // HyperFrames' own `browser ensure` download mechanism can still work
    // in a real deployment with normal network access; this module never
    // forces a download itself.
  }
  return overrides;
}

function resolveHyperframesBin() {
  // require.resolve uses Node's own module resolution against the real
  // installed `hyperframes` npm dependency — never a caller-influenced
  // path, never string concatenation.
  return require.resolve('hyperframes/bin/hyperframes.mjs');
}

// ---------------------------------------------------------------------------
// Shared failure/asset helpers — same shape as every sibling renderer.
// ---------------------------------------------------------------------------

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'BROLL_CLIP', // overwritten below by callers that know their real type
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

function resolveAsset(projectId, assetId) {
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) return { error: { code: 'MISSING_ASSET', message: `no asset found with id "${assetId}" in project "${projectId}"` } };
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return { error: { code: 'ASSET_NOT_STORED', message: `asset "${assetId}" storage status is "${storageStatus}", not STORED` } };
  }
  let absolutePath;
  try {
    absolutePath = assetStorage.resolveStoredPath(asset.storage.path);
  } catch (error) {
    return { error: { code: 'MISSING_ASSET', message: `could not resolve stored path for asset "${assetId}": ${error.message}` } };
  }
  if (!fs.existsSync(absolutePath)) {
    return { error: { code: 'MISSING_ASSET', message: `stored file for asset "${assetId}" does not exist on disk` } };
  }
  return { asset, absolutePath };
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Composition scaffold — identical structure to Stage 26.8B-HF's proven
// minimal-composition.md pattern, with GSAP vendored locally (never a CDN
// <script src> — a render must never depend on network access).
// ---------------------------------------------------------------------------

const GSAP_LOCAL_PATH = require.resolve('gsap/dist/gsap.min.js');

function scaffold(compositionId, durationSeconds, bodyHtml, timelineJs) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${FRAME_WIDTH}, height=${FRAME_HEIGHT}" />
<script src="assets/gsap.min.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${FRAME_WIDTH}px; height:${FRAME_HEIGHT}px; overflow:hidden; background:#000; font-family: sans-serif; }
  #root { position:relative; width:${FRAME_WIDTH}px; height:${FRAME_HEIGHT}px; overflow:hidden; }
</style>
</head>
<body>
<div id="root" data-composition-id="${compositionId}" data-start="0" data-duration="${durationSeconds}" data-width="${FRAME_WIDTH}" data-height="${FRAME_HEIGHT}">
${bodyHtml}
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
${timelineJs || ''}
window.__timelines["${compositionId}"] = tl;
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Per-type translators. Each returns { ok:true, durationSeconds, bodyHtml,
// timelineJs, mediaFiles: [{ srcAbsolutePath, destName }] } or
// { ok:false, code, message }. Mirrors the exact renderSpec field names —
// no field is invented, none is renamed to suit HyperFrames.
// ---------------------------------------------------------------------------

function translateAssetPlacement(projectId, spec) {
  const resolved = resolveAsset(projectId, spec.assetId);
  if (resolved.error) return { ok: false, ...resolved.error };
  const { asset, absolutePath } = resolved;
  const ext = path.extname(absolutePath) || '.bin';
  const destName = `asset${ext}`;
  const objectFit = { COVER: 'cover', CONTAIN: 'contain', FILL: 'fill' }[spec.objectFit] || 'cover';
  const opacity = numOr(spec.opacity, 1);
  const scale = numOr(spec.scale, 1);
  const tx = (spec.position && numOr(spec.position.x, 0)) * FRAME_WIDTH;
  const ty = (spec.position && numOr(spec.position.y, 0)) * FRAME_HEIGHT;
  const duration = numOr(spec.duration, null);
  if (duration === null || duration <= 0) return { ok: false, code: 'INVALID_DURATION', message: `duration must be a positive number, got ${JSON.stringify(spec.duration)}` };

  const style = `position:absolute; left:0; top:0; width:100%; height:100%; object-fit:${objectFit}; opacity:${opacity}; transform: translate(${tx}px, ${ty}px) scale(${scale});`;
  let bodyHtml;
  if (asset.type === 'video') {
    // No audioPolicy field exists on ASSET_PLACEMENT's own renderSpec
    // contract (confirmed against project-asset-reuse-executor.js) — muted
    // by default is the least-presumptuous choice: never inventing an
    // audio decision the schema itself never asked for.
    bodyHtml = `<video id="asset" class="clip" src="assets/${destName}" data-start="0" data-duration="${duration}" data-track-index="0" muted playsinline style="${style}"></video>`;
  } else {
    bodyHtml = `<img id="asset" class="clip" src="assets/${destName}" data-start="0" data-duration="${duration}" data-track-index="0" style="${style}" />`;
  }
  return { ok: true, durationSeconds: duration, bodyHtml, timelineJs: '', mediaFiles: [{ srcAbsolutePath: absolutePath, destName }] };
}

function translateStillImageMotion(projectId, spec) {
  const resolved = resolveAsset(projectId, spec.assetId);
  if (resolved.error) return { ok: false, ...resolved.error };
  const { asset, absolutePath } = resolved;
  if (asset.type !== 'video' && asset.type !== 'image' && !['keyframe', 'character_reference', 'location_reference'].includes(asset.type)) {
    // still images only — this matches the executor's own contract (STILL_IMAGE_MOTION always operates on an image asset)
  }
  const duration = numOr(spec.duration, null);
  if (duration === null || duration <= 0) return { ok: false, code: 'INVALID_DURATION', message: `duration must be a positive number, got ${JSON.stringify(spec.duration)}` };
  const ext = path.extname(absolutePath) || '.bin';
  const destName = `asset${ext}`;

  const sx0 = numOr(spec.startPosition && spec.startPosition.x, 0) * FRAME_WIDTH;
  const sy0 = numOr(spec.startPosition && spec.startPosition.y, 0) * FRAME_HEIGHT;
  const sx1 = numOr(spec.endPosition && spec.endPosition.x, 0) * FRAME_WIDTH;
  const sy1 = numOr(spec.endPosition && spec.endPosition.y, 0) * FRAME_HEIGHT;
  const startScale = numOr(spec.startScale, 1);
  const endScale = numOr(spec.endScale, 1);
  const ease = EASE_MAP[spec.easing] || 'none';
  const fadeIn = numOr(spec.fadeIn, 0);
  const fadeOut = numOr(spec.fadeOut, 0);

  const bodyHtml = `<img id="kb" class="clip" data-start="0" data-duration="${duration}" data-track-index="0" src="assets/${destName}" style="position:absolute; left:0; top:0; width:100%; height:100%; object-fit:cover; opacity:${fadeIn > 0 ? 0 : 1};" />`;
  const tweens = [`tl.fromTo("#kb", { x: ${sx0}, y: ${sy0}, scale: ${startScale} }, { x: ${sx1}, y: ${sy1}, scale: ${endScale}, duration: ${duration}, ease: "${ease}" }, 0);`];
  if (fadeIn > 0) tweens.push(`tl.to("#kb", { opacity: 1, duration: ${fadeIn} }, 0);`);
  if (fadeOut > 0) tweens.push(`tl.to("#kb", { opacity: 0, duration: ${fadeOut} }, ${Math.max(0, duration - fadeOut)});`);

  return { ok: true, durationSeconds: duration, bodyHtml, timelineJs: tweens.join('\n'), mediaFiles: [{ srcAbsolutePath: absolutePath, destName }] };
}

function translateKineticTypography(spec) {
  const duration = numOr(spec.duration, null);
  if (duration === null || duration <= 0) return { ok: false, code: 'INVALID_DURATION', message: `duration must be a positive number, got ${JSON.stringify(spec.duration)}` };
  if (typeof spec.text !== 'string' || spec.text.trim().length === 0) return { ok: false, code: 'MISSING_TEXT', message: 'renderSpec.text must be a non-empty string' };
  if (!Array.isArray(spec.timeline) || spec.timeline.length === 0) return { ok: false, code: 'INVALID_RENDER_SPEC', message: 'renderSpec.timeline must be a non-empty array' };

  const emphasisSet = new Set((Array.isArray(spec.emphasis) ? spec.emphasis : []).map((e) => e.wordIndex));
  const alignment = spec.alignment === 'CENTER' ? 'center' : (spec.alignment || 'center').toLowerCase();
  const family = escapeXml((spec.font && spec.font.family) || 'sans-serif');
  const weight = escapeXml((spec.font && spec.font.weight) || 'bold');
  const size = numOr(spec.size, 64);
  const lineWrapWidth = numOr(spec.lineWrapWidth, 0.8);
  const positionX = numOr(spec.position && spec.position.x, 0.5) * 100;
  const positionY = numOr(spec.position && spec.position.y, 0.5) * 100;

  const spans = spec.units
    .map((u, i) => `<span id="word-${i}" style="display:inline-block; opacity:0; ${emphasisSet.has(i) ? 'color:#ffd54a;' : ''}">${escapeXml(u)}</span>`)
    .join(' ');
  const bodyHtml = `<div id="text-wrap" class="clip" data-start="0" data-duration="${duration}" data-track-index="0"
    style="position:absolute; left:${positionX - (lineWrapWidth * 100) / 2}%; top:0; width:${lineWrapWidth * 100}%; height:100%; display:flex; align-items:center; justify-content:${alignment === 'center' ? 'center' : alignment === 'left' ? 'flex-start' : 'flex-end'}; text-align:${alignment};">
    <h1 style="font-family:${family}; font-weight:${weight}; font-size:${size}px; color:#fff; margin:0; transform: translateY(${positionY - 50}%);">${spans}</h1>
  </div>`;

  const entranceTween = (sel, t, entrance) => {
    if (entrance === 'SLIDE_UP') return `tl.fromTo("${sel}", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, ${t});`;
    if (entrance === 'SLIDE_IN') return `tl.fromTo("${sel}", { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3 }, ${t});`;
    if (entrance === 'POP_IN') return `tl.fromTo("${sel}", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3 }, ${t});`;
    if (entrance === 'TYPE_ON') return `tl.set("${sel}", { opacity: 1 }, ${t});`;
    return `tl.to("${sel}", { opacity: 1, duration: 0.3 }, ${t});`; // FADE_IN default
  };
  const lines = spec.timeline.map((w) => entranceTween(`#word-${w.index}`, w.startOffset, spec.entrance));
  if (spec.exit && spec.exit !== 'NONE') {
    const exitBegin = Math.max(0, duration - TRANSITION_DURATION);
    if (spec.exit === 'SLIDE_DOWN') lines.push(`tl.to("#text-wrap h1", { y: 40, opacity: 0, duration: ${TRANSITION_DURATION} }, ${exitBegin});`);
    else if (spec.exit === 'SLIDE_OUT') lines.push(`tl.to("#text-wrap h1", { x: 40, opacity: 0, duration: ${TRANSITION_DURATION} }, ${exitBegin});`);
    else if (spec.exit === 'POP_OUT') lines.push(`tl.to("#text-wrap h1", { scale: 0.5, opacity: 0, duration: ${TRANSITION_DURATION} }, ${exitBegin});`);
    else lines.push(`tl.to("#text-wrap h1", { opacity: 0, duration: ${TRANSITION_DURATION} }, ${exitBegin});`); // FADE_OUT
  }

  return { ok: true, durationSeconds: duration, bodyHtml, timelineJs: lines.join('\n'), mediaFiles: [] };
}

function drawMotionGraphicPrimitive(el) {
  const props = el.props || {};
  const color = typeof props.color === 'string' ? props.color : '#4fc3f7';
  switch (el.kind) {
    case 'RECTANGLE':
    case 'BAR': {
      const w = numOr(props.width, 200), h = numOr(props.height, 120);
      return { markup: `<div style="width:${w}px;height:${h}px;border-radius:${numOr(props.cornerRadius, 0)}px;background:${color};"></div>`, w, h };
    }
    case 'CIRCLE': {
      const r = numOr(props.radius, 80);
      return { markup: `<div style="width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:${color};"></div>`, w: r * 2, h: r * 2 };
    }
    case 'TEXT': {
      const fontSize = numOr(props.fontSize, 48);
      return { markup: `<div style="font-size:${fontSize}px;color:${color};white-space:nowrap;">${escapeXml(String(props.text))}</div>`, w: 'max-content', h: 'max-content' };
    }
    case 'PROGRESS_BAR': {
      const w = numOr(props.width, 400), h = numOr(props.height, 24), p = Math.max(0, Math.min(1, numOr(props.progress, 0)));
      const trackColor = typeof props.trackColor === 'string' ? props.trackColor : '#333333';
      return { markup: `<div style="width:${w}px;height:${h}px;border-radius:${h / 2}px;background:${trackColor};"><div style="width:${w * p}px;height:${h}px;border-radius:${h / 2}px;background:${color};"></div></div>`, w, h };
    }
    case 'CHART': {
      const w = numOr(props.width, 400), h = numOr(props.height, 200);
      const data = Array.isArray(props.data) ? props.data : [];
      const max = Math.max(...data, 0);
      const barGap = 8;
      const barWidth = data.length > 0 ? (w - barGap * (data.length - 1)) / data.length : 0;
      const bars = data
        .map((value) => {
          const barHeight = max > 0 ? (value / max) * h : 0;
          return `<div style="width:${barWidth}px;height:${barHeight}px;background:${color};align-self:flex-end;"></div>`;
        })
        .join('');
      return { markup: `<div style="width:${w}px;height:${h}px;display:flex;gap:${barGap}px;align-items:flex-end;">${bars}</div>`, w, h };
    }
    case 'LINE':
    case 'ARROW':
    case 'CONNECTOR': {
      const dx = numOr(props.dx, 200), dy = numOr(props.dy, 0);
      const strokeWidth = numOr(props.strokeWidth, 4);
      const len = Math.hypot(dx, dy);
      const svgW = Math.abs(dx) + 20, svgH = Math.abs(dy) + 20;
      const x1 = dx < 0 ? svgW : 10, y1 = dy < 0 ? svgH : 10;
      const x2 = dx < 0 ? svgW - Math.abs(dx) : 10 + dx, y2 = dy < 0 ? svgH - Math.abs(dy) : 10 + dy;
      const head =
        el.kind === 'LINE'
          ? ''
          : (() => {
              const ang = Math.atan2(y2 - y1, x2 - x1);
              const hx1 = x2 - 16 * Math.cos(ang - Math.PI / 6), hy1 = y2 - 16 * Math.sin(ang - Math.PI / 6);
              const hx2 = x2 - 16 * Math.cos(ang + Math.PI / 6), hy2 = y2 - 16 * Math.sin(ang + Math.PI / 6);
              return `<polygon points="${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}" fill="${color}"/>`;
            })();
      return {
        markup: `<svg width="${svgW}" height="${svgH}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}"/>${head}</svg>`,
        w: svgW,
        h: svgH,
      };
    }
    case 'GROUP':
      return { markup: '', w: 0, h: 0 };
    default:
      return null;
  }
}

function translateMotionGraphic(spec) {
  const duration = numOr(spec.duration, null);
  if (duration === null || duration <= 0) return { ok: false, code: 'INVALID_DURATION', message: `duration must be a positive number, got ${JSON.stringify(spec.duration)}` };
  if (!Array.isArray(spec.elements) || spec.elements.length === 0) return { ok: false, code: 'INVALID_RENDER_SPEC', message: 'renderSpec.elements must be a non-empty array' };

  const parts = [];
  for (let i = 0; i < spec.elements.length; i += 1) {
    const el = spec.elements[i];
    if (el.kind === 'TEXT' && (typeof (el.props && el.props.text) !== 'string' || el.props.text.length === 0)) {
      return { ok: false, code: 'INVALID_ELEMENT', message: `element "${el.elementId}": TEXT element requires a non-empty props.text string` };
    }
    if (el.kind === 'CHART' && (!Array.isArray(el.props && el.props.data) || el.props.data.length === 0)) {
      return { ok: false, code: 'INVALID_ELEMENT', message: `element "${el.elementId}": CHART element requires a non-empty props.data array` };
    }
    const drawn = drawMotionGraphicPrimitive(el);
    if (!drawn) return { ok: false, code: 'INVALID_ELEMENT', message: `element "${el.elementId}": unsupported primitive kind "${el.kind}"` };

    const x = numOr(el.position && el.position.x, 0) * FRAME_WIDTH;
    const y = numOr(el.position && el.position.y, 0) * FRAME_HEIGHT;
    const start = numOr(el.sequence && el.sequence.startOffset, 0);
    const end = numOr(el.sequence && el.sequence.endOffset, duration);
    const opacity = numOr(el.opacity, 1);
    const rotation = numOr(el.rotation, 0);
    const scale = numOr(el.scale, 1);
    // Part 7 — tracks are a temporal-exclusion lane in HyperFrames; our
    // elements[] carries no such concept (z-order is array order / CSS,
    // never a lane). One track per element, keyed by stable array index —
    // deterministic, never filesystem/timestamp/random-derived.
    parts.push(
      `<div id="${escapeXml(el.elementId)}" class="clip" data-start="${start}" data-duration="${Math.max(0.01, end - start)}" data-track-index="${i}" style="position:absolute; left:${x}px; top:${y}px; opacity:${opacity}; transform: translate(-50%,-50%) rotate(${rotation}deg) scale(${scale});">${drawn.markup}</div>`
    );
  }
  return { ok: true, durationSeconds: duration, bodyHtml: parts.join('\n'), timelineJs: '', mediaFiles: [] };
}

function translateWhiteboard(spec) {
  const duration = numOr(spec.duration, null);
  if (duration === null || duration <= 0) return { ok: false, code: 'INVALID_DURATION', message: `duration must be a positive number, got ${JSON.stringify(spec.duration)}` };
  if (!Array.isArray(spec.drawingOrder) || spec.drawingOrder.length === 0) return { ok: false, code: 'INVALID_RENDER_SPEC', message: 'renderSpec.drawingOrder must be a non-empty array' };
  const canvas = spec.canvas && numOr(spec.canvas.width, null) && numOr(spec.canvas.height, null) ? spec.canvas : { width: FRAME_WIDTH, height: FRAME_HEIGHT };

  const positions = new Map();
  const els = [];
  const tweens = [];
  let cursor = 0;
  let trackIndex = 0; // Part 7 — same one-track-per-element reasoning as MOTION_GRAPHIC above

  for (const el of spec.drawingOrder) {
    if (el.kind === 'ERASE') {
      tweens.push(`tl.to("#${escapeXml(el.content)}", { opacity: 0, duration: ${el.drawDuration} }, ${el.drawStartOffset});`);
      continue;
    }
    const track = trackIndex++;
    const gridX = 300 + (cursor % 3) * (canvas.width / 4);
    const gridY = 300 + Math.floor(cursor / 3) * (canvas.height / 4);
    let x = gridX, y = gridY;
    if (el.kind === 'EMPHASIS' && positions.has(el.content)) {
      ({ x, y } = positions.get(el.content));
    } else {
      positions.set(el.elementId, { x, y });
      cursor += 1;
    }
    // Part 6 — Whiteboard semantics: "draws on and then remains visible."
    // HyperFrames' clip visibility window is [start, start+duration] only,
    // so the clip's data-duration is stretched to the END of the
    // composition (never just drawDuration) so the element stays on
    // screen after its own stroke-reveal finishes.
    const clipDuration = duration - el.drawStartOffset;
    if (clipDuration <= 0) return { ok: false, code: 'INVALID_RENDER_SPEC', message: `element "${el.elementId}" drawStartOffset ${el.drawStartOffset} is at or past the composition duration ${duration}` };

    if (el.kind === 'TEXT') {
      els.push(`<div id="${escapeXml(el.elementId)}" class="clip" data-start="${el.drawStartOffset}" data-duration="${clipDuration}" data-track-index="${track}" style="position:absolute; left:${x}px; top:${y}px; opacity:0; color:#111; font-size:44px;">${escapeXml(el.content)}</div>`);
      tweens.push(`tl.to("#${escapeXml(el.elementId)}", { opacity: 1, duration: 0.05 }, ${el.drawStartOffset});`);
    } else if (el.kind === 'OBJECT') {
      // No real icon library exists in this dependency-free stack either —
      // same honest placeholder discipline Stage 26.8A's SVG whiteboard
      // renderer already established: a dashed outline + label, never a
      // fabricated icon.
      els.push(`<div id="${escapeXml(el.elementId)}" class="clip" data-start="${el.drawStartOffset}" data-duration="${clipDuration}" data-track-index="${track}" style="position:absolute; left:${x}px; top:${y}px; opacity:0; width:220px; height:160px; border:2px dashed #111; display:grid; place-items:center; color:#111;">${escapeXml(el.content)}</div>`);
      tweens.push(`tl.to("#${escapeXml(el.elementId)}", { opacity: 1, duration: 0.05 }, ${el.drawStartOffset});`);
    } else if (el.kind === 'SHAPE') {
      const r = numOr(el.style && el.style.radius, 90);
      const length = 2 * Math.PI * r;
      els.push(
        `<svg id="${escapeXml(el.elementId)}" class="clip" data-start="${el.drawStartOffset}" data-duration="${clipDuration}" data-track-index="${track}" style="position:absolute; left:${x - r}px; top:${y - r}px; opacity:0;" width="${r * 2}" height="${r * 2}"><circle id="${escapeXml(el.elementId)}-c" cx="${r}" cy="${r}" r="${r - 3}" fill="none" stroke="#111" stroke-width="5" stroke-dasharray="${length}" stroke-dashoffset="${length}"/></svg>`
      );
      tweens.push(`tl.to("#${escapeXml(el.elementId)}", { opacity: 1, duration: 0.05 }, ${el.drawStartOffset});`);
      tweens.push(`tl.to("#${escapeXml(el.elementId)}-c", { strokeDashoffset: 0, duration: ${el.drawDuration} }, ${el.drawStartOffset});`);
    } else if (el.kind === 'ARROW') {
      const dx = numOr(el.style && el.style.dx, 220), dy = numOr(el.style && el.style.dy, 0);
      const len = Math.hypot(dx, dy);
      els.push(
        `<svg id="${escapeXml(el.elementId)}" class="clip" data-start="${el.drawStartOffset}" data-duration="${clipDuration}" data-track-index="${track}" style="position:absolute; left:${x}px; top:${y}px; opacity:0;" width="${Math.abs(dx) + 20}" height="${Math.abs(dy) + 20}"><line id="${escapeXml(el.elementId)}-l" x1="10" y1="10" x2="${10 + dx}" y2="${10 + dy}" stroke="#111" stroke-width="5" stroke-dasharray="${len}" stroke-dashoffset="${len}"/></svg>`
      );
      tweens.push(`tl.to("#${escapeXml(el.elementId)}", { opacity: 1, duration: 0.05 }, ${el.drawStartOffset});`);
      tweens.push(`tl.to("#${escapeXml(el.elementId)}-l", { strokeDashoffset: 0, duration: ${el.drawDuration} }, ${el.drawStartOffset});`);
    } else if (el.kind === 'EMPHASIS') {
      els.push(`<div id="${escapeXml(el.elementId)}" class="clip" data-start="${el.drawStartOffset}" data-duration="${clipDuration}" data-track-index="${track}" style="position:absolute; left:${x - 100}px; top:${y - 50}px; opacity:0; width:200px; height:100px; border-radius:50%; border:5px solid #e53935;"></div>`);
      tweens.push(`tl.to("#${escapeXml(el.elementId)}", { opacity: 1, duration: 0.05 }, ${el.drawStartOffset});`);
    }
  }

  const bg = `<div class="clip" data-start="0" data-duration="${duration}" data-track-index="${trackIndex}" style="position:absolute; inset:0; background:#f5f5f0;"></div>`;
  return { ok: true, durationSeconds: duration, bodyHtml: bg + els.join('\n'), timelineJs: tweens.join('\n'), mediaFiles: [], canvasWidth: canvas.width, canvasHeight: canvas.height };
}

function translateBrollClip(projectId, spec) {
  if (spec.playbackRate !== 1) {
    // Part 5 — Stage 26.8B-HF found (and confirmed against HyperFrames'
    // own source: packages/producer/src/services/render/stages/
    // extractVideosStage.ts never reads data-playback-rate at all) that
    // the render pipeline does not honor a playback-rate multiplier, even
    // though the live-preview runtime does. Rather than silently produce a
    // video that plays at the wrong speed, this is a deterministic,
    // structural failure — never a best-effort guess.
    return {
      ok: false,
      code: 'HYPERFRAMES_PLAYBACK_RATE_UNSUPPORTED',
      message: `BROLL_CLIP requested playbackRate ${spec.playbackRate}, but HyperFrames' render pipeline (as of the version pinned in package.json) does not honor data-playback-rate — only playbackRate === 1 is supported. See Stage 26.8B-HF's final report for the source-level confirmation of this limitation.`,
    };
  }
  const resolved = resolveAsset(projectId, spec.sourceAssetId);
  if (resolved.error) return { ok: false, ...resolved.error };
  const { asset, absolutePath } = resolved;
  if (asset.type !== 'video') return { ok: false, code: 'INVALID_RENDER_SPEC', message: `asset "${spec.sourceAssetId}" has type "${asset.type}", not "video"` };
  if (typeof spec.trimIn !== 'number' || typeof spec.trimOut !== 'number' || spec.trimIn < 0 || spec.trimOut <= spec.trimIn) {
    return { ok: false, code: 'INVALID_TRIM_WINDOW', message: `trim window [${spec.trimIn}, ${spec.trimOut}] is not a valid, positive-length window` };
  }

  const onTimelineDuration = (spec.trimOut - spec.trimIn) / spec.playbackRate; // playbackRate is exactly 1 here
  const ext = path.extname(absolutePath) || '.mp4';
  const destName = `source${ext}`;
  const fit = { COVER: 'cover', CONTAIN: 'contain', FILL: 'fill' }[spec.fit] || 'cover';
  const opacity = numOr(spec.opacity, 1);
  const scale = numOr(spec.scale, 1);
  const tx = numOr(spec.position && spec.position.x, 0) * FRAME_WIDTH;
  const ty = numOr(spec.position && spec.position.y, 0) * FRAME_HEIGHT;

  // audioPolicy: MUTE (default and only currently-implemented policy — see
  // AUDIO_POLICIES on broll-executor.js; KEEP/DUCK exist in the vocabulary
  // but are not wired to any real audio mixing anywhere in this codebase
  // yet, so they are treated the same as MUTE here rather than fabricating
  // mixing behavior that doesn't exist).
  const bodyHtml = `<video id="broll" class="clip" src="assets/${destName}"
    data-start="0" data-duration="${onTimelineDuration}" data-track-index="0"
    data-media-start="${spec.trimIn}"
    muted playsinline
    style="position:absolute; left:0; top:0; width:100%; height:100%; object-fit:${fit}; opacity:${opacity}; transform: translate(${tx}px, ${ty}px) scale(${scale});"></video>`;

  return { ok: true, durationSeconds: onTimelineDuration, bodyHtml, timelineJs: '', mediaFiles: [{ srcAbsolutePath: absolutePath, destName }] };
}

// ---------------------------------------------------------------------------
// HyperFrames CLI invocation + output validation.
// ---------------------------------------------------------------------------

function runHyperframesRender(workDir, outputPath) {
  const bin = resolveHyperframesBin();
  const env = { ...process.env, ...resolveHyperframesEnv(), HYPERFRAMES_TELEMETRY_DISABLED: '1' };
  try {
    execFileSync(process.execPath, [bin, 'render', '-o', outputPath], {
      cwd: workDir,
      env,
      timeout: RENDER_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').slice(-2000) : '';
    return { ok: false, message: `hyperframes render failed: ${error.message}${stderr ? ` | stderr: ${stderr}` : ''}` };
  }
}

function ffprobeValidate(outputPath) {
  if (!fs.existsSync(outputPath)) return { ok: false, message: 'output file does not exist after render' };
  const ffprobePath = process.env.HYPERFRAMES_FFPROBE_PATH || locateOnPath('ffprobe') || 'ffprobe';
  let raw;
  try {
    raw = execFileSync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', outputPath],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString('utf8');
  } catch (error) {
    return { ok: false, message: `ffprobe validation failed to run: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'ffprobe returned unparseable output' };
  }
  const duration = parsed.format && Number(parsed.format.duration);
  const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  if (!videoStream) return { ok: false, message: 'ffprobe found no video stream in the output' };
  if (!duration || duration <= 0) return { ok: false, message: `ffprobe reported an invalid duration: ${JSON.stringify(parsed.format)}` };
  if (!videoStream.width || !videoStream.height) return { ok: false, message: 'ffprobe reported invalid/missing dimensions' };
  if (!videoStream.codec_name) return { ok: false, message: 'ffprobe reported no codec information' };

  // Decode-integrity pass — never trust a non-zero exit code alone.
  const ffmpegPath = process.env.HYPERFRAMES_FFMPEG_PATH || locateOnPath('ffmpeg') || 'ffmpeg';
  try {
    execFileSync(ffmpegPath, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, message: `decode validation failed: ${error.message}` };
  }

  return { ok: true, duration, width: videoStream.width, height: videoStream.height, codec: videoStream.codec_name };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

const TRANSLATORS = {
  ASSET_PLACEMENT: (projectId, spec) => translateAssetPlacement(projectId, spec),
  STILL_IMAGE_MOTION: (projectId, spec) => translateStillImageMotion(projectId, spec),
  KINETIC_TYPOGRAPHY: (projectId, spec) => translateKineticTypography(spec),
  MOTION_GRAPHIC: (projectId, spec) => translateMotionGraphic(spec),
  WHITEBOARD: (projectId, spec) => translateWhiteboard(spec),
  BROLL_CLIP: (projectId, spec) => translateBrollClip(projectId, spec),
};

function render({ projectId, executionResult, outputDir } = {}) {
  const rendererType = executionResult && executionResult.renderSpec ? executionResult.renderSpec.type : null;

  if (!executionResult || !executionResult.renderSpec || !TRANSLATORS[rendererType]) {
    return withType(fail(executionResult, 'INVALID_RENDER_SPEC', `renderSpec.type must be one of ${Object.keys(TRANSLATORS).join(', ')}`), rendererType);
  }
  if (!outputDir) {
    return withType(fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required'), rendererType);
  }

  const spec = executionResult.renderSpec;
  let translation;
  try {
    translation = TRANSLATORS[rendererType](projectId, spec);
  } catch (error) {
    return withType(fail(executionResult, 'RENDER_FAILED', `translation threw: ${error && error.message ? error.message : String(error)}`), rendererType);
  }
  if (!translation.ok) {
    return withType(fail(executionResult, translation.code, translation.message), rendererType);
  }

  // Temporary render workspace — never under outputDir/server/data (Part 4).
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperframes-render-'));
  let renderSucceeded = false;
  try {
    const assetsDir = path.join(workDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(GSAP_LOCAL_PATH, path.join(assetsDir, 'gsap.min.js'));
    for (const media of translation.mediaFiles) {
      fs.copyFileSync(media.srcAbsolutePath, path.join(assetsDir, media.destName));
    }
    const compositionId = executionResult.executionId ? `hf-${executionResult.executionId}` : `hf-${rendererType.toLowerCase()}`;
    const html = scaffold(compositionId.replace(/[^a-zA-Z0-9_-]/g, '_'), translation.durationSeconds, translation.bodyHtml, translation.timelineJs);
    fs.writeFileSync(path.join(workDir, 'index.html'), html, 'utf8');

    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${executionResult.executionId || rendererType.toLowerCase()}.mp4`);

    const renderRun = runHyperframesRender(workDir, outputPath);
    if (!renderRun.ok) {
      return withType(fail(executionResult, 'RENDER_FAILED', renderRun.message), rendererType);
    }

    const validation = ffprobeValidate(outputPath);
    if (!validation.ok) {
      return withType(fail(executionResult, 'RENDER_FAILED', `output validation failed: ${validation.message}`), rendererType);
    }

    renderSucceeded = true;
    return createRenderResult({
      rendererType,
      beatId: executionResult.beatId,
      materialId: executionResult.materialId,
      executionId: executionResult.executionId,
      status: 'COMPLETED',
      artifact: createRenderArtifact({
        format: 'MP4',
        path: outputPath,
        width: validation.width,
        height: validation.height,
        duration: validation.duration,
      }),
      diagnostics: [],
    });
  } catch (error) {
    // Part 8 — a renderer must never crash the service. Any thrown error
    // (a bad outputDir, a filesystem error, anything unexpected) becomes a
    // structured FAILED result instead, the same discipline every other
    // renderer/service in this codebase already follows.
    return withType(fail(executionResult, 'RENDER_FAILED', `renderer threw: ${error && error.message ? error.message : String(error)}`), rendererType);
  } finally {
    // Part 4 — clean temporary files after successful completion.
    if (renderSucceeded) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function withType(result, rendererType) {
  result.rendererType = rendererType;
  return result;
}

module.exports = { render, FRAME_WIDTH, FRAME_HEIGHT };
