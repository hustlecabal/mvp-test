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
};

// --- small fetch helper -----------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
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

// --- init ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadProjects();
});
