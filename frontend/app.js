// app.js — EvoLink Video Factory frontend (Stage 10).
//
// Plain vanilla JavaScript, no build step, no framework. This file only
// fetches data from the existing backend (server/index.js) and renders it
// — it never computes budget/approval/lineage logic itself (that all
// already lives in server/services/*.js). Read-only: nothing here ever
// calls request_generation or any endpoint that changes data.

const state = {
  projects: [],
  selectedProjectId: null,
  project: null, // full project doc (includes scenes[] and shots[])
  budget: null,
  selectedShotId: null,
  shotHistory: null, // { shotId, generations, totalCount }
  selectedGenerationId: null,

  // Stage 11C — Creative Director workspace. Shares selectedProjectId
  // above with Production; everything else here is scoped to the
  // Creative Director view only.
  creative: {
    loadedForProjectId: null,
    activeArtifact: null, // 'brief' | 'spec' | 'bible' | 'characters' | 'locations' | 'storyboard'
    brief: null,
    spec: null,
    bible: null,
    storyboard: null,
    bibleTab: 'world',
    selectedCharacterIndex: null,
    selectedLocationIndex: null,
    selectedPropIndex: null,
    selectedShotId: null,

    // Stage 12 — Keyframe Intelligence. Read-only display state; nothing
    // here is ever sent to a provider or turned into a generation job.
    keyframePlan: null,
    keyframeWorkload: null, // { totalRequired, reusable, newRecommended, alreadyPlanned } aggregated client-side
    shotAnalysis: null, // last analyze_shot_keyframes result shown in the Shot Editor

    // Stage 13A — Keyframe Prompt Packaging. Read-only display state; a
    // package is only ever BUILT (deterministic, local) or VIEWED here —
    // nothing in this section can generate, execute, or submit anything.
    viewedPackageKeyframeId: null,
    viewedPackage: null,

    // Stage 13B — Controlled Keyframe Generation. Read/write, but every
    // write here (request/approve/reject generation approval, GENERATE
    // KEYFRAME, approve/reject the result) is an explicit human button
    // click — nothing on this page ever fires automatically. The server
    // (services/keyframe-generation-service.js) re-checks every safety
    // condition itself regardless of what this UI computes for its
    // disabled/enabled button state.
    viewedGenerationKeyframeId: null,
    viewedGenerationData: null, // { approval, generations, pkg, budget }
  },
};

// --- small fetch helper -----------------------------------------------------

async function fetchJson(url, options = {}) {
  const fetchOptions = { method: options.method || 'GET' };
  if (options.body !== undefined) {
    fetchOptions.headers = { 'Content-Type': 'application/json' };
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      // response wasn't JSON — keep the default message
    }
    throw new Error(message);
  }
  return res.json();
}

// --- generic state-box rendering (loading / error / empty) ------------------

function showLoading(container) {
  container.innerHTML = '';
  container.textContent = 'Loading...';
}

function showError(container, retryFn) {
  container.innerHTML = '';
  const message = document.createElement('div');
  message.className = 'state-box error';
  message.textContent = 'Something went wrong.';
  container.appendChild(message);

  if (retryFn) {
    const btn = document.createElement('button');
    btn.className = 'retry-btn';
    btn.textContent = 'Retry';
    btn.addEventListener('click', retryFn);
    container.appendChild(btn);
  }
}

function showEmpty(container, message) {
  container.innerHTML = '';
  container.textContent = message;
}

// --- small display helpers ---------------------------------------------------

function displayValue(value) {
  return value === null || value === undefined || value === '' ? 'Unknown' : String(value);
}

function fmtDate(iso) {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString();
}

function infoRow(label, value) {
  const row = document.createElement('div');
  row.className = 'info-row';

  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;

  const shown = displayValue(value);
  const v = document.createElement('span');
  v.className = shown === 'Unknown' ? 'value unknown' : 'value';
  v.textContent = shown;

  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function metaSpan(label, value) {
  const span = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  span.appendChild(strong);
  span.appendChild(document.createTextNode(displayValue(value)));
  return span;
}

function statusBadge(status) {
  const span = document.createElement('span');
  const key = (status || 'unknown').toLowerCase();
  span.className = `badge badge-${key}`;
  span.textContent = status || 'UNKNOWN';
  return span;
}

function approvalBadge(approvalStatus) {
  const key = approvalStatus || 'NONE';
  const label = key === 'APPROVED' ? 'Approved' : key === 'REJECTED' ? 'Rejected' : 'Candidate';
  const span = document.createElement('span');
  span.className = `badge badge-${key.toLowerCase()}`;
  span.textContent = label;
  return span;
}

// --- projects (LEFT panel, top) ----------------------------------------------

async function loadProjects() {
  const container = document.getElementById('project-list');
  showLoading(container);
  try {
    const projects = await fetchJson('/projects');
    state.projects = projects;
    renderProjectList();
  } catch {
    showError(container, loadProjects);
  }
}

function renderProjectList() {
  const container = document.getElementById('project-list');
  container.innerHTML = '';

  if (state.projects.length === 0) {
    showEmpty(container, 'No projects yet.');
    return;
  }

  for (const p of state.projects) {
    const item = document.createElement('div');
    item.className = 'project-item' + (p.id === state.selectedProjectId ? ' selected' : '');

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = p.title || 'Untitled project';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${p.status || 'Unknown'} · updated ${fmtDate(p.updatedAt)}`;

    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener('click', () => selectProject(p.id));
    container.appendChild(item);
  }
}

// --- project selection --------------------------------------------------------

async function selectProject(projectId) {
  state.selectedProjectId = projectId;
  state.selectedShotId = null;
  state.shotHistory = null;
  state.selectedGenerationId = null;

  renderProjectList();
  showEmpty(document.getElementById('shot-workspace'), 'Select a shot from the left to see its workspace here.');
  renderGenerationPanel(null);

  await Promise.all([loadProjectDetail(projectId), loadBudget(projectId)]);
}

async function loadProjectDetail(projectId) {
  const container = document.getElementById('tree');
  showLoading(container);
  try {
    const project = await fetchJson(`/projects/${projectId}`);
    state.project = project;
    renderTree();
  } catch {
    showError(container, () => loadProjectDetail(projectId));
  }
}

// --- scene / shot tree (LEFT panel, bottom) -----------------------------------

function shotLabel(shot) {
  const text = shot.narrativePurpose || shot.subjectAction || shot.keyframePrompt || 'Untitled shot';
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

function renderTree() {
  const container = document.getElementById('tree');
  container.innerHTML = '';

  const project = state.project;
  if (!project) {
    showEmpty(container, 'No project selected.');
    return;
  }
  if (!project.scenes || project.scenes.length === 0) {
    showEmpty(container, 'This project has no scenes yet.');
    return;
  }

  for (const scene of project.scenes) {
    const sceneBox = document.createElement('div');
    sceneBox.className = 'tree-scene';

    const title = document.createElement('div');
    title.className = 'tree-scene-title';
    title.textContent = scene.title || 'Untitled scene';
    sceneBox.appendChild(title);

    const shots = (project.shots || []).filter((s) => s.sceneId === scene.sceneId);
    if (shots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'state-box';
      empty.textContent = 'This scene has no shots yet.';
      sceneBox.appendChild(empty);
    } else {
      for (const shot of shots) {
        const shotEl = document.createElement('div');
        shotEl.className = 'tree-shot' + (shot.shotId === state.selectedShotId ? ' selected' : '');
        shotEl.textContent = shotLabel(shot);
        shotEl.addEventListener('click', () => selectShot(shot.shotId));
        sceneBox.appendChild(shotEl);
      }
    }
    container.appendChild(sceneBox);
  }
}

function currentShot() {
  if (!state.project || !state.selectedShotId) return null;
  return (state.project.shots || []).find((s) => s.shotId === state.selectedShotId) || null;
}

// --- shot selection + workspace (CENTER panel) --------------------------------

async function selectShot(shotId) {
  state.selectedShotId = shotId;
  state.selectedGenerationId = null;
  renderTree();
  await loadShotWorkspace(shotId);
}

async function loadShotWorkspace(shotId) {
  const container = document.getElementById('shot-workspace');
  showLoading(container);
  try {
    const history = await fetchJson(`/shots/${shotId}/history`);
    state.shotHistory = history;
    state.selectedGenerationId = history.generations.length > 0 ? history.generations[0].generationId : null;
    renderShotWorkspace();
    renderGenerationPanel(getSelectedGeneration());
  } catch {
    showError(container, () => loadShotWorkspace(shotId));
  }
}

function getSelectedGeneration() {
  if (!state.shotHistory) return null;
  return state.shotHistory.generations.find((g) => g.generationId === state.selectedGenerationId) || null;
}

function renderShotWorkspace() {
  const container = document.getElementById('shot-workspace');
  container.innerHTML = '';

  const shot = currentShot();
  if (!shot || !state.shotHistory) {
    showEmpty(container, 'No data found.');
    return;
  }

  const scene = (state.project.scenes || []).find((sc) => sc.sceneId === shot.sceneId);

  const header = document.createElement('div');
  header.className = 'shot-header';
  const h3 = document.createElement('h3');
  h3.textContent = shotLabel(shot);
  header.appendChild(h3);
  container.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'shot-meta';
  meta.appendChild(metaSpan('Scene', scene ? scene.title || 'Untitled scene' : null));
  meta.appendChild(metaSpan('Status', shot.status));
  meta.appendChild(metaSpan('Generations', state.shotHistory.totalCount));
  container.appendChild(meta);

  const prompt = document.createElement('div');
  prompt.className = 'shot-prompt';
  prompt.textContent = shot.keyframePrompt || shot.motionPrompt || 'No prompt recorded for this shot yet.';
  container.appendChild(prompt);

  // The most recently archived asset for this shot drives the main preview
  // — never the temporary EvoLink URL, only a permanently archived one.
  const latestStored = state.shotHistory.generations.find((g) => g.storageStatus === 'STORED');
  if (latestStored) {
    const video = document.createElement('video');
    video.className = 'video-preview';
    video.controls = true;
    video.src = latestStored.previewUrl;
    container.appendChild(video);

    const downloadLink = document.createElement('a');
    downloadLink.className = 'btn';
    downloadLink.href = latestStored.downloadUrl;
    downloadLink.textContent = 'Download';
    container.appendChild(downloadLink);
  } else {
    const notice = document.createElement('div');
    notice.className = 'state-box';
    notice.textContent = 'The generated result has not been archived.';
    container.appendChild(notice);
  }

  renderHistorySection(container);
}

function renderHistorySection(container) {
  const section = document.createElement('div');
  section.className = 'history-section';

  const h4 = document.createElement('h4');
  h4.textContent = 'Generation History';
  section.appendChild(h4);

  const generations = state.shotHistory.generations;
  if (generations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'This shot has not been generated yet.';
    section.appendChild(empty);
    container.appendChild(section);
    return;
  }

  const list = document.createElement('div');
  list.className = 'history-list';
  // Newest first from the API — number attempts chronologically (oldest = 1)
  // so "Generation 1 / 2 / 3" reads the way a human made them, without ever
  // hiding or overwriting an earlier attempt.
  const total = generations.length;
  generations.forEach((gen, idx) => {
    list.appendChild(renderHistoryCard(gen, total - idx));
  });
  section.appendChild(list);
  container.appendChild(section);
}

function renderHistoryCard(gen, attemptNumber) {
  const card = document.createElement('div');
  card.className = 'history-card' + (gen.generationId === state.selectedGenerationId ? ' selected' : '');
  card.addEventListener('click', () => {
    state.selectedGenerationId = gen.generationId;
    renderShotWorkspace();
    renderGenerationPanel(getSelectedGeneration());
  });

  const label = document.createElement('div');
  label.className = 'gen-label';
  label.textContent = `Generation ${attemptNumber}`;
  card.appendChild(label);

  card.appendChild(statusBadge(gen.status));

  const model = document.createElement('div');
  model.className = 'model';
  model.textContent = displayValue(gen.model);
  card.appendChild(model);

  const cost = document.createElement('div');
  cost.className = 'cost';
  cost.textContent = gen.reservedCost != null ? `${gen.reservedCost} credits reserved` : 'Reserved: Unknown';
  card.appendChild(cost);

  if (gen.assetId) {
    card.appendChild(approvalBadge(gen.assetApprovalStatus));
  }

  const action = document.createElement('div');
  action.className = 'card-action';
  action.textContent = gen.storageStatus === 'STORED' ? 'Preview →' : 'Details →';
  card.appendChild(action);

  return card;
}

// --- generation info panel (RIGHT panel, top) ---------------------------------

function renderGenerationPanel(gen) {
  const container = document.getElementById('generation-panel');
  container.innerHTML = '';

  if (!gen) {
    showEmpty(container, 'No generation selected.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'info-list';

  const params = gen.parameters || {};
  const rows = [
    ['Status', gen.status],
    ['Provider', gen.provider],
    ['Model', gen.model],
    ['Task', gen.task],
    ['Duration', params.duration],
    ['Quality', params.quality],
    ['Aspect ratio', params.aspectRatio],
    ['Reserved credits', gen.reservedCost],
    ['Actual cost', gen.actualCost],
    ['Generation ID', gen.generationId],
    ['Provider task ID', gen.providerTaskId],
  ];
  for (const [label, value] of rows) {
    list.appendChild(infoRow(label, value));
  }
  container.appendChild(list);

  if (gen.storageStatus === 'STORED') {
    const link = document.createElement('a');
    link.className = 'btn btn-secondary';
    link.href = gen.downloadUrl;
    link.textContent = 'Download this generation';
    link.style.marginTop = '12px';
    link.style.display = 'inline-block';
    container.appendChild(link);
  }
}

// --- budget panel (RIGHT panel, bottom) ----------------------------------------

async function loadBudget(projectId) {
  const container = document.getElementById('budget-panel');
  showLoading(container);
  try {
    const budget = await fetchJson(`/projects/${projectId}/budget`);
    state.budget = budget;
    renderBudgetPanel();
  } catch {
    showError(container, () => loadBudget(projectId));
  }
}

function renderBudgetPanel() {
  const container = document.getElementById('budget-panel');
  container.innerHTML = '';

  const b = state.budget;
  if (!b) {
    showEmpty(container, 'Select a project to see its budget.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'info-list';
  list.appendChild(infoRow('Budget limit', b.budgetLimit));
  list.appendChild(infoRow('Reserved', b.reservedCredits));
  list.appendChild(infoRow('Actual spent', b.spentCredits));
  list.appendChild(infoRow('Remaining', b.remainingBudget));
  list.appendChild(infoRow('Overage', b.overageAmount));
  list.appendChild(infoRow('Generation allowed', b.generationAllowed ? 'Yes' : 'No'));
  container.appendChild(list);

  if (!b.generationAllowed) {
    const warning = document.createElement('div');
    warning.className = 'budget-warning';
    warning.textContent = `Generation is blocked: ${b.reason || 'Unknown reason'}`;
    container.appendChild(warning);
  }
}

// ============================================================
// Stage 11C — Creative Director workspace
//
// Read/write, but ONLY for creative planning artifacts (Creative Brief,
// Master Creative Specification, Visual Bible, Storyboard). This section
// never calls anything generation-related — no /assets/*, no
// request_generation-equivalent endpoint exists here, and no button in
// this workspace ever triggers a network call to EvoLink. Every save
// goes through /projects/:id/creative/* (services/creative-store.js),
// which has no code path to a provider, a generation job, or the
// approval/budget gate — see docs/architecture/skill-orchestration.md
// and docs/architecture/creative-intelligence.md.
// ============================================================

// --- view switch (PRODUCTION / CREATIVE DIRECTOR) -----------------------------

function switchView(view) {
  const productionView = document.getElementById('production-view');
  const creativeView = document.getElementById('creative-view');
  const tabProduction = document.getElementById('tab-production');
  const tabCreative = document.getElementById('tab-creative');
  const sub = document.getElementById('topbar-sub');

  if (view === 'creative') {
    productionView.hidden = true;
    creativeView.hidden = false;
    tabProduction.classList.remove('selected');
    tabCreative.classList.add('selected');
    sub.textContent = 'Creative Director — pre-generation planning workspace';
    onEnterCreativeView();
  } else {
    productionView.hidden = false;
    creativeView.hidden = true;
    tabCreative.classList.remove('selected');
    tabProduction.classList.add('selected');
    sub.textContent = 'Production workspace';
  }
}

function onEnterCreativeView() {
  renderCreativeProjectBanner();
  if (!state.selectedProjectId) {
    showEmpty(document.getElementById('creative-editor'), 'Select a project in Production, then choose a creative artifact on the left.');
    renderCreativeVersionPanel(null);
    return;
  }
  if (state.creative.loadedForProjectId !== state.selectedProjectId) {
    loadCreativeRecord(state.selectedProjectId);
  } else {
    selectCreativeArtifact(state.creative.activeArtifact || 'brief');
  }
}

function renderCreativeProjectBanner() {
  const container = document.getElementById('creative-project-banner');
  const project = state.projects.find((p) => p.id === state.selectedProjectId);
  if (!project) {
    showEmpty(container, 'No project selected — pick one in Production first.');
    return;
  }
  container.innerHTML = '';
  const name = document.createElement('div');
  name.className = 'creative-project-name';
  name.textContent = project.title || 'Untitled project';
  container.appendChild(name);
}

async function loadCreativeRecord(projectId) {
  const container = document.getElementById('creative-editor');
  showLoading(container);
  try {
    const record = await fetchJson(`/projects/${projectId}/creative`);
    state.creative.brief = record.creativeBrief;
    state.creative.spec = record.masterCreativeSpec;
    state.creative.bible = record.visualBible;
    state.creative.storyboard = record.storyboard;
    state.creative.loadedForProjectId = projectId;
    state.creative.selectedShotId = null;
    state.creative.selectedCharacterIndex = null;
    state.creative.selectedLocationIndex = null;
    state.creative.selectedPropIndex = null;
    selectCreativeArtifact(state.creative.activeArtifact || 'brief');
  } catch {
    showError(container, () => loadCreativeRecord(projectId));
  }
}

function selectCreativeArtifact(key) {
  state.creative.activeArtifact = key;
  document.querySelectorAll('.creative-nav-item').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.artifact === key);
  });

  if (key === 'brief') {
    renderBriefEditor();
    renderSkillPanel(null);
  } else if (key === 'spec') {
    renderSpecEditor();
    renderSkillPanel(null);
  } else if (key === 'bible') {
    renderBibleEditor();
    renderSkillPanel(null);
  } else if (key === 'characters') {
    state.creative.bibleTab = 'characters';
    renderBibleEditor();
    renderSkillPanel(null);
  } else if (key === 'locations') {
    state.creative.bibleTab = 'locations';
    renderBibleEditor();
    renderSkillPanel(null);
  } else if (key === 'storyboard') {
    state.creative.selectedShotId = null;
    renderStoryboardView();
  } else if (key === 'keyframes') {
    renderKeyframePlanView();
  }
}

async function putCreative(kind, updates, changeNote) {
  const projectId = state.selectedProjectId;
  return fetchJson(`/projects/${projectId}/creative/${kind}`, { method: 'PUT', body: { ...updates, changeNote } });
}

// --- shared field-form builder --------------------------------------------------
//
// fieldDefs: [{ key, label, type: 'text' | 'textarea' | 'list' }]
// 'list' fields are edited as one item per line and split/joined on save
// — the simplest possible UI for an array field, matching this frontend's
// "keep it beginner-friendly" design throughout.

function buildFieldForm(fieldDefs, values = {}) {
  const form = document.createElement('div');
  form.className = 'field-form';
  const inputs = {};

  for (const def of fieldDefs) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.textContent = def.label;
    wrap.appendChild(label);

    let input;
    if (def.type === 'textarea' || def.type === 'list') {
      input = document.createElement('textarea');
      input.rows = def.type === 'list' ? 3 : 4;
      input.value = def.type === 'list' ? (Array.isArray(values[def.key]) ? values[def.key].join('\n') : '') : values[def.key] || '';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = values[def.key] || '';
    }
    wrap.appendChild(input);

    if (def.type === 'list') {
      const hint = document.createElement('div');
      hint.className = 'field-list-hint';
      hint.textContent = 'One item per line.';
      wrap.appendChild(hint);
    }

    inputs[def.key] = { el: input, type: def.type };
    form.appendChild(wrap);
  }

  function getValues() {
    const result = {};
    for (const [key, { el, type }] of Object.entries(inputs)) {
      if (type === 'list') {
        result[key] = el.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        result[key] = el.value.trim() === '' ? null : el.value;
      }
    }
    return result;
  }

  return { formEl: form, getValues };
}

// Save/Cancel bar with a required change note (Part 13: no blank change
// notes ever reach the server — this is checked here too, client-side,
// purely so the user gets instant feedback; the server enforces the same
// rule regardless).
function buildSaveBar(onSave, onCancel) {
  const box = document.createElement('div');
  box.className = 'change-note-box';

  const label = document.createElement('label');
  label.textContent = 'Change note (required)';
  box.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'What did you change, and why?';
  box.appendChild(input);

  const error = document.createElement('div');
  error.className = 'field-error';
  error.hidden = true;
  error.textContent = 'A change note is required before saving.';
  box.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const note = input.value.trim();
    if (!note) {
      error.hidden = false;
      input.classList.add('invalid');
      return;
    }
    error.hidden = true;
    input.classList.remove('invalid');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await onSave(note);
    } catch (err) {
      error.hidden = false;
      error.textContent = 'Something went wrong. Your changes were not saved.';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  box.appendChild(actions);

  return box;
}

// --- version history panel (RIGHT panel, top) -----------------------------------

function renderCreativeVersionPanel(artifact) {
  const container = document.getElementById('creative-version-panel');
  container.innerHTML = '';

  if (!artifact) {
    showEmpty(container, 'Not created yet — version 1 will be assigned on first save.');
    return;
  }

  const current = document.createElement('div');
  current.className = 'version-current';

  const num = document.createElement('div');
  num.className = 'version-number';
  num.textContent = `Version ${displayValue(artifact.version)}`;
  current.appendChild(num);

  const meta = document.createElement('div');
  meta.className = 'version-meta';
  meta.textContent = `Updated ${fmtDate(artifact.updatedAt)} by ${displayValue(artifact.updatedBy)}`;
  current.appendChild(meta);

  if (artifact.changeNote) {
    const note = document.createElement('div');
    note.className = 'version-note';
    note.textContent = `“${artifact.changeNote}”`;
    current.appendChild(note);
  }
  container.appendChild(current);

  const history = artifact.history || [];
  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No previous versions yet.';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'version-history-list';
  [...history].reverse().forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'version-history-item';

    const num2 = document.createElement('span');
    num2.className = 'version-number';
    num2.textContent = `Version ${displayValue(entry.version)}`;
    item.appendChild(num2);
    item.appendChild(document.createElement('br'));
    item.appendChild(document.createTextNode(`${fmtDate(entry.updatedAt)} · ${displayValue(entry.updatedBy)}`));
    if (entry.changeNote) {
      item.appendChild(document.createElement('br'));
      const noteEl = document.createElement('em');
      noteEl.textContent = `“${entry.changeNote}”`;
      item.appendChild(noteEl);
    }
    list.appendChild(item);
  });
  container.appendChild(list);
}

// --- Creative Brief editor (Part 3) ----------------------------------------------

const BRIEF_FIELDS = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'concept', label: 'Concept', type: 'textarea' },
  { key: 'premise', label: 'Premise', type: 'textarea' },
  { key: 'objective', label: 'Objective', type: 'textarea' },
  { key: 'audience', label: 'Audience', type: 'text' },
  { key: 'tone', label: 'Tone', type: 'text' },
  { key: 'genre', label: 'Genre', type: 'text' },
  { key: 'format', label: 'Format', type: 'text' },
  { key: 'targetDuration', label: 'Target duration', type: 'text' },
  { key: 'visualDirection', label: 'Visual direction', type: 'textarea' },
  { key: 'narrativeApproach', label: 'Narrative approach', type: 'textarea' },
  { key: 'keyMessage', label: 'Key message', type: 'textarea' },
  { key: 'constraints', label: 'Constraints', type: 'list' },
  { key: 'references', label: 'References', type: 'list' },
  { key: 'creativeNotes', label: 'Creative notes', type: 'textarea' },
];

function renderBriefEditor() {
  const container = document.getElementById('creative-editor');
  container.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = 'Creative Brief';
  container.appendChild(heading);

  const values = state.creative.brief || {};
  const { formEl, getValues } = buildFieldForm(BRIEF_FIELDS, values);
  container.appendChild(formEl);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const result = await putCreative('brief', getValues(), changeNote);
      state.creative.brief = result;
      renderBriefEditor();
    },
    () => renderBriefEditor()
  );
  container.appendChild(saveBar);

  renderCreativeVersionPanel(state.creative.brief);
}

// --- Master Creative Specification editor (Part 4) --------------------------------

const SPEC_FIELDS = [
  { key: 'coreConcept', label: 'Core concept', type: 'textarea' },
  { key: 'storyLogic', label: 'Story logic', type: 'textarea' },
  { key: 'tone', label: 'Tone', type: 'text' },
  { key: 'pacing', label: 'Pacing', type: 'text' },
  { key: 'visualLanguage', label: 'Visual language', type: 'textarea' },
  { key: 'cinematography', label: 'Cinematography', type: 'textarea' },
  { key: 'lighting', label: 'Lighting', type: 'textarea' },
  { key: 'colourLanguage', label: 'Colour language', type: 'textarea' },
  { key: 'environmentRules', label: 'Environment rules', type: 'textarea' },
  { key: 'characterRules', label: 'Character rules', type: 'textarea' },
  { key: 'wardrobeRules', label: 'Wardrobe rules', type: 'textarea' },
  { key: 'cameraRules', label: 'Camera rules', type: 'textarea' },
  { key: 'motionRules', label: 'Motion rules', type: 'textarea' },
  { key: 'compositionRules', label: 'Composition rules', type: 'textarea' },
  { key: 'continuityRules', label: 'Continuity rules', type: 'textarea' },
  { key: 'negativeConstraints', label: 'Negative constraints', type: 'list' },
  { key: 'referenceStrategy', label: 'Reference strategy', type: 'textarea' },
];

function renderSpecEditor() {
  const container = document.getElementById('creative-editor');
  container.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = 'Master Creative Specification';
  container.appendChild(heading);

  const values = state.creative.spec || {};
  const { formEl, getValues } = buildFieldForm(SPEC_FIELDS, values);
  container.appendChild(formEl);

  // masterPrompt: shown separately, clearly labeled as derived/future use
  // (Part 4) — never treated as the source of truth.
  const promptField = document.createElement('div');
  promptField.className = 'field';
  const promptLabel = document.createElement('label');
  promptLabel.appendChild(document.createTextNode('Master prompt'));
  const badge = document.createElement('span');
  badge.className = 'derived-badge';
  badge.textContent = 'Derived / future use';
  promptLabel.appendChild(badge);
  promptField.appendChild(promptLabel);

  const promptInput = document.createElement('textarea');
  promptInput.rows = 4;
  promptInput.value = values.masterPrompt || '';
  promptField.appendChild(promptInput);

  const promptHint = document.createElement('div');
  promptHint.className = 'field-hint';
  promptHint.textContent = 'Not the source of truth — this will eventually be derived from the structured fields above, not authored directly.';
  promptField.appendChild(promptHint);
  container.appendChild(promptField);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const updates = { ...getValues(), masterPrompt: promptInput.value.trim() || null };
      const result = await putCreative('spec', updates, changeNote);
      state.creative.spec = result;
      renderSpecEditor();
    },
    () => renderSpecEditor()
  );
  container.appendChild(saveBar);

  renderCreativeVersionPanel(state.creative.spec);
}

// --- Visual Bible (Part 5), Characters (Part 6), Locations (Part 7) ---------------

const BIBLE_TABS = [
  { key: 'world', label: 'WORLD', kind: 'text-field', field: 'world' },
  { key: 'characters', label: 'CHARACTERS', kind: 'characters' },
  { key: 'locations', label: 'LOCATIONS', kind: 'locations' },
  { key: 'wardrobe', label: 'WARDROBE', kind: 'text-field', field: 'wardrobe' },
  { key: 'props', label: 'PROPS', kind: 'props' },
  { key: 'lighting', label: 'LIGHTING', kind: 'text-field', field: 'lighting' },
  { key: 'colour', label: 'COLOUR', kind: 'text-field', field: 'colour' },
  { key: 'camera', label: 'CAMERA', kind: 'text-field', field: 'camera' },
  { key: 'composition', label: 'COMPOSITION', kind: 'text-field', field: 'composition' },
  { key: 'textures', label: 'TEXTURES / MATERIALS', kind: 'text-field', field: 'textureMaterials' },
  { key: 'atmosphere', label: 'ATMOSPHERE', kind: 'text-field', field: 'atmosphere' },
  { key: 'continuity', label: 'CONTINUITY', kind: 'text-field', field: 'continuityRules' },
];

const CHARACTER_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'role', label: 'Role', type: 'text' },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'facialCharacteristics', label: 'Facial characteristics', type: 'textarea' },
  { key: 'bodyCharacteristics', label: 'Body characteristics', type: 'textarea' },
  { key: 'hair', label: 'Hair', type: 'text' },
  { key: 'skinDescription', label: 'Skin description', type: 'text' },
  { key: 'wardrobe', label: 'Wardrobe', type: 'textarea' },
  { key: 'accessories', label: 'Accessories', type: 'list' },
  { key: 'recurringProps', label: 'Recurring props', type: 'list' },
  { key: 'behaviour', label: 'Behaviour', type: 'textarea' },
  { key: 'continuityNotes', label: 'Continuity notes', type: 'textarea' },
  { key: 'referenceAssets', label: 'Reference assets', type: 'list' },
];

const LOCATION_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'architecture', label: 'Architecture', type: 'textarea' },
  { key: 'geography', label: 'Geography', type: 'textarea' },
  { key: 'materials', label: 'Materials', type: 'textarea' },
  { key: 'colourPalette', label: 'Colour palette', type: 'text' },
  { key: 'lighting', label: 'Lighting', type: 'textarea' },
  { key: 'atmosphere', label: 'Atmosphere', type: 'textarea' },
  { key: 'recurringElements', label: 'Recurring elements', type: 'list' },
  { key: 'continuityConstraints', label: 'Continuity constraints', type: 'textarea' },
  { key: 'referenceAssets', label: 'Reference assets', type: 'list' },
];

const PROP_FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'description', label: 'Description', type: 'textarea' },
  { key: 'continuityNotes', label: 'Continuity notes', type: 'textarea' },
  { key: 'referenceAssets', label: 'Reference assets', type: 'list' },
];

function renderBibleEditor() {
  const container = document.getElementById('creative-editor');
  container.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = 'Visual Bible';
  container.appendChild(heading);

  const tabsNav = document.createElement('div');
  tabsNav.className = 'bible-tabs';
  for (const tab of BIBLE_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bible-tab' + (state.creative.bibleTab === tab.key ? ' selected' : '');
    btn.textContent = tab.label;
    btn.addEventListener('click', () => {
      state.creative.bibleTab = tab.key;
      state.creative.selectedCharacterIndex = null;
      state.creative.selectedLocationIndex = null;
      state.creative.selectedPropIndex = null;
      renderBibleEditor();
    });
    tabsNav.appendChild(btn);
  }
  container.appendChild(tabsNav);

  const bible = state.creative.bible || {};
  const activeTab = BIBLE_TABS.find((t) => t.key === state.creative.bibleTab) || BIBLE_TABS[0];

  const content = document.createElement('div');
  container.appendChild(content);

  if (activeTab.kind === 'text-field') {
    renderBibleTextField(content, activeTab, bible);
  } else if (activeTab.kind === 'characters') {
    renderCharactersTab(content, bible);
  } else if (activeTab.kind === 'locations') {
    renderLocationsTab(content, bible);
  } else if (activeTab.kind === 'props') {
    renderPropsTab(content, bible);
  }

  renderCreativeVersionPanel(state.creative.bible);
}

function renderBibleTextField(content, tab, bible) {
  const { formEl, getValues } = buildFieldForm([{ key: tab.field, label: tab.label, type: 'textarea' }], bible);
  content.appendChild(formEl);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const result = await putCreative('bible', getValues(), changeNote);
      state.creative.bible = result;
      renderBibleEditor();
    },
    () => renderBibleEditor()
  );
  content.appendChild(saveBar);
}

function renderCharactersTab(content, bible) {
  const characters = bible.characters || [];
  const listWrap = document.createElement('div');
  listWrap.className = 'card-list';

  characters.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'entity-card' + (state.creative.selectedCharacterIndex === idx ? ' selected' : '');
    const name = document.createElement('div');
    name.className = 'entity-name';
    name.textContent = c.name || 'Untitled character';
    const sub = document.createElement('div');
    sub.className = 'entity-sub';
    sub.textContent = c.role || '';
    card.appendChild(name);
    card.appendChild(sub);
    card.addEventListener('click', () => {
      state.creative.selectedCharacterIndex = idx;
      renderBibleEditor();
    });
    listWrap.appendChild(card);
  });
  content.appendChild(listWrap);

  if (characters.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No characters yet.';
    content.appendChild(empty);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-secondary';
  addBtn.textContent = 'Add Character';
  addBtn.style.marginBottom = '16px';
  addBtn.addEventListener('click', () => {
    state.creative.selectedCharacterIndex = characters.length;
    renderBibleEditor();
  });
  content.appendChild(addBtn);

  const idx = state.creative.selectedCharacterIndex;
  if (idx === null || idx === undefined) return;

  const existing = characters[idx] || {};
  const { formEl, getValues } = buildFieldForm(CHARACTER_FIELDS, existing);
  content.appendChild(formEl);

  // Part 6 — CHARACTER IDENTITY LOCK, made visually prominent on purpose:
  // character consistency is a core objective of this application.
  const lockBox = document.createElement('div');
  lockBox.className = 'identity-lock-box';
  const lockLabel = document.createElement('label');
  lockLabel.textContent = 'CHARACTER IDENTITY LOCK';
  lockBox.appendChild(lockLabel);
  const lockInput = document.createElement('textarea');
  lockInput.rows = 3;
  lockInput.value = existing.identityConstraints || '';
  lockBox.appendChild(lockInput);
  content.appendChild(lockBox);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const updated = {
        ...existing,
        ...getValues(),
        identityConstraints: lockInput.value.trim() || null,
        characterId: existing.characterId || crypto.randomUUID(),
      };
      const newCharacters = [...characters];
      newCharacters[idx] = updated;
      const result = await putCreative('bible', { characters: newCharacters }, changeNote);
      state.creative.bible = result;
      renderBibleEditor();
    },
    () => renderBibleEditor()
  );
  content.appendChild(saveBar);
}

function renderLocationsTab(content, bible) {
  const locations = bible.locations || [];
  const listWrap = document.createElement('div');
  listWrap.className = 'card-list';

  locations.forEach((loc, idx) => {
    const card = document.createElement('div');
    card.className = 'entity-card' + (state.creative.selectedLocationIndex === idx ? ' selected' : '');
    const name = document.createElement('div');
    name.className = 'entity-name';
    name.textContent = loc.name || 'Untitled location';
    card.appendChild(name);
    card.addEventListener('click', () => {
      state.creative.selectedLocationIndex = idx;
      renderBibleEditor();
    });
    listWrap.appendChild(card);
  });
  content.appendChild(listWrap);

  if (locations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No locations yet.';
    content.appendChild(empty);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-secondary';
  addBtn.textContent = 'Add Location';
  addBtn.style.marginBottom = '16px';
  addBtn.addEventListener('click', () => {
    state.creative.selectedLocationIndex = locations.length;
    renderBibleEditor();
  });
  content.appendChild(addBtn);

  const idx = state.creative.selectedLocationIndex;
  if (idx === null || idx === undefined) return;

  const existing = locations[idx] || {};
  const { formEl, getValues } = buildFieldForm(LOCATION_FIELDS, existing);
  content.appendChild(formEl);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const updated = { ...existing, ...getValues(), locationId: existing.locationId || crypto.randomUUID() };
      const newLocations = [...locations];
      newLocations[idx] = updated;
      const result = await putCreative('bible', { locations: newLocations }, changeNote);
      state.creative.bible = result;
      renderBibleEditor();
    },
    () => renderBibleEditor()
  );
  content.appendChild(saveBar);
}

function renderPropsTab(content, bible) {
  const props = bible.props || [];
  const listWrap = document.createElement('div');
  listWrap.className = 'card-list';

  props.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'entity-card' + (state.creative.selectedPropIndex === idx ? ' selected' : '');
    const name = document.createElement('div');
    name.className = 'entity-name';
    name.textContent = p.name || 'Untitled prop';
    card.appendChild(name);
    card.addEventListener('click', () => {
      state.creative.selectedPropIndex = idx;
      renderBibleEditor();
    });
    listWrap.appendChild(card);
  });
  content.appendChild(listWrap);

  if (props.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No recurring props yet.';
    content.appendChild(empty);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-secondary';
  addBtn.textContent = 'Add Prop';
  addBtn.style.marginBottom = '16px';
  addBtn.addEventListener('click', () => {
    state.creative.selectedPropIndex = props.length;
    renderBibleEditor();
  });
  content.appendChild(addBtn);

  const idx = state.creative.selectedPropIndex;
  if (idx === null || idx === undefined) return;

  const existing = props[idx] || {};
  const { formEl, getValues } = buildFieldForm(PROP_FIELDS, existing);
  content.appendChild(formEl);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const updated = { ...existing, ...getValues(), propId: existing.propId || crypto.randomUUID() };
      const newProps = [...props];
      newProps[idx] = updated;
      const result = await putCreative('bible', { props: newProps }, changeNote);
      state.creative.bible = result;
      renderBibleEditor();
    },
    () => renderBibleEditor()
  );
  content.appendChild(saveBar);
}

// --- Storyboard view (Part 8) + Shot editor (Part 9) -------------------------------

function renderStoryboardView() {
  const container = document.getElementById('creative-editor');
  container.innerHTML = '';

  if (state.creative.selectedShotId) {
    renderShotEditor(container);
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = 'Storyboard';
  container.appendChild(heading);

  const storyboard = state.creative.storyboard;
  if (!storyboard || !storyboard.scenes || storyboard.scenes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No scenes yet.';
    container.appendChild(empty);
    renderCreativeVersionPanel(storyboard);
    renderSkillPanel(null);
    return;
  }

  storyboard.scenes.forEach((scene, sceneIdx) => {
    const sceneBox = document.createElement('div');
    sceneBox.className = 'storyboard-scene';

    const title = document.createElement('div');
    title.className = 'storyboard-scene-title';
    title.textContent = `Scene ${String(sceneIdx + 1).padStart(2, '0')} — ${scene.title || 'Untitled'}`;
    sceneBox.appendChild(title);

    const shots = (storyboard.shots || []).filter((s) => s.sceneId === scene.sceneId);
    if (shots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'state-box';
      empty.textContent = 'No shots in this scene yet.';
      sceneBox.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'shot-card-grid';
      shots.forEach((shot, shotIdx) => grid.appendChild(renderShotCard(shot, shotIdx + 1)));
      sceneBox.appendChild(grid);
    }
    container.appendChild(sceneBox);
  });

  renderCreativeVersionPanel(storyboard);
  renderSkillPanel(null);
}

function renderShotCard(shot, number) {
  const card = document.createElement('div');
  card.className = 'shot-card';
  card.addEventListener('click', () => {
    state.creative.selectedShotId = shot.shotId;
    state.creative.shotAnalysis = null;
    renderStoryboardView();
  });

  const title = document.createElement('div');
  title.className = 'shot-card-title';
  title.textContent = `Shot ${String(number).padStart(2, '0')}`;
  card.appendChild(title);
  card.appendChild(statusBadge(shot.status));

  const dl = document.createElement('dl');
  const rows = [
    ['Duration', shot.duration],
    ['Purpose', shot.purpose],
    ['Narrative beat', shot.narrativeBeat],
    ['Visual description', shot.visualDescription],
    ['Subject', shot.subject],
    ['Location', shot.location],
    ['Action', shot.action],
    ['Camera', shot.camera],
    ['Framing', shot.framing],
    ['Lens', shot.lens],
    ['Movement', shot.movement],
    ['Lighting', shot.lighting],
    ['Transition', shot.transition],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = displayValue(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  card.appendChild(dl);
  return card;
}

const SHOT_FIELDS = [
  { key: 'duration', label: 'Duration (seconds)', type: 'text' },
  { key: 'purpose', label: 'Purpose', type: 'textarea' },
  { key: 'narrativeBeat', label: 'Narrative beat', type: 'textarea' },
  { key: 'visualDescription', label: 'Visual description', type: 'textarea' },
  { key: 'subject', label: 'Subject', type: 'textarea' },
  { key: 'location', label: 'Location', type: 'text' },
  { key: 'action', label: 'Action', type: 'textarea' },
  { key: 'camera', label: 'Camera', type: 'text' },
  { key: 'framing', label: 'Framing', type: 'text' },
  { key: 'lens', label: 'Lens', type: 'text' },
  { key: 'movement', label: 'Movement', type: 'textarea' },
  { key: 'lighting', label: 'Lighting', type: 'textarea' },
  { key: 'soundNotes', label: 'Sound notes', type: 'textarea' },
  { key: 'transition', label: 'Transition', type: 'text' },
  { key: 'continuityRequirements', label: 'Continuity requirements', type: 'list' },
  { key: 'characterReferences', label: 'Character references', type: 'list' },
  { key: 'locationReferences', label: 'Location references', type: 'list' },
  { key: 'propReferences', label: 'Prop references', type: 'list' },
  { key: 'referenceAssets', label: 'Reference assets', type: 'list' },
];

function renderShotEditor(container) {
  container.innerHTML = '';

  const storyboard = state.creative.storyboard;
  const shot = (storyboard && storyboard.shots || []).find((s) => s.shotId === state.creative.selectedShotId);
  if (!shot) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No data found.';
    container.appendChild(empty);
    return;
  }

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn btn-secondary';
  backBtn.textContent = '← Back to Storyboard';
  backBtn.addEventListener('click', () => {
    state.creative.selectedShotId = null;
    state.creative.shotAnalysis = null;
    renderStoryboardView();
  });
  container.appendChild(backBtn);

  const heading = document.createElement('h3');
  heading.style.marginTop = '12px';
  heading.textContent = 'Shot Editor';
  container.appendChild(heading);

  // Part 9 — status is READ-ONLY here on purpose: no planning-status
  // transition system exists yet, and this UI must not invent one.
  const statusRow = document.createElement('div');
  statusRow.className = 'shot-meta';
  statusRow.appendChild(document.createTextNode('Status: '));
  statusRow.appendChild(statusBadge(shot.status));
  const hint = document.createElement('span');
  hint.className = 'field-hint';
  hint.textContent = '(read-only — planning-status transitions aren’t implemented yet)';
  statusRow.appendChild(hint);
  container.appendChild(statusRow);

  const { formEl, getValues } = buildFieldForm(SHOT_FIELDS, shot);
  container.appendChild(formEl);

  const saveBar = buildSaveBar(
    async (changeNote) => {
      const projectId = state.selectedProjectId;
      await fetchJson(`/projects/${projectId}/creative/storyboard/shots/${shot.shotId}`, {
        method: 'PUT',
        body: { ...getValues(), changeNote },
      });
      // Reload the whole storyboard so both the grid view and the version
      // panel reflect the save.
      state.creative.storyboard = await fetchJson(`/projects/${projectId}/creative/storyboard`);
      renderShotEditor(document.getElementById('creative-editor'));
    },
    () => renderShotEditor(document.getElementById('creative-editor'))
  );
  container.appendChild(saveBar);

  renderKeyframeAnalysisSection(container, shot);

  renderCreativeVersionPanel(storyboard);
  renderSkillPanel(shot);
}

// --- Keyframe analysis (Stage 12, Part 15) — READ-ONLY. Running an
// analysis never creates a keyframe, generation job, or spends a credit —
// there is deliberately no "accept" or "generate" button here, matching
// the Creative Skills panel's own "display only" rule.

function renderKeyframeAnalysisSection(container, shot) {
  const section = document.createElement('div');
  section.className = 'keyframe-analysis-section';

  const heading = document.createElement('h4');
  heading.textContent = 'Keyframe Analysis';
  section.appendChild(heading);

  const analyzeBtn = document.createElement('button');
  analyzeBtn.type = 'button';
  analyzeBtn.className = 'btn btn-secondary';
  analyzeBtn.textContent = 'ANALYZE KEYFRAMES';
  analyzeBtn.addEventListener('click', async () => {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing…';
    try {
      const projectId = state.selectedProjectId;
      const result = await fetchJson(`/projects/${projectId}/keyframes/analyze`, { method: 'POST', body: { shotId: shot.shotId } });
      state.creative.shotAnalysis = result;
      renderShotEditor(document.getElementById('creative-editor'));
    } catch {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'ANALYZE KEYFRAMES';
    }
  });
  section.appendChild(analyzeBtn);

  const analysis = state.creative.shotAnalysis;
  if (analysis && analysis.shotId === shot.shotId) {
    section.appendChild(renderKeyframeAnalysisResults(analysis));
  }

  container.appendChild(section);
}

function renderKeyframeAnalysisResults(analysis) {
  const wrap = document.createElement('div');
  wrap.className = 'keyframe-analysis-results';

  const summary = document.createElement('div');
  summary.className = 'keyframe-analysis-summary';
  summary.textContent =
    `${analysis.summary.totalRequired} frame(s) considered — ` +
    `${analysis.summary.newRecommended} recommended, ` +
    `${analysis.summary.reusable} reusable from approved assets, ` +
    `${analysis.summary.alreadyPlanned} already planned.`;
  wrap.appendChild(summary);

  function group(title, items, describe) {
    if (items.length === 0) return;
    const groupBox = document.createElement('div');
    groupBox.className = 'keyframe-analysis-group';
    const h5 = document.createElement('h5');
    h5.textContent = title;
    groupBox.appendChild(h5);

    const list = document.createElement('ol');
    items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = describe(item);
      list.appendChild(li);
    });
    groupBox.appendChild(list);
    wrap.appendChild(groupBox);
  }

  group('Recommended (new)', analysis.recommendations, (r) => {
    const skill = r.recommendedSkill ? ` — recommended skill: ${SKILL_DISPLAY_NAMES[r.recommendedSkill] || r.recommendedSkill}` : '';
    return `${r.frameType}: ${displayValue(r.purpose)}${skill}`;
  });
  group('Reusable (already have an approved asset)', analysis.reused, (r) => `${r.frameType}: ${r.reason}`);
  group('Already planned', analysis.existing, (r) => `${r.frameType}: ${r.reason} (status: ${displayValue(r.status)})`);

  return wrap;
}

// --- Keyframe Plan view (Stage 12, Part 15/16) — READ-ONLY -------------------------

async function renderKeyframePlanView() {
  const container = document.getElementById('creative-editor');
  showLoading(container);

  const projectId = state.selectedProjectId;
  try {
    const plan = await fetchJson(`/projects/${projectId}/keyframes`);
    state.creative.keyframePlan = plan;

    container.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'Keyframe Plan';
    container.appendChild(heading);

    await renderKeyframeWorkloadSummary(container);
    await renderCreditEfficiencySummary(container);
    renderKeyframeList(container, plan);

    renderCreativeVersionPanel(plan);
    renderSkillPanel(null);
  } catch {
    showError(container, renderKeyframePlanView);
  }
}

// Part 18 — "Credit efficiency": asset-COUNT information only, computed
// from already-BUILT prompt packages (services/keyframe-prompt-service.js).
// Never estimates a credit amount or invents pricing.
async function renderCreditEfficiencySummary(container) {
  const box = document.createElement('div');
  box.className = 'keyframe-workload-summary';
  box.textContent = 'Loading credit efficiency…';
  container.appendChild(box);

  try {
    const projectId = state.selectedProjectId;
    const packages = await fetchJson(`/projects/${projectId}/keyframe-prompt-packages`);

    const reusableReferences = packages.reduce((sum, p) => sum + p.existingReferenceAssets.length, 0);
    const newVisualReferencesRequired = packages.reduce(
      (sum, p) => sum + p.warnings.filter((w) => w.startsWith('Approved reference asset not available')).length,
      0
    );

    box.innerHTML = '';
    const h4 = document.createElement('h4');
    h4.textContent = 'Credit Efficiency (asset counts only)';
    box.appendChild(h4);
    const list = document.createElement('div');
    list.className = 'info-list';
    list.appendChild(infoRow('Approved reusable references', reusableReferences));
    list.appendChild(infoRow('New visual references required', newVisualReferencesRequired));
    list.appendChild(infoRow('Keyframe packages', packages.length));
    box.appendChild(list);
  } catch {
    box.textContent = 'Could not load credit efficiency.';
  }
}

// Part 16 — "Estimated visual workload": computed CLIENT-SIDE by calling
// the existing per-shot analyze endpoint in parallel for every shot in the
// storyboard, then aggregating. No new backend aggregate endpoint exists —
// this stays within the exact REST surface defined for this stage.
async function renderKeyframeWorkloadSummary(container) {
  const box = document.createElement('div');
  box.className = 'keyframe-workload-summary';

  const storyboard = state.creative.storyboard;
  const shots = (storyboard && storyboard.shots) || [];
  if (shots.length === 0) {
    box.textContent = 'No storyboard shots yet — nothing to estimate.';
    container.appendChild(box);
    return;
  }

  box.textContent = 'Estimating visual workload…';
  container.appendChild(box);

  try {
    const projectId = state.selectedProjectId;
    const analyses = await Promise.all(
      shots.map((shot) => fetchJson(`/projects/${projectId}/keyframes/analyze`, { method: 'POST', body: { shotId: shot.shotId } }))
    );
    const totals = analyses.reduce(
      (acc, a) => {
        acc.totalRequired += a.summary.totalRequired;
        acc.reusable += a.summary.reusable;
        acc.newRecommended += a.summary.newRecommended;
        acc.alreadyPlanned += a.summary.alreadyPlanned;
        return acc;
      },
      { totalRequired: 0, reusable: 0, newRecommended: 0, alreadyPlanned: 0 }
    );
    state.creative.keyframeWorkload = totals;

    box.innerHTML = '';
    const h4 = document.createElement('h4');
    h4.textContent = 'Estimated Visual Workload';
    box.appendChild(h4);
    const list = document.createElement('div');
    list.className = 'info-list';
    list.appendChild(infoRow('Frames considered across all shots', totals.totalRequired));
    list.appendChild(infoRow('Reusable from approved assets', totals.reusable));
    list.appendChild(infoRow('Net-new recommended', totals.newRecommended));
    list.appendChild(infoRow('Already planned', totals.alreadyPlanned));
    box.appendChild(list);
  } catch {
    box.textContent = 'Could not estimate visual workload.';
  }
}

function renderKeyframeList(container, plan) {
  const heading = document.createElement('h4');
  heading.textContent = 'Planned Keyframes';
  container.appendChild(heading);

  const keyframes = (plan && plan.keyframes) || [];
  if (keyframes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No keyframes planned yet.';
    container.appendChild(empty);
    return;
  }

  const byShot = new Map();
  for (const kf of keyframes) {
    const list = byShot.get(kf.shotId) || [];
    list.push(kf);
    byShot.set(kf.shotId, list);
  }

  const storyboard = state.creative.storyboard;
  for (const [shotId, kfs] of byShot.entries()) {
    const shot = (storyboard && storyboard.shots || []).find((s) => s.shotId === shotId);
    const shotBox = document.createElement('div');
    shotBox.className = 'keyframe-shot-group';

    const title = document.createElement('div');
    title.className = 'keyframe-shot-title';
    title.textContent = shot ? shot.purpose || shot.shotId : shotId;
    shotBox.appendChild(title);

    const list = document.createElement('div');
    list.className = 'card-list';
    kfs.forEach((kf) => {
      const card = document.createElement('div');
      card.className = 'entity-card';

      const name = document.createElement('div');
      name.className = 'entity-name';
      name.textContent = `${displayValue(kf.frameType)} — ${displayValue(kf.subject)}`;
      card.appendChild(name);

      card.appendChild(statusBadge(kf.status));

      if (kf.stale) {
        const staleBadge = document.createElement('span');
        staleBadge.className = 'badge badge-rejected';
        staleBadge.textContent = 'Stale — storyboard changed since planned';
        card.appendChild(staleBadge);
      }

      card.appendChild(renderPromptPackageControls(kf));
      card.appendChild(renderKeyframeGenerationControls(kf));

      list.appendChild(card);
    });
    shotBox.appendChild(list);
    container.appendChild(shotBox);
  }
}

// Part 16/17 — per-keyframe prompt-package controls. Only BUILD PACKAGE /
// REFRESH PACKAGE / VIEW PACKAGE exist here — deliberately no GENERATE,
// EXECUTE, or SUBMIT button anywhere in this section (Part 17).
function renderPromptPackageControls(kf) {
  const box = document.createElement('div');
  box.className = 'prompt-package-controls';

  const buildBtn = document.createElement('button');
  buildBtn.type = 'button';
  buildBtn.className = 'btn btn-secondary';
  buildBtn.textContent = 'BUILD / REFRESH PACKAGE';
  buildBtn.addEventListener('click', async () => {
    buildBtn.disabled = true;
    buildBtn.textContent = 'Building…';
    try {
      const pkg = await fetchJson(`/keyframes/${kf.keyframeId}/prompt-package`, { method: 'POST', body: {} });
      state.creative.viewedPackageKeyframeId = kf.keyframeId;
      state.creative.viewedPackage = pkg;
      renderKeyframePlanView();
    } catch {
      buildBtn.disabled = false;
      buildBtn.textContent = 'BUILD / REFRESH PACKAGE';
    }
  });
  box.appendChild(buildBtn);

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn btn-secondary';
  viewBtn.textContent = 'VIEW PACKAGE';
  viewBtn.addEventListener('click', async () => {
    if (state.creative.viewedPackageKeyframeId === kf.keyframeId) {
      state.creative.viewedPackageKeyframeId = null;
      state.creative.viewedPackage = null;
      renderKeyframePlanView();
      return;
    }
    viewBtn.disabled = true;
    viewBtn.textContent = 'Loading…';
    try {
      const pkg = await fetchJson(`/keyframes/${kf.keyframeId}/prompt-package`);
      state.creative.viewedPackageKeyframeId = kf.keyframeId;
      state.creative.viewedPackage = pkg;
      renderKeyframePlanView();
    } catch {
      viewBtn.disabled = false;
      viewBtn.textContent = 'VIEW PACKAGE';
    }
  });
  box.appendChild(viewBtn);

  if (state.creative.viewedPackageKeyframeId === kf.keyframeId) {
    box.appendChild(renderPromptPackagePanel(state.creative.viewedPackage));
  }

  return box;
}

// Part 16 — the full package display. Every field it shows is clearly
// grouped as either SOURCE OF TRUTH (the structured fields this stage
// resolved from the Creative Brief / Master Spec / Visual Bible /
// Storyboard / Keyframe Plan / approved assets) or DERIVED PROMPT (the
// deterministic text composition of those fields) — this distinction is
// never blurred.
function renderPromptPackagePanel(pkg) {
  const panel = document.createElement('div');
  panel.className = 'prompt-package-panel';

  if (!pkg) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'No prompt package has been built for this keyframe yet.';
    panel.appendChild(empty);
    return panel;
  }

  const statusRow = document.createElement('div');
  statusRow.className = 'shot-meta';
  statusRow.appendChild(statusBadge(pkg.status));
  statusRow.appendChild(document.createTextNode(` Version ${displayValue(pkg.version)}`));
  panel.appendChild(statusRow);

  if (pkg.warnings && pkg.warnings.length > 0) {
    const warnBox = document.createElement('div');
    warnBox.className = 'budget-warning';
    warnBox.textContent = pkg.warnings.join(' ');
    panel.appendChild(warnBox);
  }

  const sourceLabel = document.createElement('div');
  sourceLabel.className = 'recommended-next-step-label';
  sourceLabel.textContent = 'SOURCE OF TRUTH — structured fields';
  panel.appendChild(sourceLabel);

  const sourceList = document.createElement('div');
  sourceList.className = 'info-list';
  sourceList.appendChild(infoRow('Purpose', pkg.purpose));
  sourceList.appendChild(infoRow('Frame type', pkg.frameType));
  sourceList.appendChild(infoRow('Character references', (pkg.characterReferences || []).join(', ')));
  sourceList.appendChild(infoRow('Location references', (pkg.locationReferences || []).join(', ')));
  sourceList.appendChild(infoRow('Composition', pkg.composition));
  sourceList.appendChild(infoRow('Camera', pkg.camera));
  sourceList.appendChild(infoRow('Lighting', pkg.lighting));
  sourceList.appendChild(infoRow('Recommended skill', pkg.recommendedSkill));
  sourceList.appendChild(infoRow('Recommendation reason', pkg.recommendationReason));
  panel.appendChild(sourceList);

  const assetsHeading = document.createElement('div');
  assetsHeading.className = 'entity-sub';
  assetsHeading.textContent = 'Reusable approved assets:';
  panel.appendChild(assetsHeading);
  if ((pkg.existingReferenceAssets || []).length === 0) {
    const none = document.createElement('div');
    none.className = 'state-box';
    none.textContent = 'None yet.';
    panel.appendChild(none);
  } else {
    for (const ref of pkg.existingReferenceAssets) {
      panel.appendChild(infoRow(ref.role, ref.assetId));
    }
  }

  function lockSection(title, entries, fields) {
    const h = document.createElement('div');
    h.className = 'entity-sub';
    h.textContent = title;
    panel.appendChild(h);
    if (!entries || entries.length === 0) {
      const none = document.createElement('div');
      none.className = 'state-box';
      none.textContent = 'None.';
      panel.appendChild(none);
      return;
    }
    for (const entry of entries) {
      const card = document.createElement('div');
      card.className = 'entity-card';
      for (const field of fields) {
        card.appendChild(infoRow(field, Array.isArray(entry[field]) ? entry[field].join(', ') : entry[field]));
      }
      panel.appendChild(card);
    }
  }

  lockSection('Identity lock:', pkg.identityLock, ['name', 'facialCharacteristics', 'bodyCharacteristics', 'hair', 'skinDescription', 'identityConstraints', 'continuityNotes']);
  lockSection('Wardrobe lock:', pkg.wardrobeLock, ['name', 'wardrobe', 'accessories', 'wardrobeOverride']);
  lockSection('Environment lock:', pkg.environmentLock, ['name', 'architecture', 'materials', 'colourPalette', 'atmosphere', 'continuityConstraints']);

  const continuityHeading = document.createElement('div');
  continuityHeading.className = 'entity-sub';
  continuityHeading.textContent = 'Continuity requirements:';
  panel.appendChild(continuityHeading);
  panel.appendChild(infoRow('Continuity', (pkg.continuityRequirements || []).join('; ')));

  const negHeading = document.createElement('div');
  negHeading.className = 'entity-sub';
  negHeading.textContent = 'Negative constraints:';
  panel.appendChild(negHeading);
  panel.appendChild(infoRow('Negative constraints', (pkg.negativeConstraints || []).join('; ')));

  const derivedLabel = document.createElement('div');
  derivedLabel.className = 'recommended-next-step-label';
  derivedLabel.style.marginTop = '16px';
  derivedLabel.textContent = 'DERIVED PROMPT — composed from the fields above, not a separate source of truth';
  panel.appendChild(derivedLabel);

  const promptBox = document.createElement('pre');
  promptBox.className = 'derived-prompt-box';
  promptBox.textContent = pkg.prompt || '(no prompt sections resolved yet)';
  panel.appendChild(promptBox);

  return panel;
}

// --- Controlled Keyframe Generation (Stage 13B) -------------------------------------
//
// Part 15 — NO AUTONOMY: every write below (request/approve/reject
// generation approval, GENERATE KEYFRAME, approve/reject the generated
// result) fires ONLY from an explicit button click. Nothing here ever
// runs on a timer, on page load, or as a side effect of viewing a
// keyframe. The server is the real enforcement point regardless of what
// this file computes for a button's disabled state — see
// services/keyframe-generation-service.js.

function renderKeyframeGenerationControls(kf) {
  const box = document.createElement('div');
  box.className = 'prompt-package-controls';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn btn-secondary';
  toggleBtn.textContent = state.creative.viewedGenerationKeyframeId === kf.keyframeId ? 'HIDE GENERATION' : 'GENERATION';
  toggleBtn.addEventListener('click', () => toggleKeyframeGeneration(kf));
  box.appendChild(toggleBtn);

  if (state.creative.viewedGenerationKeyframeId === kf.keyframeId) {
    box.appendChild(renderKeyframeGenerationPanel(kf, state.creative.viewedGenerationData));
  }

  return box;
}

async function toggleKeyframeGeneration(kf) {
  if (state.creative.viewedGenerationKeyframeId === kf.keyframeId) {
    state.creative.viewedGenerationKeyframeId = null;
    state.creative.viewedGenerationData = null;
    renderKeyframePlanView();
    return;
  }
  await loadKeyframeGenerationData(kf);
}

async function loadKeyframeGenerationData(kf) {
  try {
    const [approval, generations, pkg, budget] = await Promise.all([
      fetchJson(`/keyframes/${kf.keyframeId}/generation-approval`),
      fetchJson(`/keyframes/${kf.keyframeId}/generations`),
      fetchJson(`/keyframes/${kf.keyframeId}/prompt-package`).catch(() => null),
      fetchJson(`/projects/${state.selectedProjectId}/budget`),
    ]);
    state.creative.viewedGenerationKeyframeId = kf.keyframeId;
    state.creative.viewedGenerationData = { approval, generations, pkg, budget };
  } catch {
    state.creative.viewedGenerationKeyframeId = kf.keyframeId;
    state.creative.viewedGenerationData = null;
  }
  renderKeyframePlanView();
}

// Client-side mirror of keyframe-generation-service.js's runSafetyChecks/
// checkKeyframeBudget, used ONLY to decide whether to show the GENERATE
// KEYFRAME button as enabled — a convenience, not a security boundary.
// Deliberately ignores budget.generationAllowed/approvalStatus, which
// reflect the PROJECT's own video-generation approval (Part 5: not
// sufficient for keyframe generation) — only the ledger numbers
// (remainingBudget/blocked) are shared between the two.
function computeKeyframeGenerationEligibility({ kf, pkg, approval, budget }) {
  if (kf.status === 'GENERATING') return { allowed: false, reason: 'A generation is already in progress for this keyframe.' };
  if (!pkg) return { allowed: false, reason: 'No prompt package has been built yet.' };
  if (pkg.status !== 'CURRENT') return { allowed: false, reason: 'The prompt package is STALE — rebuild it first.' };
  if (!approval || approval.status !== 'APPROVED') return { allowed: false, reason: 'No approved keyframe generation request.' };
  if (approval.promptPackageId !== pkg.packageId || approval.promptPackageVersion !== pkg.version) {
    return { allowed: false, reason: 'The approval was granted for a different prompt package version.' };
  }
  if (budget.blocked) return { allowed: false, reason: 'Project budget is blocked pending an overage acknowledgement.' };
  if (approval.estimatedCost == null && !approval.unknownCostAcknowledged) {
    return { allowed: false, reason: 'Estimated cost is unknown and has not been acknowledged.' };
  }
  const estimatedCost = approval.estimatedCost || 0;
  if (budget.remainingBudget != null && estimatedCost > budget.remainingBudget) {
    return { allowed: false, reason: 'Approved cost would exceed the remaining project budget.' };
  }
  return { allowed: true, reason: null };
}

function renderKeyframeGenerationPanel(kf, data) {
  const panel = document.createElement('div');
  panel.className = 'prompt-package-panel';

  if (!data) {
    const empty = document.createElement('div');
    empty.className = 'state-box';
    empty.textContent = 'Could not load generation data.';
    panel.appendChild(empty);
    return panel;
  }

  const { approval, generations, pkg, budget } = data;

  // --- GENERATION APPROVAL -------------------------------------------------
  const approvalHeading = document.createElement('div');
  approvalHeading.className = 'entity-sub';
  approvalHeading.textContent = 'Generation approval:';
  panel.appendChild(approvalHeading);
  panel.appendChild(statusBadge(approval.status));
  panel.appendChild(infoRow('Estimated cost', approval.estimatedCost));
  panel.appendChild(infoRow('Requested by', approval.requestedBy));
  panel.appendChild(infoRow('Approved by', approval.approvedBy));

  const approvalActions = document.createElement('div');
  approvalActions.className = 'form-actions';

  const requestBtn = document.createElement('button');
  requestBtn.type = 'button';
  requestBtn.className = 'btn btn-secondary';
  requestBtn.textContent = 'REQUEST GENERATION APPROVAL';
  requestBtn.addEventListener('click', async () => {
    const costInput = window.prompt('Estimated cost in credits (leave blank if unknown):', approval.estimatedCost != null ? String(approval.estimatedCost) : '');
    if (costInput === null) return; // cancelled
    const estimatedCost = costInput.trim() === '' ? undefined : Number(costInput);
    await fetchJson(`/keyframes/${kf.keyframeId}/generation-approval/request`, {
      method: 'POST',
      body: { estimatedCost, requestedBy: 'Creative Director UI', reason: 'Requested from the Keyframe Plan workspace' },
    });
    await loadKeyframeGenerationData(kf);
  });
  approvalActions.appendChild(requestBtn);

  if (approval.status === 'PENDING') {
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'btn';
    approveBtn.textContent = 'APPROVE GENERATION';
    approveBtn.addEventListener('click', async () => {
      await fetchJson(`/keyframes/${kf.keyframeId}/generation-approval/decision`, { method: 'POST', body: { approve: true, decidedBy: 'Creative Director UI' } });
      await loadKeyframeGenerationData(kf);
    });
    approvalActions.appendChild(approveBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'btn btn-secondary';
    rejectBtn.textContent = 'REJECT GENERATION';
    rejectBtn.addEventListener('click', async () => {
      await fetchJson(`/keyframes/${kf.keyframeId}/generation-approval/decision`, { method: 'POST', body: { approve: false, decidedBy: 'Creative Director UI' } });
      await loadKeyframeGenerationData(kf);
    });
    approvalActions.appendChild(rejectBtn);
  }
  panel.appendChild(approvalActions);

  // --- GENERATE KEYFRAME ----------------------------------------------------
  const eligibility = computeKeyframeGenerationEligibility({ kf, pkg, approval, budget });

  const generateBtn = document.createElement('button');
  generateBtn.type = 'button';
  generateBtn.className = 'btn';
  generateBtn.style.marginTop = '12px';
  generateBtn.textContent = 'GENERATE KEYFRAME';
  generateBtn.disabled = !eligibility.allowed;
  generateBtn.title = eligibility.allowed ? '' : eligibility.reason;
  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    try {
      await fetchJson(`/keyframes/${kf.keyframeId}/generate`, { method: 'POST', body: {} });
    } finally {
      await loadKeyframeGenerationData(kf); // re-renders the whole view, including this button's fresh state
    }
  });
  panel.appendChild(generateBtn);
  if (!eligibility.allowed) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'field-hint';
    reasonEl.textContent = eligibility.reason;
    panel.appendChild(reasonEl);
  }

  // --- GENERATION HISTORY -----------------------------------------------------
  const historyHeading = document.createElement('div');
  historyHeading.className = 'entity-sub';
  historyHeading.style.marginTop = '16px';
  historyHeading.textContent = 'Generation history:';
  panel.appendChild(historyHeading);

  if (!generations || generations.length === 0) {
    const none = document.createElement('div');
    none.className = 'state-box';
    none.textContent = 'No generation attempts yet.';
    panel.appendChild(none);
  } else {
    generations.forEach((gen) => panel.appendChild(renderKeyframeGenerationHistoryEntry(kf, gen)));
  }

  return panel;
}

function renderKeyframeGenerationHistoryEntry(kf, gen) {
  const card = document.createElement('div');
  card.className = 'entity-card';

  card.appendChild(statusBadge(gen.status));
  card.appendChild(infoRow('Provider', gen.provider));
  card.appendChild(infoRow('Model', gen.model));
  card.appendChild(infoRow('Reserved cost', gen.reservedCost));
  card.appendChild(infoRow('Generation ID', gen.id));
  card.appendChild(infoRow('Asset ID', gen.assetId));

  if (gen.asset) {
    card.appendChild(infoRow('Storage status', gen.asset.storage ? gen.asset.storage.status : null));
    card.appendChild(approvalBadge(gen.asset.approvalStatus));

    if (gen.asset.storage && gen.asset.storage.status === 'STORED') {
      const preview = document.createElement('img');
      preview.className = 'derived-prompt-box';
      preview.style.maxWidth = '160px';
      preview.src = `/assets/${gen.asset.assetId}/preview`;
      preview.alt = 'Generated keyframe preview';
      card.appendChild(preview);
    }

    // Part 13/17 — human review of the RESULT. Only ever shown for a
    // still-unreviewed (NONE) asset; approving/rejecting is always an
    // explicit click, never automatic.
    if (gen.asset.approvalStatus === 'NONE') {
      const reviewActions = document.createElement('div');
      reviewActions.className = 'form-actions';

      const approveKfBtn = document.createElement('button');
      approveKfBtn.type = 'button';
      approveKfBtn.className = 'btn';
      approveKfBtn.textContent = 'APPROVE KEYFRAME';
      approveKfBtn.addEventListener('click', async () => {
        await fetchJson(`/keyframes/${kf.keyframeId}/approval`, { method: 'POST', body: { approve: true, assetId: gen.asset.assetId, decidedBy: 'Creative Director UI' } });
        await loadKeyframeGenerationData(kf);
      });
      reviewActions.appendChild(approveKfBtn);

      const rejectKfBtn = document.createElement('button');
      rejectKfBtn.type = 'button';
      rejectKfBtn.className = 'btn btn-secondary';
      rejectKfBtn.textContent = 'REJECT KEYFRAME';
      rejectKfBtn.addEventListener('click', async () => {
        await fetchJson(`/keyframes/${kf.keyframeId}/approval`, { method: 'POST', body: { approve: false, assetId: gen.asset.assetId, decidedBy: 'Creative Director UI' } });
        await loadKeyframeGenerationData(kf);
      });
      reviewActions.appendChild(rejectKfBtn);

      card.appendChild(reviewActions);
    }
  }

  return card;
}

// --- Creative Skills panel (Part 11) — display only, never executes anything ------

const SKILL_DISPLAY_NAMES = {
  'video-prompt-builder': 'Video Prompt Builder',
  'cinema-worldbuilder-pro-2.0': 'Cinema Worldbuilder',
  'banana-pro-director-2.0': 'Banana Pro Director',
};

async function renderSkillPanel(shot) {
  const container = document.getElementById('creative-skill-panel');
  if (!shot) {
    showEmpty(container, 'Select a shot to see a recommended next step.');
    return;
  }

  showLoading(container);
  try {
    const [shotPromptRec, cinematicRec] = await Promise.all([
      fetchJson('/skills/recommendation?desiredOutput=shot-prompt&platform=evolink'),
      fetchJson('/skills/recommendation?needsCinematicPlanning=true'),
    ]);
    container.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'recommended-next-step-label';
    label.textContent = 'Recommended Next Step';
    container.appendChild(label);

    container.appendChild(renderSkillRecommendationCard(shotPromptRec));
    container.appendChild(renderSkillRecommendationCard(cinematicRec));
  } catch {
    showError(container, () => renderSkillPanel(shot));
  }
}

function renderSkillRecommendationCard(rec) {
  const card = document.createElement('div');
  card.className = 'skill-recommendation';

  const title = document.createElement('div');
  title.className = 'skill-title';
  title.textContent = rec.skillId ? SKILL_DISPLAY_NAMES[rec.skillId] || rec.skillId : 'No recommendation';
  card.appendChild(title);

  const reason = document.createElement('div');
  reason.className = 'skill-reason';
  reason.textContent = rec.reason;
  card.appendChild(reason);

  const flags = document.createElement('div');
  flags.className = 'skill-flags';
  const readyBadge = document.createElement('span');
  readyBadge.className = 'badge badge-none';
  readyBadge.textContent = rec.executable ? 'Adapter ready' : 'Not yet executable';
  flags.appendChild(readyBadge);
  card.appendChild(flags);

  return card;
}

// --- init ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadProjects();

  document.getElementById('tab-production').addEventListener('click', () => switchView('production'));
  document.getElementById('tab-creative').addEventListener('click', () => switchView('creative'));

  document.querySelectorAll('.creative-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => selectCreativeArtifact(btn.dataset.artifact));
  });
});
