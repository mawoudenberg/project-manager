'use strict';

/* ─── Constants ────────────────────────────────────────────────────────────── */
const COLORS = [
  '#4f8ef7','#7c5cbf','#3ecf74','#f76060','#f7c948',
  '#f79040','#40c8f7','#f740c0','#80f740','#a0522d',
  '#00bfa5','#ff5252',
];

const DEFAULT_STAGES = [
  { name: 'Offerte',      color: '#f76060' },
  { name: 'Tekenen',      color: '#4f8ef7' },
  { name: 'CNC Frezen',   color: '#f7c948' },
  { name: 'Robot Frezen', color: '#f79040' },
  { name: '3D Printen',   color: '#e84393' },
  { name: 'Polyurea',     color: '#7c5cbf' },
  { name: 'Spuiter',      color: '#40c8f7' },
  { name: 'Grafisch',     color: '#f740c0' },
  { name: 'Decoratie',    color: '#80f740' },
  { name: 'Opleveren',    color: '#3ecf74' },
];

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

/* ─── State ────────────────────────────────────────────────────────────────── */
let state = {
  config: null,
  view: 'monthly',
  get today() { return new Date(); },  // always returns the actual current date
  cursor: new Date(),        // tracks month/week/day
  tasks: [],
  projects: [],
  stages: [],
  stageSlots: [],
  todoLists: [],
  todoItems: {},             // { listId: [...items] }
  editingTask: null,
  editingList: null,
  editingProject: null,
  editingStage: null,
  editingClient: null,
  clients: [],
  activeProject: null,
  expandedProjects: new Set(),
  ganttMode: 'week',   // 'week' | 'day'
  ganttHideInactive: true,
  ganttHideWeekends: false,
  ganttHiddenProjects: new Set(), // project IDs explicitly hidden by user
  projectsHideInactive: true,
  projectsFilter: 'active',
  projectsSearch: '',
  projectsSort: { field: 'date', dir: 'asc' },
  myTasksHideInactive: true,
  todoHideDone: false,
  calFilter: { tasks: 'active', stages: 'active' }, // tasks: 'all'|'active'|'none'  stages: 'all'|'active'|'none'
};

let ganttDrag = null;        // active drag state for Gantt bars
let ganttJustDragged = false; // suppress click after a drag
let calDragInProgress = false; // suppress poll re-render during calendar drag
let calDraggingTaskId = null;  // shared across monthly pages for drag-and-drop
let ganttWheelController = null; // AbortController for gantt wheel listener cleanup
let ganttDraw = null;            // active draw-new-bar drag state
let ganttWorkdays  = null;          // working-day Date[] when hide-weekends is active
let ganttDayOffFn  = null;          // index-of-date fn for hide-weekends mode
let _ganttRangeStart = null;        // ISO date string of first visible day in current gantt range
let _ganttRangeEnd   = null;        // ISO date string of last visible day in current gantt range

function _dayOffset(fromStr, toStr) {
  return Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
}

function _assignLanes(stages, weekStart, weekEnd) {
  const sorted = [...stages].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const laneEnds = [];
  return sorted.map(s => {
    const start = s.start_date < weekStart ? weekStart : s.start_date;
    const end   = s.end_date   > weekEnd   ? weekEnd   : s.end_date;
    let lane = laneEnds.findIndex(e => e < start);
    if (lane === -1) { lane = laneEnds.length; }
    laneEnds[lane] = end;
    return { s, lane, start, end };
  });
}

/* ─── Undo stack ────────────────────────────────────────────────────────────── */
const undoStack = [];
function pushUndo(label, fn) {
  undoStack.push({ label, fn });
  if (undoStack.length > 30) undoStack.shift();
}
document.addEventListener('keydown', async e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    // Don't hijack Cmd/Ctrl+Z while typing — let the field's native undo work,
    // and don't pop a stale app-level undo entry that could navigate away.
    const tag = document.activeElement?.tagName;
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    if (isEditable) return;
    e.preventDefault();
    const entry = undoStack.pop();
    if (entry) { await entry.fn(); toast(`↩ ${entry.label}`); }
  }
});

// ── Prevent scroll-wheel and arrow keys from changing number input values ──
// Scroll: blur the focused number input so the page scrolls instead
document.addEventListener('wheel', () => {
  if (document.activeElement?.type === 'number') document.activeElement.blur();
}, { passive: true });

// Arrow up/down: prevent value change, let the page scroll
document.addEventListener('keydown', e => {
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && document.activeElement?.type === 'number') {
    e.preventDefault();
    document.activeElement.blur();
  }
}, true);

/* ─── Startup ──────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

async function init() {
  buildColorSwatches();
  wireWizard();
  wireTaskModal();
  wireKlantModal();
  wireListModal();
  wireStageModal();
  wireSettings();
  wireCatalog();
  wireNav();
  wireTeam();
  wireProjectModal();
  initListeners();

  // Gantt drag: document-level listeners (registered once)
  document.addEventListener('mousemove', _onGanttDragMove);
  document.addEventListener('mouseup',   _onGanttDragEnd);

  // Close preset dropdown menus when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('.preset-wrap')) closeAllPresetMenus();
  });

  // Global Escape key: close whichever modal is open
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('task-modal').classList.contains('hidden'))     { closeTaskModal();    return; }
    if (!document.getElementById('stage-modal').classList.contains('hidden'))    { closeStageModal();   return; }
    if (!document.getElementById('project-modal').classList.contains('hidden'))  { closeProjectModal(); return; }
    if (!document.getElementById('list-modal').classList.contains('hidden'))     { closeListModal();    return; }
    if (!document.getElementById('settings-modal').classList.contains('hidden')) { document.getElementById('settings-modal').classList.add('hidden'); return; }
    if (!document.getElementById('team-modal').classList.contains('hidden'))     { document.getElementById('team-modal').classList.add('hidden');    return; }
  });

  const config = await api.configGet();
  if (!config || !config.name) {
    showWizard();
  } else {
    state.config = config;
    applyTheme(config.theme);
    await loadPresets();
    showApp();
    await loadAll();
    // Restore saved calendar preferences
    const calPrefs = loadCalPrefs();
    if (calPrefs.view && CAL_VIEWS.has(calPrefs.view)) state.view = calPrefs.view;
    if (calPrefs.filter) Object.assign(state.calFilter, calPrefs.filter);
    state.ganttHiddenProjects = loadGanttHidden();
    renderView();
    refreshTeamDatalist();
    startApiPolling();
  }
}

/* ─── Remote query wrapper ─────────────────────────────────────────────────── */
// In file-mode: calls local SQLite via IPC.
// In api-mode:  POSTs to /api/query on the Pi server.
async function remoteQuery(params) {
  if (state.config?.mode !== 'api') {
    return api.dbQuery(params);
  }
  const r = await api.apiFetch({
    method: 'POST',
    url:    `${state.config.apiUrl}/api/query`,
    body:   params,
  });
  if (r.status >= 400) {
    const msg = (r.data && typeof r.data === 'object' && r.data.error)
      ? r.data.error
      : `HTTP ${r.status}`;
    if (r.data?.trace) console.error('Server traceback:\n' + r.data.trace);
    throw new Error(msg);
  }
  // select returns array; insert returns {id}; update/delete returns {ok}
  return Array.isArray(r.data) ? r.data : (r.data ?? r);
}

/* ─── Project folder creation (API mode only) ──────────────────────────────── */
// Pick the first unused color from a list of items; falls back to least-used.
function pickNextColor(items = []) {
  const used = new Set(items.map(i => (i.color || '').toLowerCase()).filter(Boolean));
  const unused = COLORS.filter(c => !used.has(c.toLowerCase()));
  if (unused.length) return unused[0];
  const counts = Object.fromEntries(COLORS.map(c => [c, 0]));
  items.forEach(i => { if (i.color && counts[i.color] !== undefined) counts[i.color]++; });
  return COLORS.reduce((a, b) => counts[a] <= counts[b] ? a : b);
}
function pickProjectColor() {
  return pickNextColor(state.projects.filter(p => p.status === 'active'));
}

async function createProjectFromQuote(quoteName, askFirst = true, initialStatus = 'on_hold') {
  const name = (quoteName || '').trim();
  if (!name) return;
  const existing = state.projects.find(p => p.name.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    // A project may have been prepared while the quote was still pending. Once
    // accepted, promote that same project instead of leaving it hidden on hold.
    if (initialStatus === 'active' && existing.status === 'on_hold') {
      await remoteQuery({ action: 'update', table: 'projects', data: { status: 'active' }, where: { id: existing.id } });
      existing.status = 'active';
      moveProjectFolder(name, 'active');
      toast(`Project "${name}" is nu actief — offerte geaccepteerd`);
    } else {
      toast(`Project "${name}" bestaat al`);
    }
    return existing;
  }
  if (askFirst && !confirm(`Project aanmaken voor "${name}"?`)) return;
  try {
    await remoteQuery({ action: 'insert', table: 'projects', data: {
      name,
      status: initialStatus,
      color: pickProjectColor(),
      description: '',
    }});
    state.projects = await remoteQuery({ action: 'select', table: 'projects' });
    createProjectFolder(name); // fire-and-forget
    toast(initialStatus === 'on_hold'
      ? `📁 Project "${name}" aangemaakt — in de wacht tot acceptatie`
      : `📁 Project "${name}" aangemaakt`);
    return state.projects.find(p => p.name.trim().toLowerCase() === name.toLowerCase());
  } catch (e) {
    toast('Project aanmaken mislukt: ' + (e.message || e), 'error', 4000);
    console.error('Project aanmaken mislukt:', e);
  }
}

// The project a quote belongs to is tracked explicitly via qe.project_name —
// falls back to qe.name for quotes saved before this field existed (implicit
// link by name). Keeps the link stable across renames and duplicates.
function quoteProjectName() {
  return (qe.project_name || qe.name || '').trim();
}

// Een lokaal project kan aan MEERDERE Moneybird-projecten gekoppeld zijn (zelfde
// klus staat soms onder verschillende namen/tags in Moneybird). Daarom is
// moneybird_project_id een kommagescheiden lijst van Moneybird-project-ID's.
function mbIdsOf(proj) {
  return String((proj && proj.moneybird_project_id) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// Het project waar een offerte bij hoort (zelfde naam-koppeling als elders).
function quoteLinkedProject(q) {
  const linkName = (q.project_name || q.name || '').trim().toLowerCase();
  if (!linkName) return null;
  return state.projects.find(p => p.name.trim().toLowerCase() === linkName) || null;
}
// Afgeleid: een geaccepteerde offerte waarvan het gekoppelde project 'done' is,
// geldt als afgerond (al geleverd). Puur visueel — verandert de status niet.
function isQuoteFulfilled(q) {
  if (q.status !== 'accepted') return false;
  const p = quoteLinkedProject(q);
  return !!(p && p.status === 'done');
}

async function linkQuoteToProject(name) {
  const projectName = (name || '').trim();
  if (!projectName) return;
  qe.project_name = projectName;
  await persistQuoteProjectLink(qe.id, projectName);
}

async function persistQuoteProjectLink(quoteId, projectName) {
  if (!quoteId || !projectName) return;
  try {
    await remoteQuery({ action: 'update', table: 'quotes', data: { project_name: projectName }, where: { id: quoteId } });
  } catch (e) {
    console.warn('persistQuoteProjectLink failed:', e);
  }
}

// Gedeelde status-wijzigingslogica voor offertes — gebruikt door zowel de offerte-editor
// als de inline dropdown in het offerteoverzicht, zodat project/map-koppeling overal
// hetzelfde gedrag heeft. `quote` moet minstens {id, name, project_name, status} hebben;
// wordt in-place gemuteerd (zelfde object teruggeven aan de aanroeper is dan niet nodig).
async function changeQuoteStatus(quote, newStatus) {
  const oldStatus = quote.status;
  quote.status = newStatus;
  if (!quote.id) return;
  const data = { status: newStatus };
  if (newStatus === 'later' && oldStatus !== 'later') {
    // Vers op "later" gezet — klok voor de follow-up-herinnering opnieuw starten.
    data.later_since = new Date().toISOString();
    data.later_snoozed_until = '';
  } else if (newStatus !== 'later' && oldStatus === 'later') {
    data.later_since = '';
    data.later_snoozed_until = '';
  }
  if (newStatus === 'sent' && oldStatus !== 'sent') {
    // Vers verzonden — klok voor de follow-up-herinnering (reactie klant) opnieuw starten.
    data.sent_since = new Date().toISOString();
    data.sent_snoozed_until = '';
  } else if (newStatus !== 'sent' && oldStatus === 'sent') {
    data.sent_since = '';
    data.sent_snoozed_until = '';
  }
  Object.assign(quote, data);
  await remoteQuery({ action: 'update', table: 'quotes', data, where: { id: quote.id } });
  const linkName = (quote.project_name || quote.name || '').trim();
  if (!linkName) return;
  if (newStatus === 'sent' || newStatus === 'accepted') {
    await createProjectFromQuote(linkName, true, newStatus === 'accepted' ? 'active' : 'on_hold');
    quote.project_name = linkName;
    await persistQuoteProjectLink(quote.id, linkName);
  }
  if (newStatus === 'rejected') {
    moveProjectFolder(linkName, 'rejected');
    const proj = state.projects?.find(p => p.name.trim().toLowerCase() === linkName.toLowerCase());
    if (proj) {
      const hasStages = state.stages?.some(s => s.project_id === proj.id);
      const hasTasks  = state.tasks?.some(t => t.project_id === proj.id);
      if (!hasStages && !hasTasks) {
        await remoteQuery({ action: 'delete', table: 'projects', where: { id: proj.id } });
        if (state.projects) state.projects = state.projects.filter(p => p.id !== proj.id);
        toast(`Project "${proj.name}" verwijderd — offerte afgewezen en project had nog geen planning`);
      } else {
        toast(`📂 Map verplaatst naar Afgewezen offertes. Project heeft nog planning — controleer dit zelf.`, 'info', 5000);
      }
    }
  }
}

function computeSnoozeUntil(preset) {
  const d = new Date();
  if (preset === '1d') d.setDate(d.getDate() + 1);
  else if (preset === '1w') d.setDate(d.getDate() + 7);
  else if (preset === '1m') d.setMonth(d.getMonth() + 1);
  return d;
}

async function snoozeQuoteReminder(quoteId, until, field = 'later_snoozed_until') {
  await remoteQuery({ action: 'update', table: 'quotes', data: { [field]: until.toISOString() }, where: { id: quoteId } });
}

async function createProjectFolder(name) {
  if (state.config?.mode !== 'api') return; // local mode: no server filesystem
  try {
    const r = await api.apiFetch({
      method: 'POST',
      url:    `${state.config.apiUrl}/api/create-project-folder`,
      body:   { name },
    });
    if (r.status >= 400) {
      console.warn('Project map aanmaken mislukt:', r.data?.error || r.status);
    } else if (r.data?.created) {
      toast(`📂 Map "${name}" aangemaakt op server`);
    }
  } catch (e) {
    console.warn('create-project-folder error:', e);
  }
}

// Keeps a project's folder in sync with its status — moves it into/out of the
// "ZZ - Niet actieve projecten" subfolders. No-op if the folder doesn't exist
// yet or is already in the right place. `category` is 'active' | 'done' | 'on_hold' | 'rejected'.
async function moveProjectFolder(name, category) {
  if (state.config?.mode !== 'api') return; // local mode: no server filesystem
  try {
    const r = await api.apiFetch({
      method: 'POST',
      url:    `${state.config.apiUrl}/api/move-project-folder`,
      body:   { name, category },
    });
    if (r.status >= 400) {
      console.warn('Map verplaatsen mislukt:', r.data?.error || r.status);
    } else if (r.data?.moved) {
      toast(`📂 Map "${name}" verplaatst`);
    }
  } catch (e) {
    console.warn('move-project-folder error:', e);
  }
}

// Open a project folder in Finder/Explorer.
// First call: prompts the user to pick the projects root directory (saved to config).
async function openProjectFolder(name, forceReset = false) {
  if (!name?.trim()) { toast('Geen projectnaam opgegeven', 'warn'); return; }
  let dir = forceReset ? null : state.config?.localProjectsDir;
  if (!dir) {
    // First time (or reset): ask user to select the ROOT projects folder,
    // i.e. the folder that CONTAINS all individual project subfolders.
    toast('Selecteer de Projecten-map (de map die alle losse projectmappen bevat, NIET een individuele projectmap)', 'info', 6000);
    dir = await api.openFolder();
    if (!dir) return;
    const newCfg = { ...state.config, localProjectsDir: dir };
    await api.configSet({ localProjectsDir: dir });
    state.config = newCfg;
    // Update the display in settings if open
    const el = document.getElementById('cfg-projects-dir');
    if (el) el.value = dir;
    toast(`Projectenmap ingesteld op: ${dir}`);
  }
  const folderPath = dir.replace(/\/$/, '') + '/' + name.trim();
  if (typeof api.openPath === 'function') {
    api.openPath(folderPath);
  } else {
    toast('Map openen is alleen beschikbaar in de desktop app', 'warn');
  }
}

/* ─── API polling (API mode only) ─────────────────────────────────────────── */
let _pollingStarted = false;
function startApiPolling() {
  if (state.config?.mode !== 'api') return;
  if (_pollingStarted) return;
  _pollingStarted = true;
  setInterval(async () => {
    try {
      // Don't poll while a modal is open or a drag is in progress
      const modalOpen = ['task-modal','stage-modal','project-modal','list-modal','settings-modal','team-modal']
        .some(id => !document.getElementById(id)?.classList.contains('hidden'));
      if (modalOpen || calDragInProgress) return;

      const [tasks, projects, stages, stageSlots, todoLists, clients] = await Promise.all([
        remoteQuery({ action: 'select', table: 'tasks' }),
        remoteQuery({ action: 'select', table: 'projects' }),
        remoteQuery({ action: 'select', table: 'project_stages' }),
        remoteQuery({ action: 'select', table: 'stage_slots' }),
        remoteQuery({ action: 'select', table: 'todo_lists' }),
        remoteQuery({ action: 'select', table: 'clients' }),
      ]);

      if (!Array.isArray(tasks) || !Array.isArray(projects)) return; // bad response

      const changed =
        JSON.stringify(tasks)      !== JSON.stringify(state.tasks)    ||
        JSON.stringify(projects)   !== JSON.stringify(state.projects)  ||
        JSON.stringify(stages)     !== JSON.stringify(state.stages)    ||
        JSON.stringify(stageSlots) !== JSON.stringify(state.stageSlots) ||
        JSON.stringify(todoLists)  !== JSON.stringify(state.todoLists)  ||
        JSON.stringify(clients)    !== JSON.stringify(state.clients);

      if (!changed) return;

      state.tasks      = tasks;
      state.projects   = projects;
      state.stages     = stages;
      state.stageSlots = stageSlots;
      state.todoLists  = todoLists;
      state.clients    = clients;
      for (const list of state.todoLists) {
        state.todoItems[list.id] = await remoteQuery({
          action: 'select', table: 'todo_items', where: { list_id: list.id },
        });
      }
      // Never blindly re-render while editing a quote — its unsaved state lives only
      // in `qe`, and re-rendering would discard it (the dispatch table below has no
      // 'quote-editor' entry, so it used to fall back to the monthly view).
      if (state.view === 'quote-editor') return;
      renderView();
    } catch (_) {
      // silently ignore network errors during background poll
    }
  }, 5000);
}

/* ─── Data Loading ─────────────────────────────────────────────────────────── */
async function loadAll() {
  await Promise.all([loadTasks(), loadTodoLists(), loadProjects(), loadStages(), loadClients()]);
}

async function loadClients() {
  state.clients = await remoteQuery({ action: 'select', table: 'clients' });
}

async function loadProjects() {
  state.projects = await remoteQuery({ action: 'select', table: 'projects' });
}

async function loadStages() {
  const [stages, slots] = await Promise.all([
    remoteQuery({ action: 'select', table: 'project_stages' }),
    remoteQuery({ action: 'select', table: 'stage_slots' }),
  ]);
  state.stages     = stages;
  state.stageSlots = slots;
}

// Return flat bar rows: each slot joined with its parent stage.
// Used for calendar / Gantt rendering where each bar is a time range.
function stageBars() {
  const byId = {};
  for (const s of state.stages) byId[s.id] = s;
  const out = [];
  for (const slot of state.stageSlots) {
    const s = byId[slot.stage_id];
    if (!s) continue;
    out.push({
      id:         slot.id,          // slot id (for drag/delete)
      slot_id:    slot.id,
      stage_id:   s.id,
      project_id: s.project_id,
      name:       s.name,
      color:      s.color || '',
      notes:      s.notes || '',
      start_date: slot.start_date,
      end_date:   slot.end_date,
      sort_order: slot.sort_order,
    });
  }
  return out;
}

async function loadTasks() {
  state.tasks = await remoteQuery({ action: 'select', table: 'tasks' });
}

async function loadTodoLists() {
  state.todoLists = await remoteQuery({ action: 'select', table: 'todo_lists' });
  for (const list of state.todoLists) {
    state.todoItems[list.id] = await remoteQuery({
      action: 'select', table: 'todo_items', where: { list_id: list.id },
    });
  }
}

/* ─── View routing ─────────────────────────────────────────────────────────── */
function renderView() {
  const views = {
    monthly:  renderMonthly,
    weekly:   renderWeekly,
    daily:    renderDaily,
    yearly:   renderYearly,
    mytasks:  renderMyTasks,
    todo:     renderTodo,
    quotes:   renderQuoteList,
    gantt:    renderGantt,
    projects: renderProjectsView,
    klanten:  renderKlanten,
    analyse:  renderBedrijfsanalyse,
    'quote-editor': renderQuoteEditorView,
  };
  (views[state.view] || renderMonthly)();
}

const CAL_VIEWS = new Set(['monthly', 'weekly', 'daily', 'yearly', 'gantt']);

const CAL_PREFS_KEY = 'calPrefs';
function saveCalPrefs() {
  if (CAL_VIEWS.has(state.view)) {
    localStorage.setItem(CAL_PREFS_KEY, JSON.stringify({
      view: state.view,
      filter: state.calFilter,
    }));
  }
}
function loadCalPrefs() {
  try { return JSON.parse(localStorage.getItem(CAL_PREFS_KEY)) || {}; } catch (_) { return {}; }
}

const GANTT_HIDDEN_KEY = 'ganttHiddenProjects';
function saveGanttHidden() {
  localStorage.setItem(GANTT_HIDDEN_KEY, JSON.stringify([...state.ganttHiddenProjects]));
}
function loadGanttHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(GANTT_HIDDEN_KEY)) || []); } catch (_) { return new Set(); }
}

function _confirmUnsavedQE(cb) {
  const quoteName = qe?.name ? `"${qe.name}"` : 'deze offerte';
  const overlay = document.createElement('div');
  overlay.className = 'qe-unsaved-overlay';
  overlay.innerHTML = `
    <div class="qe-unsaved-box">
      <p class="qe-unsaved-msg">Je hebt niet-opgeslagen wijzigingen in ${escHtml(quoteName)}.<br>Wil je opslaan voordat je weggaat?</p>
      <div class="qe-unsaved-btns">
        <button class="btn btn-primary btn-sm" id="qeuc-save">Opslaan</button>
        <button class="btn btn-ghost  btn-sm" id="qeuc-discard">Niet opslaan</button>
        <button class="btn btn-ghost  btn-sm" id="qeuc-cancel">Annuleren</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#qeuc-save').onclick    = () => { overlay.remove(); cb('save'); };
  overlay.querySelector('#qeuc-discard').onclick = () => { overlay.remove(); cb('discard'); };
  overlay.querySelector('#qeuc-cancel').onclick  = () => { overlay.remove(); cb('cancel'); };
}

function setView(view) {
  // Warn before leaving the quote editor with unsaved changes. A brand-new
  // quote (no qe.id yet) counts as unsaved even if _qeDirty is still false —
  // e.g. one created via the wizard and never touched afterwards.
  if (state.view === 'quote-editor' && qe && (_qeDirty || !qe.id) && view !== 'quote-editor') {
    _confirmUnsavedQE(result => {
      if (result === 'save') {
        performSave().then(saved => { if (saved) { qe = null; _qeDirty = false; setView(view); } });
      } else if (result === 'discard') {
        _qeDirty = false;
        setView(view);
      }
      // 'cancel' → stay on page
    });
    return;
  }
  if (state.view === 'quote-editor') { qe = null; _qeDirty = false; }
  state.view = view;
  state.activeProject = null;
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => {
    const isActive = b.dataset.view === view || (b.dataset.view === 'calendar' && CAL_VIEWS.has(view));
    b.classList.toggle('active', isActive);
  });
  const titles = { monthly:'', weekly:'', daily:'', yearly:'Kalender', mytasks:'Mijn Taken', todo:'Takenlijsten', quotes:'Offertes', gantt:'Gantt', projects:'Projecten', klanten:'Klanten', analyse:'Bedrijfsanalyse' };
  const titleEl = document.getElementById('toolbar-title');
  titleEl.className = '';
  titleEl.textContent = titles[view] ?? '';
  if (view !== 'monthly') document.getElementById('content').className = '';
  if (!CAL_VIEWS.has(view)) document.getElementById('cal-filter-bar')?.remove();
  saveCalPrefs();
  renderView();
}

function calViewToggleHTML(active) {
  return `
  <div class="gantt-mode-toggle">
    <button class="gmt-btn${active==='daily'?' active':''}" id="cvt-day">Dag</button>
    <button class="gmt-btn${active==='weekly'?' active':''}" id="cvt-week">Week</button>
    <button class="gmt-btn${active==='monthly'?' active':''}" id="cvt-month">Maand</button>
    <button class="gmt-btn${active==='gantt'?' active':''}" id="cvt-gantt">Gantt</button>
  </div>`;
}
function renderCalFilterBar() {
  const f = state.calFilter;
  const wasOpen = document.getElementById('cfb-content')?.classList.contains('open');
  let bar = document.getElementById('cal-filter-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'cal-filter-bar';
    document.getElementById('toolbar').after(bar);
  }

  const activeLabel = [
    f.tasks   !== 'active' ? `Taken: ${f.tasks === 'all' ? 'alles' : 'uit'}` : '',
    f.stages  !== 'active' ? `Fases: ${f.stages === 'all' ? 'alles' : 'uit'}` : '',
  ].filter(Boolean).join(' · ') || 'Filters';

  bar.innerHTML = `
    <button class="cfb-toggle-btn" id="cfb-toggle">${activeLabel} ▾</button>
    <div class="cfb-content${wasOpen ? ' open' : ''}" id="cfb-content">
      <span class="cfp-label">Taken</span>
      <div class="gantt-mode-toggle">
        <button class="gmt-btn${f.tasks==='all'?' active':''}"    data-cf="tasks-all">Alles</button>
        <button class="gmt-btn${f.tasks==='active'?' active':''}" data-cf="tasks-active">Open</button>
        <button class="gmt-btn${f.tasks==='none'?' active':''}"   data-cf="tasks-none">Uit</button>
      </div>
      <span class="cfp-label">Fases</span>
      <div class="gantt-mode-toggle">
        <button class="gmt-btn${f.stages==='all'?' active':''}"    data-cf="stages-all">Alles</button>
        <button class="gmt-btn${f.stages==='active'?' active':''}" data-cf="stages-active">Actief</button>
        <button class="gmt-btn${f.stages==='none'?' active':''}"   data-cf="stages-none">Uit</button>
      </div>
    </div>`;

  document.getElementById('cfb-toggle').addEventListener('click', () => {
    const content = document.getElementById('cfb-content');
    const open = content.classList.toggle('open');
    document.getElementById('cfb-toggle').textContent = (open ? activeLabel + ' ▴' : activeLabel + ' ▾');
  });

  bar.querySelectorAll('[data-cf]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [key, val] = btn.dataset.cf.split('-');
      state.calFilter[key] = val;
      saveCalPrefs();
      renderView();
    });
  });
}
function wireCalViewToggle() {
  document.getElementById('cvt-day')?.addEventListener('click',   () => { state.cursor = new Date(state.today); setView('daily'); });
  document.getElementById('cvt-week')?.addEventListener('click',  () => { state.cursor = new Date(state.today); setView('weekly'); });
  document.getElementById('cvt-month')?.addEventListener('click', () => { state.cursor = new Date(state.today); setView('monthly'); });
  document.getElementById('cvt-gantt')?.addEventListener('click', () => { setView('gantt'); });
}

/* ─── Monthly View ─────────────────────────────────────────────────────────── */
function buildMonthGrid(year, month, todayStr) {
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const allCells = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayNum = daysInPrev - i;
    allCells.push({ dayNum, dateStr: toDateStr(new Date(year, month - 1, dayNum)), other: true });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    allCells.push({ dayNum: day, dateStr: toDateStr(new Date(year, month, day)), other: false });
  }
  const remaining = (7 - (allCells.length % 7)) % 7;
  for (let day = 1; day <= remaining; day++) {
    allCells.push({ dayNum: day, dateStr: toDateStr(new Date(year, month + 1, day)), other: true });
  }

  // Group cells into weeks
  const weeks = [];
  for (let i = 0; i < allCells.length; i += 7) weeks.push(allCells.slice(i, i + 7));

  // Compute once for all weeks
  const monthVisStages = visibleStages();

  let html = '<div class="monthly-grid">';
  html += '<div class="cal-week-num-header">Wk</div>';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach((d, i) => {
    html += `<div class="cal-header-cell${i >= 5 ? ' weekend' : ''}">${d}</div>`;
  });

  weeks.forEach(week => {
    const weekStart = week[0].dateStr;
    const weekEnd   = week[6].dateStr;
    const weekNum   = getISOWeek(new Date(weekStart));

    // Stages overlapping this week (must have both start and end)
    const weekStages = monthVisStages.filter(s =>
      s.start_date && s.end_date &&
      s.start_date <= weekEnd && s.end_date >= weekStart
    );

    const laned = weekStages.length ? _assignLanes(weekStages, weekStart, weekEnd) : [];
    const numLanes = laned.length ? Math.max(...laned.map(l => l.lane)) + 1 : 0;

    // Week-num cell spans 2 grid rows (stage bar row + day cells row)
    html += `<div class="cal-week-num" style="grid-row: span 2">${weekNum}</div>`;

    // Stage bars row (grid-column 2/9 = all 7 day columns)
    if (numLanes > 0) {
      const rowH = Math.min(numLanes, 3) * 20 + 4;
      html += `<div class="month-stage-bar-row" style="height:${rowH}px">`;
      laned.slice(0, 21).forEach(({ s, lane, start, end }) => {
        if (lane >= 3) return; // max 3 lanes
        const startDow = (new Date(start + 'T00:00:00').getDay() + 6) % 7;
        const endDow   = (new Date(end   + 'T00:00:00').getDay() + 6) % 7;
        const left  = (startDow / 7 * 100).toFixed(2);
        const width = ((endDow - startDow + 1) / 7 * 100).toFixed(2);
        const isStart = s.start_date >= weekStart;
        const isEnd   = s.end_date   <= weekEnd;
        const br = `${isStart ? '3px' : '0'} ${isEnd ? '3px' : '0'} ${isEnd ? '3px' : '0'} ${isStart ? '3px' : '0'}`;
        const proj = state.projects.find(p => p.id === s.project_id);
        const label = proj ? `${proj.name} · ${s.name}` : s.name;
        const sBarBg = s.color || '#4f8ef7';
        html += `<div class="month-sbar" data-stage-id="${s.stage_id}"
          style="left:${left}%;width:${width}%;top:${lane * 20 + 2}px;background:${sBarBg};color:${contrastColor(sBarBg)};border-radius:${br}"
          title="${escHtml(label)}">${isStart ? escHtml(label) : ''}</div>`;
      });
      html += `</div>`;
    } else {
      html += `<div class="month-stage-bar-row month-stage-bar-row-empty"></div>`;
    }

    // 7 day cells
    week.forEach(c => { html += calCell(c.dayNum, c.dateStr, c.other, todayStr); });
  });

  html += '</div>';
  return html;
}

function attachCalHandlers(container) {
  // Stage bar clicks (multi-day bars above day cells)
  container.querySelectorAll('.month-sbar').forEach(bar => {
    bar.addEventListener('click', e => {
      e.stopPropagation();
      const stage = state.stages.find(s => s.id == bar.dataset.stageId);
      if (stage) openStageModal(stage, stage.project_id);
    });
  });

  container.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.target.closest('.cal-chip')) return;
      openTaskModal(null, cell.dataset.date);
    });
    cell.querySelectorAll('.cal-chip:not(.cal-chip-stage)').forEach(chip => {
      chip.addEventListener('click', e => {
        e.stopPropagation();
        const task = state.tasks.find(t => t.id == chip.dataset.id);
        if (task) openTaskModal(task);
      });
    });
  });
  container.querySelectorAll('.cal-chip:not(.cal-chip-stage)').forEach(chip => {
    chip.addEventListener('dragstart', e => {
      calDraggingTaskId = chip.dataset.id;
      calDragInProgress = true;
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => {
      calDragInProgress = false;
      chip.classList.remove('dragging');
      container.querySelectorAll('.cal-cell.drag-over').forEach(c => c.classList.remove('drag-over'));
    });
  });
  container.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('dragover', e => {
      if (!calDraggingTaskId) return;
      e.preventDefault();
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', async e => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      if (!calDraggingTaskId) return;
      const newDate = cell.dataset.date;
      const task = state.tasks.find(t => t.id == calDraggingTaskId);
      if (!task || task.date === newDate) return;
      const oldDate = task.date;
      pushUndo(`verplaats "${escHtml(task.title)}"`, async () => {
        await remoteQuery({ action: 'update', table: 'tasks', data: { date: oldDate }, where: { id: task.id } });
        await loadTasks(); renderMonthly();
      });
      await remoteQuery({ action: 'update', table: 'tasks', data: { date: newDate }, where: { id: Number(calDraggingTaskId) } });
      await loadTasks();
      renderMonthly();
    });
  });
}

function renderMonthly() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');
  const RANGE = 18;
  const cy = state.cursor.getFullYear(), cm = state.cursor.getMonth();
  const todayStr = toDateStr(state.today);

  const titleEl = document.getElementById('toolbar-title');
  titleEl.className = 'cal-title';
  titleEl.innerHTML = `<span class="cal-period-label">${MONTHS[cm]}</span><span class="cal-period-year">${cy}</span>`;

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="cal-prev">‹</button>
      <button class="btn-icon" id="cal-next">›</button>
      <button class="btn btn-ghost btn-sm" id="cal-today">Vandaag</button>
      ${calViewToggleHTML('monthly')}
      <button class="btn btn-primary btn-sm" id="cal-add">+ Taak toevoegen</button>
    </div>`;
  wireCalViewToggle();
  renderCalFilterBar();

  content.className = 'monthly-mode';

  let html = '<div id="monthly-scroll">';
  for (let offset = -RANGE; offset <= RANGE; offset++) {
    const d = new Date(cy, cm + offset, 1);
    const y = d.getFullYear(), m = d.getMonth();
    html += `<div class="month-page" data-year="${y}" data-month="${m}">${buildMonthGrid(y, m, todayStr)}</div>`;
  }
  html += '</div>';
  content.innerHTML = html;

  // Scroll to cursor month without animation
  const scroll = document.getElementById('monthly-scroll');
  content.querySelectorAll('.month-page')[RANGE].scrollIntoView({ behavior: 'instant' });

  // Track visible month → update label + cursor.
  // observerReady prevents the initial scrollIntoView from overwriting state.cursor.
  let observerReady = false;
  setTimeout(() => { observerReady = true; }, 300);

  const observer = new IntersectionObserver(entries => {
    // Pick the entry with the largest intersection ratio (most visible month)
    const best = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!best) return;
    const y = parseInt(best.target.dataset.year), m = parseInt(best.target.dataset.month);
    if (observerReady) state.cursor = new Date(y, m, 1);
    const titleEl = document.getElementById('toolbar-title');
    if (titleEl) titleEl.innerHTML = `<span class="cal-period-label">${MONTHS[m]}</span><span class="cal-period-year">${y}</span>`;
  }, { threshold: [0, 0.25, 0.5, 0.75, 1], root: scroll });
  content.querySelectorAll('.month-page').forEach(p => observer.observe(p));

  document.getElementById('cal-prev').onclick  = () => scroll.scrollBy({ top: -scroll.clientHeight, behavior: 'smooth' });
  document.getElementById('cal-next').onclick  = () => scroll.scrollBy({ top:  scroll.clientHeight, behavior: 'smooth' });
  document.getElementById('cal-today').onclick = () => {
    state.cursor = new Date();
    renderMonthly();
  };
  document.getElementById('cal-add').onclick  = () => openTaskModal(null, toDateStr(state.cursor));

  attachCalHandlers(content);
}

/* ─── Yearly View ──────────────────────────────────────────────────────────── */
function renderYearly() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');
  const year = state.cursor.getFullYear();
  const todayStr = toDateStr(state.today);

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="yr-prev">‹</button>
      <span>${year}</span>
      <button class="btn-icon" id="yr-next">›</button>
      <button class="btn btn-primary btn-sm" id="yr-today">Today</button>
    </div>`;

  document.getElementById('yr-prev').onclick = () => { state.cursor = new Date(year - 1, 0, 1); renderYearly(); };
  document.getElementById('yr-next').onclick = () => { state.cursor = new Date(year + 1, 0, 1); renderYearly(); };
  document.getElementById('yr-today').onclick = () => { state.cursor = new Date(state.today); renderYearly(); };

  // Pre-index tasks by date string for O(1) lookup
  const tasksByDate = {};
  for (const t of state.tasks) {
    if (!t.date) continue;
    if (!tasksByDate[t.date]) tasksByDate[t.date] = [];
    tasksByDate[t.date].push(t);
  }

  const DOW_LABELS = ['M','T','W','T','F','S','S'];

  let html = '<div id="yearly-grid">';
  for (let m = 0; m < 12; m++) {
    const firstDay = (new Date(year, m, 1).getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(year, m + 1, 0).getDate();

    let dowRow = DOW_LABELS.map(d => `<div class="yr-dow">${d}</div>`).join('');

    // Blank cells before first day
    let cells = '';
    for (let b = 0; b < firstDay; b++) cells += '<div class="yr-day"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday = dateStr === todayStr;
      const dayTasks = tasksByDate[dateStr] || [];
      const hasTasks = dayTasks.length > 0;
      const dot = hasTasks
        ? `<div class="yr-dot" style="background:${taskColor(dayTasks[0])}"></div>`
        : '';
      const cls = ['yr-day', isToday && 'yr-today', hasTasks && 'yr-has-tasks'].filter(Boolean).join(' ');
      cells += `<div class="${cls}" data-date="${dateStr}"><div class="yr-day-num">${d}</div>${dot}</div>`;
    }

    html += `
      <div class="yr-month">
        <div class="yr-month-name">${MONTHS[m]}</div>
        <div class="yr-dow-row">${dowRow}</div>
        <div class="yr-days-grid">${cells}</div>
      </div>`;
  }
  html += '</div>';
  content.innerHTML = html;

  content.querySelectorAll('.yr-day[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      state.cursor = new Date(cell.dataset.date + 'T00:00:00');
      setView('daily');
    });
  });
}

function calTaskVisible(task) {
  const f = state.calFilter.tasks;
  if (f === 'none')   return false;
  if (f === 'active') return task.status !== 'done';
  return true;
}

function visibleStages() {
  // Returns stage "bars" (slot+stage joins) filtered by the calendar's stage filter.
  const f = state.calFilter.stages;
  if (f === 'none') return [];
  const bars = stageBars();
  if (f === 'active') {
    const activeIds = new Set(state.projects.filter(p => p.status === 'active').map(p => p.id));
    return bars.filter(b => activeIds.has(b.project_id));
  }
  return bars;
}

// Stages that start or end on a given date (for monthly/weekly chips)
function stagesForDate(dateStr, stages = visibleStages()) {
  const result = [];
  stages.forEach(s => {
    const proj = state.projects.find(p => p.id === s.project_id);
    const projName = proj ? proj.name : '';
    if (s.start_date === dateStr) {
      const displayTitle = projName ? `${projName} · ${s.name}` : s.name;
      result.push({ ...s, isStage: true, stageEvent: s.end_date === dateStr ? 'both' : 'start', displayTitle, projName });
    } else if (s.end_date === dateStr) {
      const displayTitle = projName ? `${projName} · ${s.name}` : s.name;
      result.push({ ...s, isStage: true, stageEvent: 'end', displayTitle, projName });
    }
  });
  return result;
}

// Stages spanning (active on) a given date (for daily view)
function stagesActiveOnDate(dateStr) {
  return visibleStages()
    .filter(s => s.start_date && s.end_date && s.start_date <= dateStr && s.end_date >= dateStr)
    .map(s => {
      const proj = state.projects.find(p => p.id === s.project_id);
      const event = s.start_date === dateStr && s.end_date === dateStr ? 'both'
                  : s.start_date === dateStr ? 'start'
                  : s.end_date   === dateStr ? 'end'
                  : 'active';
      const projName = proj ? proj.name : '';
      const displayTitle = projName ? `${projName} · ${s.name}` : s.name;
      return { ...s, isStage: true, stageEvent: event, displayTitle, projName };
    });
}

function calCell(dayNum, dateStr, otherMonth, todayStr) {
  const dayTasks = state.tasks.filter(t => t.date === dateStr && calTaskVisible(t));
  const isToday = dateStr === todayStr;
  const dow = new Date(dateStr + 'T00:00:00').getDay(); // 0=Sun,6=Sat
  const isWeekend = dow === 0 || dow === 6;
  const holiday = !otherMonth ? getDutchHolidays(parseInt(dateStr.slice(0,4)))[dateStr] : null;
  const classes = ['cal-cell', otherMonth && 'other-month', isToday && 'today', isWeekend && 'weekend', holiday && 'holiday']
    .filter(Boolean).join(' ');

  let chips = dayTasks.slice(0, 3).map(t => {
    const bg = taskColor(t);
    return `<div class="cal-chip ${t.status==='done'?'done':''}" data-id="${t.id}"
         draggable="true" style="background:${bg};color:${contrastColor(bg)}"
         title="${escHtml(t.title)}">${escHtml(t.title)}</div>`;
  }).join('');

  const remaining = dayTasks.length - 3;
  if (remaining > 0) {
    chips += `<div class="cal-more">+${remaining} more</div>`;
  }

  return `<div class="${classes}" data-date="${dateStr}">
    <div class="cal-day-num">${dayNum}${holiday ? `<span class="cal-holiday-name">${escHtml(holiday)}</span>` : ''}</div>
    <div class="cal-chips">${chips}</div>
  </div>`;
}

/* ─── My Tasks View ────────────────────────────────────────────────────────── */
// Sub-view state for Mijn Taken
if (!state.myTasksView)   state.myTasksView   = 'list';
if (!state.myTasksCursor) state.myTasksCursor = new Date();

function renderMyTasks() {
  const content = document.getElementById('content');
  const ctrl    = document.getElementById('toolbar-controls');
  const me      = state.config?.name || '';
  const todayStr = toDateStr(state.today);

  const NL_MONTHS = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  const NL_DAYS   = ['zo','ma','di','wo','do','vr','za'];

  function fmtDateHeader(dateStr) {
    if (!dateStr) return 'Geen datum';
    const d = new Date(dateStr + 'T00:00:00');
    const dow = NL_DAYS[d.getDay()];
    const base = `${dow} ${d.getDate()} ${NL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (dateStr === todayStr) return `Vandaag · ${dow} ${d.getDate()} ${NL_MONTHS[d.getMonth()]}`;
    if (dateStr < todayStr)  return `⚠ ${base}`;
    return base;
  }

  // Toolbar
  const subView = state.myTasksView;
  let navHtml = '';
  if (subView === 'day') {
    const cur = state.myTasksCursor;
    const label = cur.toDateString() === state.today.toDateString()
      ? `Vandaag · ${NL_DAYS[cur.getDay()]} ${cur.getDate()} ${NL_MONTHS[cur.getMonth()]}`
      : `${NL_DAYS[cur.getDay()]} ${cur.getDate()} ${NL_MONTHS[cur.getMonth()]} ${cur.getFullYear()}`;
    navHtml = `<div class="cal-nav">
      <button class="btn-icon" id="mt-prev">‹</button>
      <span>${label}</span>
      <button class="btn-icon" id="mt-next">›</button>
    </div>`;
  } else if (subView === 'week') {
    const monday = new Date(state.myTasksCursor);
    const day = monday.getDay();
    monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const label = `${monday.getDate()} ${NL_MONTHS[monday.getMonth()]} – ${sunday.getDate()} ${NL_MONTHS[sunday.getMonth()]} ${sunday.getFullYear()}`;
    navHtml = `<div class="cal-nav">
      <button class="btn-icon" id="mt-prev">‹</button>
      <span>${label}</span>
      <button class="btn-icon" id="mt-next">›</button>
    </div>`;
  }

  ctrl.innerHTML = `<div class="mt-toolbar">
    ${navHtml}
    <div class="mt-view-toggle">
      <button class="btn btn-sm${subView==='list'?' btn-primary':''}" data-mtview="list">Lijst</button>
      <button class="btn btn-sm${subView==='day' ?' btn-primary':''}" data-mtview="day">Dag</button>
      <button class="btn btn-sm${subView==='week'?' btn-primary':''}" data-mtview="week">Week</button>
    </div>
    <button class="btn btn-sm${state.myTasksHideInactive?' btn-primary':' btn-ghost'}" id="mt-filter-btn">
      ${state.myTasksHideInactive ? 'Toon alles' : 'Alleen actief'}
    </button>
  </div>`;

  ctrl.querySelectorAll('[data-mtview]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.myTasksView = btn.dataset.mtview;
      state.myTasksCursor = new Date();
      renderMyTasks();
    });
  });
  document.getElementById('mt-filter-btn')?.addEventListener('click', () => {
    state.myTasksHideInactive = !state.myTasksHideInactive;
    renderMyTasks();
  });
  if (subView === 'day') {
    ctrl.querySelector('#mt-prev')?.addEventListener('click', () => {
      state.myTasksCursor = new Date(state.myTasksCursor);
      state.myTasksCursor.setDate(state.myTasksCursor.getDate() - 1);
      renderMyTasks();
    });
    ctrl.querySelector('#mt-next')?.addEventListener('click', () => {
      state.myTasksCursor = new Date(state.myTasksCursor);
      state.myTasksCursor.setDate(state.myTasksCursor.getDate() + 1);
      renderMyTasks();
    });
  } else if (subView === 'week') {
    ctrl.querySelector('#mt-prev')?.addEventListener('click', () => {
      state.myTasksCursor = new Date(state.myTasksCursor);
      state.myTasksCursor.setDate(state.myTasksCursor.getDate() - 7);
      renderMyTasks();
    });
    ctrl.querySelector('#mt-next')?.addEventListener('click', () => {
      state.myTasksCursor = new Date(state.myTasksCursor);
      state.myTasksCursor.setDate(state.myTasksCursor.getDate() + 7);
      renderMyTasks();
    });
  }

  // Filter tasks for this user
  const allMine = state.tasks
    .filter(t => t.assigned_to && t.assigned_to.split(',').map(s => s.trim()).includes(me))
    .filter(t => !state.myTasksHideInactive || t.status !== 'done')
    .sort((a, b) => {
      const da = (a.date || '9999') + (a.task_time || '');
      const db = (b.date || '9999') + (b.task_time || '');
      return da < db ? -1 : da > db ? 1 : 0;
    });

  // Determine which dates to show
  let dateKeys;
  if (subView === 'day') {
    dateKeys = [toDateStr(state.myTasksCursor)];
  } else if (subView === 'week') {
    const monday = new Date(state.myTasksCursor);
    const day = monday.getDay();
    monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
    dateKeys = Array.from({length: 7}, (_, i) => {
      const d = new Date(monday); d.setDate(monday.getDate() + i); return toDateStr(d);
    });
  } else {
    // List: all dates that have tasks
    dateKeys = [...new Set(allMine.map(t => t.date || ''))].sort();
  }

  // Build groups
  const groups = {};
  dateKeys.forEach(k => { groups[k] = allMine.filter(t => (t.date || '') === k); });

  function taskRow(t) {
    const proj = state.projects.find(p => p.id === t.project_id);
    const timeLabel = !t.all_day && t.task_time ? `<span class="mt-time">${t.task_time}</span>` : '';
    const projLabel = proj ? `<span class="mt-proj" style="background:${proj.color}20;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
    const done = t.status === 'done';
    return `<div class="mytasks-row${done ? ' done' : ''}" data-id="${t.id}">
      <input type="checkbox" class="mt-check" data-id="${t.id}" ${done ? 'checked' : ''} title="Markeer als afgerond">
      <div class="mt-color" style="background:${taskColor(t)}"></div>
      <div class="mt-body">
        <div class="mt-title">${escHtml(t.title)}</div>
        <div class="mt-meta">${timeLabel}${projLabel}</div>
      </div>
    </div>`;
  }

  const hasAny = dateKeys.some(k => groups[k]?.length);
  let html = '<div class="mytasks-list">';
  if (!hasAny) {
    html += `<div style="padding:48px;text-align:center;color:var(--text2)">Geen taken voor deze periode</div>`;
  } else {
    for (const dateKey of dateKeys) {
      const tasks = groups[dateKey] || [];
      if (subView !== 'day' && tasks.length === 0) continue; // hide empty days in list/week
      const isToday = dateKey === todayStr;
      const isPast  = dateKey && dateKey < todayStr;
      html += `<div class="mytasks-group">
        <div class="mytasks-date-header${isToday?' today':isPast?' past':''}">${fmtDateHeader(dateKey)}</div>`;
      if (tasks.length === 0) {
        html += `<div style="padding:8px 0;color:var(--text2);font-size:13px">Geen taken</div>`;
      } else {
        tasks.forEach(t => { html += taskRow(t); });
      }
      html += '</div>';
    }
  }
  html += '</div>';
  content.innerHTML = html;

  // Click to edit (row body, not checkbox)
  content.querySelectorAll('.mytasks-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('mt-check')) return;
      const task = state.tasks.find(t => t.id === Number(row.dataset.id));
      if (task) openTaskModal(task);
    });
  });

  // Checkbox: toggle done/pending
  content.querySelectorAll('.mt-check').forEach(cb => {
    cb.addEventListener('change', async e => {
      e.stopPropagation();
      const id = Number(cb.dataset.id);
      const task = state.tasks.find(t => t.id === id);
      const oldStatus = task?.status;
      const newStatus = cb.checked ? 'done' : 'pending';
      pushUndo(`status "${escHtml(task?.title)}"`, async () => {
        await remoteQuery({ action: 'update', table: 'tasks', data: { status: oldStatus }, where: { id } });
        if (task) task.status = oldStatus;
        renderMyTasks();
      });
      await remoteQuery({ action: 'update', table: 'tasks', data: { status: newStatus }, where: { id } });
      if (task) task.status = newStatus;
      renderMyTasks();
    });
  });
}

/* ─── Weekly View ──────────────────────────────────────────────────────────── */
function renderWeekly() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');

  // Find Monday of the week. On Sunday (day=0) the ISO week is almost over,
  // so show the upcoming week instead — feels more useful than "last 6 days."
  const d = new Date(state.cursor);
  const day = d.getDay();
  const monday = new Date(d);
  if (day === 0) {
    monday.setDate(d.getDate() + 1); // Sunday → next Monday
  } else {
    monday.setDate(d.getDate() - (day - 1));
  }

  const weekDates = Array.from({length: 7}, (_, i) => {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    return dd;
  });

  const todayStr = toDateStr(state.today);
  const wkNum = getISOWeek(monday);
  const startFmt = `${monday.getDate()} ${MONTHS[monday.getMonth()].slice(0,3)}`;
  const endFmt   = `${weekDates[6].getDate()} ${MONTHS[weekDates[6].getMonth()].slice(0,3)}`;
  const weekLabel = `Week ${wkNum} · ${startFmt} – ${endFmt} ${weekDates[6].getFullYear()}`;

  const wkTitleEl = document.getElementById('toolbar-title');
  wkTitleEl.className = 'cal-title';
  wkTitleEl.innerHTML = `<span class="cal-period-label">Week ${wkNum}</span><span class="cal-period-year">${startFmt} – ${endFmt}</span>`;

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="wk-prev">‹</button>
      <button class="btn-icon" id="wk-next">›</button>
      <button class="btn btn-ghost btn-sm" id="wk-today">Vandaag</button>
      ${calViewToggleHTML('weekly')}
    </div>`;
  wireCalViewToggle();
  renderCalFilterBar();

  document.getElementById('wk-prev').onclick  = () => { state.cursor = new Date(monday); state.cursor.setDate(monday.getDate() - 7); renderWeekly(); };
  document.getElementById('wk-next').onclick  = () => { state.cursor = new Date(monday); state.cursor.setDate(monday.getDate() + 7); renderWeekly(); };
  document.getElementById('wk-today').onclick = () => { state.cursor = new Date(); renderWeekly(); };

  const weekVisStages = visibleStages();
  let html = '<div id="weekly-grid">';
  weekDates.forEach(date => {
    const dateStr = toDateStr(date);
    const isToday = dateStr === todayStr;
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const dayTasks = state.tasks.filter(t => t.date === dateStr && calTaskVisible(t));
    const dayStages = stagesForDate(dateStr, weekVisStages);
    const stageCards = dayStages.map(s => {
      const icon = s.stageEvent === 'end' || s.stageEvent === 'both' ? '🏁' : '▶';
      const sbg = s.color || '#3ecf74';
      return `<div class="week-task-card cal-chip-stage cal-chip-stage-${s.stageEvent}" data-stage-id="${s.stage_id}"
           style="background:${sbg};color:${contrastColor(sbg)}">
        <div class="wt-title">${icon} ${escHtml(s.displayTitle)}</div>
        ${s.projName ? `<div class="wt-sub">${escHtml(s.projName)}</div>` : ''}
      </div>`;
    }).join('');
    const cards = stageCards + dayTasks.map(t => {
      const bg = taskColor(t);
      return `<div class="week-task-card ${t.status==='done'?'done':''}" data-id="${t.id}"
           draggable="true" style="background:${bg};color:${contrastColor(bg)}">
        <div class="wt-title">${escHtml(t.title)}</div>
        ${t.assigned_to ? `<div class="wt-who">→ ${escHtml(t.assigned_to)}</div>` : ''}
      </div>`;
    }).join('');

    const holiday = getDutchHolidays(date.getFullYear())[dateStr];
    html += `<div class="week-col${isWeekend?' weekend':''}${holiday?' holiday':''}">
      <div class="week-col-header ${isToday?'today-col':''}">
        <span class="wd">${DAYS[(date.getDay())]}</span>
        <span class="dd">${date.getDate()}</span>
        ${holiday ? `<span class="wk-holiday">${escHtml(holiday)}</span>` : ''}
      </div>
      <div class="week-tasks" data-date="${dateStr}">${cards}</div>
      <button class="week-add-btn" data-date="${dateStr}">+ Toevoegen</button>
    </div>`;
  });
  html += '</div>';
  content.innerHTML = html;

  let draggingTaskId = null;
  content.querySelectorAll('.week-task-card.cal-chip-stage').forEach(card => {
    card.onclick = () => {
      const stage = state.stages.find(s => s.id == card.dataset.stageId);
      if (stage) openStageModal(stage, stage.project_id);
    };
  });
  content.querySelectorAll('.week-task-card:not(.cal-chip-stage)').forEach(card => {
    card.onclick = () => {
      const task = state.tasks.find(t => t.id == card.dataset.id);
      if (task) openTaskModal(task);
    };
    card.addEventListener('dragstart', e => {
      draggingTaskId = card.dataset.id;
      calDragInProgress = true;
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      calDragInProgress = false;
      card.classList.remove('dragging');
      content.querySelectorAll('.week-tasks.drag-over').forEach(c => c.classList.remove('drag-over'));
    });
  });
  content.querySelectorAll('.week-tasks').forEach(col => {
    col.addEventListener('dragover', e => {
      if (!draggingTaskId) return;
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      if (!draggingTaskId) return;
      const newDate = col.dataset.date;
      const task = state.tasks.find(t => t.id == draggingTaskId);
      if (!task || task.date === newDate) return;
      const oldDate = task.date;
      pushUndo(`verplaats "${escHtml(task.title)}"`, async () => {
        await remoteQuery({ action: 'update', table: 'tasks', data: { date: oldDate }, where: { id: task.id } });
        await loadTasks(); renderWeekly();
      });
      await remoteQuery({ action: 'update', table: 'tasks', data: { date: newDate }, where: { id: Number(draggingTaskId) } });
      await loadTasks();
      renderWeekly();
    });
  });
  content.querySelectorAll('.week-add-btn').forEach(btn => {
    btn.onclick = () => openTaskModal(null, btn.dataset.date);
  });
}

/* ─── Daily View ───────────────────────────────────────────────────────────── */
function renderDaily() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');
  const dateStr = toDateStr(state.cursor);

  const dailyHoliday = getDutchHolidays(state.cursor.getFullYear())[dateStr];
  const dayName = state.cursor.toLocaleDateString('nl-NL', { weekday: 'long' });
  const dayDate = state.cursor.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  const dayTitleEl = document.getElementById('toolbar-title');
  dayTitleEl.className = 'cal-title';
  dayTitleEl.innerHTML = `<span class="cal-period-label">${dayName.charAt(0).toUpperCase() + dayName.slice(1)}</span><span class="cal-period-year">${dayDate}${dailyHoliday ? ` · ${escHtml(dailyHoliday)}` : ''}</span>`;

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="day-prev">‹</button>
      <button class="btn-icon" id="day-next">›</button>
      ${calViewToggleHTML('daily')}
      <button class="btn btn-primary btn-sm" id="day-add">+ Taak toevoegen</button>
    </div>`;
  wireCalViewToggle();
  renderCalFilterBar();

  document.getElementById('day-prev').onclick = () => {
    state.cursor = new Date(state.cursor); state.cursor.setDate(state.cursor.getDate()-1); renderDaily();
  };
  document.getElementById('day-next').onclick = () => {
    state.cursor = new Date(state.cursor); state.cursor.setDate(state.cursor.getDate()+1); renderDaily();
  };
  document.getElementById('day-add').onclick = () => openTaskModal(null, dateStr);

  const dayTasks = state.tasks
    .filter(t => t.date === dateStr && calTaskVisible(t))
    .sort((a, b) => {
      const aTime = (!a.all_day && a.task_time) ? a.task_time : '';
      const bTime = (!b.all_day && b.task_time) ? b.task_time : '';
      if (!aTime && !bTime) return 0;
      if (!aTime) return -1;   // all-day tasks first
      if (!bTime) return 1;
      return aTime.localeCompare(bTime);
    });

  const dayStages = stagesActiveOnDate(dateStr);

  let html = '<div id="daily-list">';
  dayStages.forEach(s => {
    const icon = s.stageEvent === 'end' || s.stageEvent === 'both' ? '🏁' : s.stageEvent === 'start' ? '▶' : '▬';
    const sub = s.stageEvent === 'start' ? 'Start' : s.stageEvent === 'end' ? 'Einde' : s.stageEvent === 'both' ? 'Start & einde' : 'Actief';
    html += `<div class="daily-stage-row" data-stage-id="${s.stage_id}" style="border-left:4px solid ${s.color || '#3ecf74'}">
      <div class="daily-stage-flag">${icon}</div>
      <div class="daily-stage-info">
        <div class="daily-stage-title">${escHtml(s.projName ? s.projName + ' · ' + s.displayTitle : s.displayTitle)}</div>
        <div class="daily-stage-sub">${sub}${s.start_date && s.end_date ? ` · ${s.start_date} → ${s.end_date}` : ''}</div>
      </div>
    </div>`;
  });
  if (dayTasks.length === 0 && dayStages.length === 0) {
    html += `<div class="empty"><div class="empty-icon">🗓️</div><p>Geen taken voor deze dag. Klik op "+ Taak toevoegen" om te beginnen.</p></div>`;
  } else {
    dayTasks.forEach(t => {
      const done    = t.status === 'done';
      const hasTime = !t.all_day && t.task_time;
      html += `<div class="daily-task-row" data-id="${t.id}">
        <div class="daily-time-col">${hasTime ? `<span class="daily-time">${t.task_time}</span>` : '<span class="daily-time daily-time-allday">Heel de dag</span>'}</div>
        <div class="priority-dot priority-${t.priority||'medium'}"></div>
        <input type="checkbox" class="status-cb" data-id="${t.id}" ${done?'checked':''} title="Markeer als afgerond" />
        <div class="daily-task-info">
          <div class="daily-task-title ${done?'done':''}">${escHtml(t.title)}</div>
          <div class="daily-task-meta">
            ${t.assigned_to?`<span>→ ${escHtml(t.assigned_to)}</span> · `:''}
            <span class="badge badge-${t.status==='in_progress'?'progress':t.status}">${fmtStatus(t.status)}</span>
            ${t.description ? ` · ${escHtml(t.description).slice(0,60)}${t.description.length>60?'…':''}` : ''}
          </div>
        </div>
        <div class="daily-task-actions">
          <button class="btn btn-sm btn-ghost edit-task-btn" data-id="${t.id}">Edit</button>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  content.innerHTML = html;

  // Stage row clicks
  content.querySelectorAll('.daily-stage-row').forEach(row => {
    row.style.cursor = 'pointer';
    row.onclick = () => {
      const stage = state.stages.find(s => s.id == row.dataset.stageId);
      if (stage) openStageModal(stage, stage.project_id);
    };
  });

  // Checkbox toggles
  content.querySelectorAll('.status-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      const task = state.tasks.find(t => t.id == cb.dataset.id);
      if (!task) return;
      const newStatus = cb.checked ? 'done' : 'pending';
      await saveTask({ ...task, status: newStatus });
      await loadTasks();
      renderDaily();
    });
  });
  content.querySelectorAll('.edit-task-btn').forEach(btn => {
    btn.onclick = () => {
      const task = state.tasks.find(t => t.id == btn.dataset.id);
      if (task) openTaskModal(task);
    };
  });
}

/* ─── Gantt View ───────────────────────────────────────────────────────────── */
function renderGantt() {
  if (state.ganttMode === 'day') renderGanttDay();
  else renderGanttWeek();
}

function ganttToolbarNav(label, prevFn, nextFn) {
  const ctrl = document.getElementById('toolbar-controls');
  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="gnt-prev">‹</button>
      <span>${label}</span>
      <button class="btn-icon" id="gnt-next">›</button>
      ${calViewToggleHTML('gantt')}
      <div class="gantt-mode-toggle">
        <button class="gmt-btn${state.ganttMode==='week'?' active':''}" id="gmt-week">Weken</button>
        <button class="gmt-btn${state.ganttMode==='day'?' active':''}" id="gmt-day">Dagen</button>
      </div>
      <button class="btn btn-sm${state.ganttHideInactive?' btn-primary':' btn-ghost'}" id="gnt-filter-btn">
        ${state.ganttHideInactive ? 'Toon alles' : 'Alleen actief'}
      </button>
      ${state.ganttMode === 'day' ? `<button class="btn btn-sm${state.ganttHideWeekends?' btn-primary':' btn-ghost'}" id="gnt-we-btn">
        ${state.ganttHideWeekends ? 'Toon weekends' : 'Geen weekends'}
      </button>` : ''}
      <div class="gantt-proj-filter-wrap" id="gantt-proj-filter-wrap">
        <button class="btn btn-sm btn-ghost" id="gnt-proj-pick-btn">
          Projecten${state.ganttHiddenProjects.size ? ` <span class="badge-count">${state.ganttHiddenProjects.size} verborgen</span>` : ' ▾'}
        </button>
        <div class="gantt-proj-panel hidden" id="gantt-proj-panel"></div>
      </div>
    </div>`;
  wireCalViewToggle();
  document.getElementById('gnt-prev').onclick = prevFn;
  document.getElementById('gnt-next').onclick = nextFn;
  document.getElementById('gmt-week').onclick = () => { state.ganttMode = 'week'; renderGantt(); };
  document.getElementById('gmt-day').onclick  = () => { state.ganttMode = 'day';  renderGantt(); };
  document.getElementById('gnt-filter-btn').onclick = () => { state.ganttHideInactive = !state.ganttHideInactive; renderGantt(); };
  document.getElementById('gnt-we-btn')?.addEventListener('click', () => { state.ganttHideWeekends = !state.ganttHideWeekends; renderGantt(); });

  // Project pick panel
  const pickBtn = document.getElementById('gnt-proj-pick-btn');
  const panel   = document.getElementById('gantt-proj-panel');
  pickBtn.onclick = (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) renderGanttProjPanel(panel);
  };
  document.addEventListener('click', function closeProjPanel(e) {
    if (!document.getElementById('gantt-proj-filter-wrap')?.contains(e.target)) {
      panel.classList.add('hidden');
      document.removeEventListener('click', closeProjPanel);
    }
  });

  renderCalFilterBar();
}

function renderGanttProjPanel(panel) {
  // Only projects that are active AND overlap the current visible range
  const candidates = state.projects.filter(p =>
    p.status === 'active' &&
    p.start_date && p.end_date &&
    (!_ganttRangeStart || p.end_date   >= _ganttRangeStart) &&
    (!_ganttRangeEnd   || p.start_date <= _ganttRangeEnd)
  );
  const hiddenCount = state.ganttHiddenProjects.size;
  panel.innerHTML = `
    <div class="gpf-header">
      <span>Projecten tonen</span>
      ${hiddenCount ? `<button class="gpf-reset" id="gpf-reset">Alles tonen</button>` : ''}
    </div>
    ${candidates.length === 0
      ? `<div style="padding:8px 12px;font-size:11px;color:var(--text2)">Geen actieve projecten in dit bereik</div>`
      : candidates.map(p => `
      <label class="gpf-row">
        <input type="checkbox" class="gpf-cb" data-id="${p.id}" ${state.ganttHiddenProjects.has(p.id) ? '' : 'checked'}>
        <span style="display:block;min-width:8px;max-width:8px;min-height:8px;max-height:8px;border-radius:50%;background:${p.color||'#4f8ef7'}"></span>
        <span class="gpf-name">${escHtml(p.name)}</span>
      </label>`).join('')}
  `;
  panel.querySelectorAll('.gpf-cb').forEach(cb => {
    cb.onchange = () => {
      const id = parseInt(cb.dataset.id);
      if (cb.checked) state.ganttHiddenProjects.delete(id);
      else            state.ganttHiddenProjects.add(id);
      saveGanttHidden();
      renderGantt();
      // renderGantt() rebuilds the toolbar and adds 'hidden' to the new panel —
      // re-open and repopulate it so the menu stays visible
      const p2 = document.getElementById('gantt-proj-panel');
      if (p2) { p2.classList.remove('hidden'); renderGanttProjPanel(p2); }
    };
  });
  document.getElementById('gpf-reset')?.addEventListener('click', () => {
    state.ganttHiddenProjects.clear();
    saveGanttHidden();
    renderGantt();
    const p2 = document.getElementById('gantt-proj-panel');
    if (p2) { p2.classList.remove('hidden'); renderGanttProjPanel(p2); }
  });
}

/* ─── Gantt Week View (Projects, multi-week overview) ──────────────────────── */
function renderGanttWeek() {
  const N_WEEKS  = 12;   // columns visible at once
  const NAV_STEP = 4;    // weeks to jump per prev/next click
  const content  = document.getElementById('content');
  // Clear workday globals (only used in day-view no-weekends mode)
  ganttWorkdays = null;
  ganttDayOffFn = null;

  // Anchor = Monday of cursor's week
  const d   = new Date(state.cursor);
  const dow = d.getDay();
  const anchor = new Date(d);
  anchor.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));

  // Build array of N_WEEKS week-objects
  const weeks = Array.from({ length: N_WEEKS }, (_, i) => {
    const mon = new Date(anchor);
    mon.setDate(anchor.getDate() + i * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { mon, sun, start: toDateStr(mon), end: toDateStr(sun) };
  });

  const rangeStart = weeks[0].start;
  const rangeEnd   = weeks[N_WEEKS - 1].end;
  const totalDays  = N_WEEKS * 7;
  const todayStr   = toDateStr(state.today);
  _ganttRangeStart = rangeStart;
  _ganttRangeEnd   = rangeEnd;

  const fmt = (date) => `${date.getDate()} ${MONTHS[date.getMonth()].slice(0,3)}`;
  const rangeLabel = `${fmt(weeks[0].mon)} – ${fmt(weeks[N_WEEKS-1].sun)} ${weeks[N_WEEKS-1].sun.getFullYear()}`;

  ganttToolbarNav(
    rangeLabel,
    () => { state.cursor = new Date(anchor); state.cursor.setDate(anchor.getDate() - NAV_STEP * 7); renderGantt(); },
    () => { state.cursor = new Date(anchor); state.cursor.setDate(anchor.getDate() + NAV_STEP * 7); renderGantt(); }
  );

  // Only show projects with explicit start AND end date
  function projectEffectiveDates(p) {
    if (!p.start_date || !p.end_date) return null;
    if (p.start_date > rangeEnd || p.end_date < rangeStart) return null;
    return { effectiveStart: p.start_date, effectiveEnd: p.end_date };
  }

  const visibleProjects = state.projects
    .filter(p => (!state.ganttHideInactive || p.status === 'active') && !state.ganttHiddenProjects.has(p.id))
    .map(p => { const dates = projectEffectiveDates(p); return dates ? { ...p, ...dates } : null; })
    .filter(Boolean);

  if (visibleProjects.length === 0) {
    content.innerHTML = `<div id="gantt-wrap"><div class="empty"><div class="empty-icon">📁</div><p>Geen projecten in dit bereik. Maak een project aan via <strong>Projecten</strong> en stel start/einddatum in.</p></div></div>`;
    wireGanttInteractions(rangeStart, totalDays);
    return;
  }

  // Week column headers
  const headerCells = weeks.map(w => {
    const isCurrent = todayStr >= w.start && todayStr <= w.end;
    const mon = w.mon;
    // Show month name when it's the first week of a month
    const showMonth = mon.getDate() <= 7;
    return `<div class="gnt-day-h gnt-week-h${isCurrent?' today-h':''}">
      ${showMonth ? `<span class="gnt-wk-month">${MONTHS[mon.getMonth()].slice(0,3)}</span>` : ''}
      <span class="gnt-wk-date">${mon.getDate()}</span>
    </div>`;
  }).join('');

  // Background cells (one per week)
  const bgCells = weeks.map(w => {
    const isCurrent = todayStr >= w.start && todayStr <= w.end;
    return `<div class="gnt-day-cell${isCurrent?' today-cell':''}"></div>`;
  }).join('');

  // Today vertical line (day-precision within the 12-week range)
  const todayOffDays = _dayOffset(rangeStart, todayStr);
  const todayLine = (todayOffDays >= 0 && todayOffDays < totalDays)
    ? `<div class="gnt-today-line" style="left:${((todayOffDays + 0.5) / totalDays * 100).toFixed(2)}%"></div>`
    : '';

  const rowsHtml = visibleProjects.map(p => {
    const clampStart = p.effectiveStart < rangeStart ? rangeStart : p.effectiveStart;
    const clampEnd   = p.effectiveEnd   > rangeEnd   ? rangeEnd   : p.effectiveEnd;
    const startOff   = _dayOffset(rangeStart, clampStart);
    const endOff     = _dayOffset(rangeStart, clampEnd);
    const leftPct    = (startOff / totalDays * 100).toFixed(2);
    const widthPct   = ((endOff - startOff + 1) / totalDays * 100).toFixed(2);
    const done       = p.status === 'done';
    const taskCount  = state.tasks.filter(t => t.project_id == p.id).length;
    const doneCount  = state.tasks.filter(t => t.project_id == p.id && t.status === 'done').length;
    const pct        = taskCount ? Math.round(doneCount / taskCount * 100) : 0;
    const isExpanded = state.expandedProjects.has(p.id);
    const projStages = state.stages
      .filter(s => s.project_id == p.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

    // Stage rows (only when expanded) — one row per stage, with N bars per slot
    const stageRows = isExpanded ? _ganttStageRows(projStages, p, bgCells, todayLine, rangeStart, rangeEnd, totalDays) : '';

    const addStageRow = isExpanded ? `<div class="gnt-row gnt-add-stage-row" data-proj-id="${p.id}" style="cursor:pointer">
      <div class="gnt-lbl gnt-stage-lbl" style="border-left:3px solid transparent;opacity:.5">
        <div class="gnt-lbl-text"><span class="gnt-stage-name">+ Fase</span></div>
      </div>
      <div class="gnt-timeline">${bgCells}</div>
    </div>` : '';

    return `<div class="gnt-row gnt-proj-row" data-proj-id="${p.id}" style="border-left-color:${p.color||'#4f8ef7'};box-shadow:inset 3px 0 0 ${p.color||'#4f8ef7'}">
      <div class="gnt-lbl">
        <button class="gnt-toggle${isExpanded?' expanded':''}" data-proj-id="${p.id}"
                title="${isExpanded?'Inklappen':'Uitklappen'}">${isExpanded?'▼':'▶'}</button>
        <div class="gnt-lbl-text">
          <div class="gnt-task-name${done?' done':''}">${escHtml(p.name)}</div>
          <div class="gnt-task-who">${doneCount}/${taskCount} taken · ${pct}%</div>
        </div>
      </div>
      <div class="gnt-timeline">
        ${bgCells}
        ${todayLine}
        <div class="gnt-bar${done?' done':''}" data-proj-id="${p.id}"
             data-start="${p.effectiveStart}" data-end="${p.effectiveEnd}"
             style="left:${leftPct}%;width:${widthPct}%;background:${p.color||'#4f8ef7'}"
             title="${escHtml(p.name)}">
          <div class="gnt-bar-hl"></div>
          <span class="gnt-bar-label">${escHtml(p.name)}</span>
          <div class="gnt-bar-hr"></div>
        </div>
      </div>
    </div>${stageRows}${addStageRow}`;
  }).join('');

  content.innerHTML = `
    <div id="gantt-wrap">
      <div class="gnt-head">
        <div class="gnt-lbl-h"></div>
        <div class="gnt-timeline-h">${headerCells}</div>
      </div>
      ${rowsHtml}
    </div>`;

  content.querySelectorAll('.gnt-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const projId = Number(btn.dataset.projId);
      if (state.expandedProjects.has(projId)) state.expandedProjects.delete(projId);
      else state.expandedProjects.add(projId);
      renderGanttWeek();
    });
  });

  content.querySelectorAll('.gnt-stage-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (ganttJustDragged) return;
      const barEl = e.target.closest('.gnt-bar');
      const stageId = barEl ? barEl.dataset.stageId : row.dataset.stageId;
      const stage = state.stages.find(s => s.id == stageId);
      if (stage) openStageModal(stage, Number(row.dataset.projId), _ganttDateFromClick(e, rangeStart, totalDays));
    });
  });

  content.querySelectorAll('.gnt-bar[data-proj-id]:not(.gnt-stage-bar), .gnt-proj-row').forEach(el => {
    el.addEventListener('click', e => {
      if (ganttJustDragged) return;
      if (e.target.closest('.gnt-toggle')) return;
      if (el.classList.contains('gnt-bar')) e.stopPropagation();
      const proj = state.projects.find(p => p.id == (el.dataset.projId || el.closest('[data-proj-id]')?.dataset.projId));
      if (proj) openProjectModal(proj);
    });
  });

  content.querySelectorAll('.gnt-add-stage-row').forEach(row => {
    row.addEventListener('click', () => {
      openStageModal(null, Number(row.dataset.projId));
    });
  });

  wireGanttInteractions(rangeStart, totalDays);
}

/* ─── Gantt Interactions (scroll + drag-to-move/resize) ─────────────────── */
function _ganttStageRows(projStages, p, bgCells, todayLine, rangeStart, rangeEnd, totalDays, dayOffFn) {
  dayOffFn = dayOffFn || (d => _dayOffset(rangeStart, d));
  // Pre-compute task counts per stage
  const tasksByStage = {};
  state.tasks.forEach(t => {
    if (t.stage_id == null) return;
    if (!tasksByStage[t.stage_id]) tasksByStage[t.stage_id] = { total: 0, open: 0 };
    tasksByStage[t.stage_id].total++;
    if (t.status !== 'done') tasksByStage[t.stage_id].open++;
  });

  // Group slots by stage_id for fast lookup
  const slotsByStage = {};
  state.stageSlots.forEach(slot => {
    (slotsByStage[slot.stage_id] ||= []).push(slot);
  });

  return projStages.map(s => {
    const color = s.color || p.color || '#4f8ef7';
    const slots = (slotsByStage[s.id] || []).slice().sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
    const counts = tasksByStage[s.id] || { total: 0, open: 0 };
    const taskCount = counts.total;
    const openCount = counts.open;

    const bars = slots.map(slot => {
      const hasBar = slot.start_date && slot.end_date && slot.start_date <= rangeEnd && slot.end_date >= rangeStart;
      if (!hasBar) return '';
      const sCs = slot.start_date < rangeStart ? rangeStart : slot.start_date;
      const sCe = slot.end_date   > rangeEnd   ? rangeEnd   : slot.end_date;
      const sLeft  = (dayOffFn(sCs) / totalDays * 100).toFixed(2);
      const sWidth = ((dayOffFn(sCe) - dayOffFn(sCs) + 1) / totalDays * 100).toFixed(2);
      const titleParts = [escHtml(s.name)];
      if (s.notes) titleParts.push(escHtml(s.notes));
      if (taskCount > 0) titleParts.push(`${openCount}/${taskCount} taken`);
      const title = titleParts.join(' — ');
      return `<div class="gnt-bar gnt-stage-bar"
        data-slot-id="${slot.id}" data-stage-id="${s.id}" data-proj-id="${p.id}"
        data-start="${slot.start_date}" data-end="${slot.end_date}"
        style="left:${sLeft}%;width:${sWidth}%;background:${color}"
        title="${title}">
        <div class="gnt-bar-hl"></div>
        ${taskCount > 0 ? `<span class="gnt-bar-task-count">${openCount}/${taskCount}</span>` : (s.notes ? `<span class="gnt-bar-notes-dot">●</span>` : '')}
        <div class="gnt-bar-hr"></div>
      </div>`;
    }).join('');
    return `<div class="gnt-row gnt-stage-row"
      data-stage-id="${s.id}"
      data-proj-id="${p.id}"
      style="cursor:pointer">
      <div class="gnt-lbl gnt-stage-lbl" style="border-left:3px solid ${color}">
        <div class="gnt-stage-dot" style="background:${color}"></div>
        <div class="gnt-lbl-text">
          <span class="gnt-stage-name">${escHtml(s.name)}</span>
        </div>
      </div>
      <div class="gnt-timeline">${bgCells}${todayLine}${bars}</div>
    </div>`;
  }).join('');
}

function _ganttDateFromClick(e, rangeStart, totalDays, daysArray) {
  const timeline = e.target.closest('.gnt-timeline');
  if (!timeline) return null;
  const rect = timeline.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (daysArray) {
    const idx = Math.max(0, Math.min(daysArray.length - 1, Math.floor(pct * daysArray.length)));
    return toDateStr(daysArray[idx]);
  }
  const d = new Date(rangeStart + 'T00:00:00');
  d.setDate(d.getDate() + Math.floor(pct * totalDays));
  return toDateStr(d);
}

function _ganttAddDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function _onGanttDragMove(e) {
  if (ganttDraw) {
    const { rect, startDayOffset, ghostEl, totalDays, rangeStart } = ganttDraw;
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const endDayOffset = Math.max(startDayOffset, Math.floor(pct * totalDays));
    ganttDraw.endDate = ganttWorkdays
      ? toDateStr(ganttWorkdays[Math.min(ganttWorkdays.length - 1, endDayOffset)])
      : _ganttAddDays(rangeStart, endDayOffset);
    ghostEl.style.left  = (startDayOffset / totalDays * 100).toFixed(2) + '%';
    ghostEl.style.width = ((endDayOffset - startDayOffset + 1) / totalDays * 100).toFixed(2) + '%';
    return;
  }
  if (!ganttDrag) return;
  const { type, barEl, origStart, origEnd, startX, timelineWidth, totalDays, rangeStart } = ganttDrag;
  const pxPerDay = timelineWidth / totalDays;
  const rawDelta = Math.round((e.clientX - startX) / pxPerDay);
  if (rawDelta === ganttDrag.lastDelta) return;
  ganttDrag.lastDelta = rawDelta;

  // Workday-aware add: moves rawDelta working days, skipping weekends
  function wdAdd(d, n) {
    if (!ganttWorkdays || n === 0) return _ganttAddDays(d, n);
    let idx = ganttWorkdays.findIndex(wd => toDateStr(wd) === d);
    if (idx < 0) {
      let best = 0, bestDist = Infinity;
      const ts = new Date(d + 'T00:00:00').getTime();
      ganttWorkdays.forEach((wd, i) => { const dist = Math.abs(wd.getTime() - ts); if (dist < bestDist) { bestDist = dist; best = i; } });
      idx = best;
    }
    return toDateStr(ganttWorkdays[Math.max(0, Math.min(ganttWorkdays.length - 1, idx + n))]);
  }

  let newStart = origStart, newEnd = origEnd;
  if (type === 'move') {
    newStart = wdAdd(origStart, rawDelta);
    newEnd   = wdAdd(origEnd,   rawDelta);
  } else if (type === 'resize-l') {
    newStart = wdAdd(origStart, rawDelta);
    if (newStart >= origEnd) newStart = wdAdd(origEnd, -1);
  } else if (type === 'resize-r') {
    newEnd = wdAdd(origEnd, rawDelta);
    if (newEnd <= origStart) newEnd = wdAdd(origStart, 1);
  }

  // Live-update bar position in DOM (no DB write yet)
  let startOff, endOff;
  if (ganttDayOffFn) {
    startOff = ganttDayOffFn(newStart);
    endOff   = ganttDayOffFn(newEnd);
  } else {
    const rangeStartMs = new Date(rangeStart + 'T00:00:00').getTime();
    startOff = Math.round((new Date(newStart + 'T00:00:00') - rangeStartMs) / 86400000);
    endOff   = Math.round((new Date(newEnd   + 'T00:00:00') - rangeStartMs) / 86400000);
  }
  barEl.style.left  = (startOff / totalDays * 100).toFixed(2) + '%';
  barEl.style.width = ((endOff - startOff + 1) / totalDays * 100).toFixed(2) + '%';
  ganttDrag.pendingStart = newStart;
  ganttDrag.pendingEnd   = newEnd;
}

async function _onGanttDragEnd() {
  if (ganttDraw) {
    const d = ganttDraw;
    ganttDraw = null;
    document.body.style.userSelect = '';
    d.ghostEl.remove();
    if (d.stageId) {
      ganttJustDragged = true;
      setTimeout(() => { ganttJustDragged = false; }, 300);
      // Add a new time slot for the existing stage
      const existingSlots = state.stageSlots.filter(x => x.stage_id == d.stageId);
      await remoteQuery({ action: 'insert', table: 'stage_slots', data: {
        stage_id:   d.stageId,
        start_date: d.startDate,
        end_date:   d.endDate || d.startDate,
        sort_order: existingSlots.length,
      }});
      await loadStages();
      renderGantt();
      toast(`'${d.stageName}' tijdslot toegevoegd`);
    }
    return;
  }
  if (!ganttDrag) return;
  const d = ganttDrag;
  ganttDrag = null;
  document.body.style.userSelect = '';
  d.barEl.style.cursor = '';

  if (!d.pendingStart || d.lastDelta === 0) return;

  // Block the click event that fires right after mouseup
  ganttJustDragged = true;
  setTimeout(() => { ganttJustDragged = false; }, 300);

  if (d.slotId) {
    await remoteQuery({ action: 'update', table: 'stage_slots',
      data: { start_date: d.pendingStart, end_date: d.pendingEnd }, where: { id: d.slotId } });
    const slot = state.stageSlots.find(x => x.id == d.slotId);
    if (slot) { slot.start_date = d.pendingStart; slot.end_date = d.pendingEnd; }
  } else if (d.projId) {
    await remoteQuery({ action: 'update', table: 'projects',
      data: { start_date: d.pendingStart, end_date: d.pendingEnd }, where: { id: d.projId } });
    const p = state.projects.find(x => x.id == d.projId);
    if (p) { p.start_date = d.pendingStart; p.end_date = d.pendingEnd; }
  }
  renderGantt();
}

function wireGanttInteractions(rangeStart, totalDays) {
  const wrap = document.getElementById('gantt-wrap');
  const content = document.getElementById('content');

  // Clean up previous wheel listener before attaching a new one
  if (ganttWheelController) ganttWheelController.abort();
  ganttWheelController = new AbortController();

  // Attach wheel to full content area so it works even when cursor is below the gantt rows
  let wheelAccum = 0;
  content.addEventListener('wheel', e => {
    const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const isShift = e.shiftKey;
    if (!isHorizontal && !isShift) return; // let vertical scroll through naturally
    e.preventDefault();
    const delta = isHorizontal ? e.deltaX : e.deltaY;
    wheelAccum += delta;
    const threshold = state.ganttMode === 'day' ? 60 : 120;
    if (Math.abs(wheelAccum) < threshold) return;
    const dir = wheelAccum > 0 ? 1 : -1;
    wheelAccum = 0;
    const step = state.ganttMode === 'day' ? 1 : 7;
    state.cursor.setDate(state.cursor.getDate() + dir * step);
    renderGantt();
  }, { passive: false, signal: ganttWheelController.signal });

  if (!wrap) return;

  // Mousedown on bar → move or resize; on empty stage row timeline → draw new bar
  wrap.addEventListener('mousedown', e => {
    if (e.target.closest('.gnt-toggle')) return;
    const barEl = e.target.closest('.gnt-bar');

    // Draw new bar: mousedown on stage row timeline but NOT on a bar
    if (!barEl) {
      const stageRow = e.target.closest('.gnt-stage-row');
      const timeline  = e.target.closest('.gnt-timeline');
      if (stageRow && timeline) {
        e.preventDefault();
        const rect = timeline.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const startDayOffset = Math.floor(pct * totalDays);
        const startDate = ganttWorkdays
          ? toDateStr(ganttWorkdays[Math.max(0, Math.min(ganttWorkdays.length - 1, startDayOffset))])
          : _ganttAddDays(rangeStart, startDayOffset);
        const refStage  = state.stages.find(s => s.id == stageRow.dataset.stageId);
        const color = refStage?.color || '#4f8ef7';
        const ghost = document.createElement('div');
        ghost.className = 'gnt-draw-ghost';
        ghost.style.cssText = `left:${(startDayOffset/totalDays*100).toFixed(2)}%;width:${(1/totalDays*100).toFixed(2)}%;background:${color}`;
        timeline.appendChild(ghost);
        ganttDraw = { rect, startDayOffset, startDate, endDate: startDate, ghostEl: ghost,
          stageName: refStage?.name || '', stageColor: color, stageId: refStage?.id || null,
          projId: Number(stageRow.dataset.projId), rangeStart, totalDays };
        document.body.style.userSelect = 'none';
      }
      return;
    }

    if (!barEl) return;

    e.preventDefault();
    e.stopPropagation();

    const handle = e.target.closest('.gnt-bar-hl, .gnt-bar-hr');
    const type   = handle
      ? (handle.classList.contains('gnt-bar-hl') ? 'resize-l' : 'resize-r')
      : 'move';

    const timeline = barEl.closest('.gnt-timeline');
    ganttDrag = {
      type,
      barEl,
      projId:       barEl.dataset.projId  ? Number(barEl.dataset.projId)  : null,
      stageId:      barEl.dataset.stageId ? Number(barEl.dataset.stageId) : null,
      slotId:       barEl.dataset.slotId  ? Number(barEl.dataset.slotId)  : null,
      origStart:    barEl.dataset.start,
      origEnd:      barEl.dataset.end,
      startX:       e.clientX,
      timelineWidth: timeline ? timeline.offsetWidth : 800,
      totalDays,
      rangeStart,
      lastDelta:    0,
      pendingStart: null,
      pendingEnd:   null,
    };

    document.body.style.userSelect = 'none';
    barEl.style.cursor = type === 'move' ? 'grabbing' : 'ew-resize';
  });
}

/* ─── Gantt Day View (30-day, day-level precision) ─────────────────────────── */
function renderGanttDay() {
  const N_DAYS    = 30;
  const NAV_STEP  = 7;
  const content   = document.getElementById('content');
  const todayStr  = toDateStr(state.today);

  // Anchor = cursor date
  const anchor = new Date(state.cursor);
  anchor.setHours(0, 0, 0, 0);
  const hideWE = state.ganttHideWeekends;

  // Generate days: 30 calendar days, or 22 working days (Mon–Fri) when hiding weekends
  const days = [];
  { let cur = new Date(anchor);
    const target = hideWE ? 22 : N_DAYS;
    while (days.length < target) {
      const dow = cur.getDay();
      if (!hideWE || (dow !== 0 && dow !== 6)) days.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
  }

  const rangeStart = toDateStr(days[0]);
  const rangeEnd   = toDateStr(days[days.length - 1]);
  const totalDays  = days.length;

  // Day-offset: index of dateStr in days[], nearest match for weekend / out-of-range dates
  function dayOff(dateStr) {
    let best = 0, bestDist = Infinity;
    const ts = new Date(dateStr + 'T00:00:00').getTime();
    for (let i = 0; i < days.length; i++) {
      const dist = Math.abs(days[i].getTime() - ts);
      if (dist === 0) return i;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }
  ganttDayOffFn = hideWE ? dayOff : null;
  ganttWorkdays  = hideWE ? days  : null;

  const fmt = d => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  const lastDay = days[days.length - 1];
  const rangeLabel = `${fmt(days[0])} – ${fmt(lastDay)} ${lastDay.getFullYear()}`;
  _ganttRangeStart = rangeStart;
  _ganttRangeEnd   = rangeEnd;

  ganttToolbarNav(
    rangeLabel,
    () => { state.cursor = new Date(anchor); state.cursor.setDate(anchor.getDate() - NAV_STEP); renderGantt(); },
    () => { state.cursor = new Date(anchor); state.cursor.setDate(anchor.getDate() + NAV_STEP); renderGantt(); }
  );

  const NL_DAYS_SHORT = ['zo','ma','di','wo','do','vr','za'];

  // Day column headers
  const headerCells = days.map((d, i) => {
    const ds = toDateStr(d);
    const isToday = ds === todayStr;
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isWeekStart = hideWE && dow === 1 && i > 0; // Monday gap (skip first col)
    return `<div class="gnt-day-h${isToday?' today-h':''}${isWeekend?' weekend-h':''}${isWeekStart?' week-start':''}">
      <span class="gnt-dh-dow">${NL_DAYS_SHORT[dow]}</span>
      <span class="gnt-dh-num">${d.getDate()}</span>
    </div>`;
  }).join('');

  // Background cells
  const bgCells = days.map((d, i) => {
    const ds = toDateStr(d);
    const isToday = ds === todayStr;
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isWeekStart = hideWE && dow === 1 && i > 0;
    return `<div class="gnt-day-cell${isWeekend?' weekend-cell':''}${isToday?' today-cell':''}${isWeekStart?' week-start':''}"></div>`;
  }).join('');

  // Today line
  const todayInRange  = todayStr >= rangeStart && todayStr <= rangeEnd;
  const todayOffDays  = todayInRange ? (hideWE ? dayOff(todayStr) : _dayOffset(rangeStart, todayStr)) : -1;
  const todayLine = todayOffDays >= 0
    ? `<div class="gnt-today-line" style="left:${((todayOffDays + 0.5) / totalDays * 100).toFixed(2)}%"></div>`
    : '';

  // Visible projects (any overlap with range)
  const visibleProjects = state.projects
    .filter(p => (!state.ganttHideInactive || p.status === 'active') && !state.ganttHiddenProjects.has(p.id) && p.start_date && p.end_date && p.start_date <= rangeEnd && p.end_date >= rangeStart);

  if (visibleProjects.length === 0) {
    content.innerHTML = `<div id="gantt-wrap"><div class="empty"><div class="empty-icon">📁</div><p>Geen projecten in dit bereik. Maak een project aan via <strong>Projecten</strong> en stel start/einddatum in.</p></div></div>`;
    wireGanttInteractions(rangeStart, totalDays);
    return;
  }

  const rowsHtml = visibleProjects.map(p => {
    const clampStart = p.start_date < rangeStart ? rangeStart : p.start_date;
    const clampEnd   = p.end_date   > rangeEnd   ? rangeEnd   : p.end_date;
    const startOff   = hideWE ? dayOff(clampStart) : _dayOffset(rangeStart, clampStart);
    const endOff     = hideWE ? dayOff(clampEnd)   : _dayOffset(rangeStart, clampEnd);
    const leftPct    = (startOff / totalDays * 100).toFixed(2);
    const widthPct   = ((endOff - startOff + 1) / totalDays * 100).toFixed(2);
    const done       = p.status === 'done';
    const taskCount  = state.tasks.filter(t => t.project_id == p.id).length;
    const doneCount  = state.tasks.filter(t => t.project_id == p.id && t.status === 'done').length;
    const pct        = taskCount ? Math.round(doneCount / taskCount * 100) : 0;
    const isExpanded = state.expandedProjects.has(p.id);

    const projStages = state.stages
      .filter(s => s.project_id == p.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

    // Stage rows (only when expanded) — one row per stage, with N bars per slot
    const stageRows = isExpanded ? _ganttStageRows(projStages, p, bgCells, todayLine, rangeStart, rangeEnd, totalDays, hideWE ? dayOff : null) : '';

    const addStageRow = isExpanded ? `<div class="gnt-row gnt-add-stage-row" data-proj-id="${p.id}" style="cursor:pointer">
      <div class="gnt-lbl gnt-stage-lbl" style="border-left:3px solid transparent;opacity:.5">
        <div class="gnt-lbl-text"><span class="gnt-stage-name">+ Fase</span></div>
      </div>
      <div class="gnt-timeline">${bgCells}</div>
    </div>` : '';

    return `<div class="gnt-row gnt-proj-row" data-proj-id="${p.id}" style="border-left-color:${p.color||'#4f8ef7'};box-shadow:inset 3px 0 0 ${p.color||'#4f8ef7'}">
      <div class="gnt-lbl">
        <button class="gnt-toggle${isExpanded?' expanded':''}" data-proj-id="${p.id}"
                title="${isExpanded?'Inklappen':'Uitklappen'}">${isExpanded?'▼':'▶'}</button>
        <div class="gnt-lbl-text">
          <div class="gnt-task-name${done?' done':''}">${escHtml(p.name)}</div>
          <div class="gnt-task-who">${doneCount}/${taskCount} taken · ${pct}%</div>
        </div>
      </div>
      <div class="gnt-timeline">
        ${bgCells}${todayLine}
        <div class="gnt-bar${done?' done':''}" data-proj-id="${p.id}"
             data-start="${p.start_date}" data-end="${p.end_date}"
             style="left:${leftPct}%;width:${widthPct}%;background:${p.color||'#4f8ef7'}"
             title="${escHtml(p.name)}">
          <div class="gnt-bar-hl"></div>
          <span class="gnt-bar-label">${escHtml(p.name)}</span>
          <div class="gnt-bar-hr"></div>
        </div>
      </div>
    </div>${stageRows}${addStageRow}`;
  }).join('');

  content.innerHTML = `
    <div id="gantt-wrap">
      <div class="gnt-head">
        <div class="gnt-lbl-h"></div>
        <div class="gnt-timeline-h">${headerCells}</div>
      </div>
      ${rowsHtml}
    </div>`;

  content.querySelectorAll('.gnt-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const projId = Number(btn.dataset.projId);
      if (state.expandedProjects.has(projId)) state.expandedProjects.delete(projId);
      else state.expandedProjects.add(projId);
      renderGanttDay();
    });
  });

  content.querySelectorAll('.gnt-stage-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (ganttJustDragged) return;
      const barEl = e.target.closest('.gnt-bar');
      const stageId = barEl ? barEl.dataset.stageId : row.dataset.stageId;
      const stage = state.stages.find(s => s.id == stageId);
      if (stage) openStageModal(stage, Number(row.dataset.projId), _ganttDateFromClick(e, rangeStart, totalDays, hideWE ? days : null));
    });
  });

  content.querySelectorAll('.gnt-bar[data-proj-id]:not(.gnt-stage-bar), .gnt-proj-row').forEach(el => {
    el.addEventListener('click', e => {
      if (ganttJustDragged) return;
      if (e.target.closest('.gnt-toggle')) return;
      if (el.classList.contains('gnt-bar')) e.stopPropagation();
      const proj = state.projects.find(p => p.id == (el.dataset.projId || el.closest('[data-proj-id]')?.dataset.projId));
      if (proj) openProjectModal(proj);
    });
  });

  content.querySelectorAll('.gnt-add-stage-row').forEach(row => {
    row.addEventListener('click', () => {
      openStageModal(null, Number(row.dataset.projId));
    });
  });

  wireGanttInteractions(rangeStart, totalDays);
}

/* ─── Projects View ────────────────────────────────────────────────────────── */
function renderProjectsView() {
  const content = document.getElementById('content');
  const ctrl    = document.getElementById('toolbar-controls');

  ctrl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-proj-btn">+ Nieuw project</button>`;
  document.getElementById('new-proj-btn').onclick = () => openProjectModal(null);

  const filters = [
    ['all', 'Alle'], ['active', 'Actief'], ['on_hold', 'In de wacht'], ['done', 'Afgerond'],
  ];
  const sortLabel = field => {
    const active = state.projectsSort.field === field;
    const arrow = active ? (state.projectsSort.dir === 'asc' ? '↑' : '↓') : '↕';
    return `${field === 'name' ? 'Naam' : 'Datum'} ${arrow}`;
  };
  const escapedSearch = escHtml(state.projectsSearch);
  content.innerHTML = `<div class="proj-browser">
    <div class="proj-browser-top">
      <label class="proj-search-wrap" for="proj-search">
        <span>⌕</span><input id="proj-search" type="search" value="${escapedSearch}" placeholder="Zoek project, klant of omschrijving…" autocomplete="off" />
      </label>
      <div class="proj-sort-actions">
        <button class="proj-sort-btn${state.projectsSort.field === 'name' ? ' active' : ''}" data-proj-sort="name">${sortLabel('name')}</button>
        <button class="proj-sort-btn${state.projectsSort.field === 'date' ? ' active' : ''}" data-proj-sort="date">${sortLabel('date')}</button>
      </div>
    </div>
    <div class="proj-filter-chips">
      ${filters.map(([key, label]) => `<button class="proj-filter-chip${state.projectsFilter === key ? ' active' : ''}" data-proj-status-filter="${key}">${label}</button>`).join('')}
    </div>
    <div id="proj-results"></div>
  </div>`;

  const renderResults = () => {
    const needle = state.projectsSearch.trim().toLowerCase();
    const visibleProjects = state.projects
      .filter(p => state.projectsFilter === 'all' || p.status === state.projectsFilter)
      .filter(p => !needle || [p.name, p.client, p.description].some(value => String(value || '').toLowerCase().includes(needle)))
      .sort((a, b) => {
        let result;
        if (state.projectsSort.field === 'name') {
          result = (a.name || '').localeCompare(b.name || '', 'nl');
        } else {
          // Projects without a start date go below dated projects in both directions.
          if (!a.start_date && !b.start_date) result = 0;
          else if (!a.start_date) result = 1;
          else if (!b.start_date) result = -1;
          else result = a.start_date.localeCompare(b.start_date);
        }
        return state.projectsSort.dir === 'asc' ? result : -result;
      });

    const results = document.getElementById('proj-results');
    if (visibleProjects.length === 0) {
      results.innerHTML = `<div class="empty"><div class="empty-icon">📁</div><p>${state.projects.length ? 'Geen projecten gevonden met deze filter.' : 'Nog geen projecten. Maak een project aan om te beginnen.'}</p></div>`;
      return;
    }

    const html = `<div class="proj-result-count">${visibleProjects.length} ${visibleProjects.length === 1 ? 'project' : 'projecten'}</div><div class="proj-grid">` +
      visibleProjects.map(p => {
      const taskCount = state.tasks.filter(t => t.project_id == p.id).length;
      const doneCount = state.tasks.filter(t => t.project_id == p.id && t.status === 'done').length;
      const pct = taskCount ? Math.round(doneCount / taskCount * 100) : 0;
      const dateRange = (p.start_date && p.end_date)
        ? `${p.start_date} → ${p.end_date}`
        : p.start_date ? `vanaf ${p.start_date}` : '';
      return `<div class="proj-card" data-proj-id="${p.id}">
        <div class="proj-card-bar" style="background:${p.color||'#4f8ef7'}"></div>
        <div class="proj-card-body">
          <div class="proj-card-header">
            <div class="proj-card-name">${escHtml(p.name)}</div>
            <span class="badge badge-proj-${p.status}">${fmtProjStatus(p.status)}</span>
          </div>
          ${p.description ? `<div class="proj-card-desc">${escHtml(p.description)}</div>` : ''}
          ${dateRange ? `<div class="proj-card-dates">📅 ${dateRange}</div>` : ''}
          <div class="proj-progress">
            <div class="proj-progress-bar" style="width:${pct}%;background:${p.color||'#4f8ef7'}"></div>
          </div>
          <div class="proj-card-footer">
            <div class="proj-card-meta">${doneCount}/${taskCount} taken afgerond</div>
            <button class="btn btn-ghost btn-xs proj-folder-btn" data-name="${escHtml(p.name)}" title="Open projectmap in Finder">📂</button>
          </div>
        </div>
      </div>`;
      }).join('') + `</div>`;

    results.innerHTML = html;
    results.querySelectorAll('.proj-card').forEach(card => {
      card.onclick = () => {
        const proj = state.projects.find(p => p.id == card.dataset.projId);
        if (proj) renderProjectDetail(proj);
      };
    });
    results.querySelectorAll('.proj-folder-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openProjectFolder(btn.dataset.name);
      };
    });
  };

  content.querySelectorAll('.proj-filter-chip').forEach(btn => {
    btn.onclick = () => { state.projectsFilter = btn.dataset.projStatusFilter; renderProjectsView(); };
  });
  content.querySelectorAll('.proj-sort-btn').forEach(btn => {
    btn.onclick = () => {
      const field = btn.dataset.projSort;
      state.projectsSort = state.projectsSort.field === field
        ? { field, dir: state.projectsSort.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'asc' };
      renderProjectsView();
    };
  });
  const search = document.getElementById('proj-search');
  search.oninput = () => {
    state.projectsSearch = search.value;
    renderResults();
  };
  renderResults();
}

/* ─── Project Detail Page ──────────────────────────────────────────────────── */
function renderProjectDetail(proj) {
  state.activeProject = proj;
  const content = document.getElementById('content');
  const ctrl    = document.getElementById('toolbar-controls');

  // Toolbar: back | edit | folder | add task
  ctrl.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="proj-back-btn">← Projecten</button>
    <button class="btn btn-ghost btn-sm" id="proj-edit-btn">✏ Bewerken</button>
    <button class="btn btn-ghost btn-sm" id="proj-folder-btn" title="Open projectmap in Finder">📂 Map</button>
    <button class="btn btn-primary btn-sm" id="proj-add-task-btn">+ Taak</button>`;
  document.getElementById('proj-back-btn').onclick  = () => setView('projects');
  document.getElementById('proj-edit-btn').onclick  = () => openProjectModal(proj);
  document.getElementById('proj-folder-btn').onclick = () => openProjectFolder(proj.name);
  document.getElementById('proj-add-task-btn').onclick = () => openTaskModal(null, null, proj.id);

  // Update toolbar title
  document.getElementById('toolbar-title').textContent = proj.name;

  const projTasks = state.tasks.filter(t => t.project_id == proj.id);
  const doneCount = projTasks.filter(t => t.status === 'done').length;
  const pct       = projTasks.length ? Math.round(doneCount / projTasks.length * 100) : 0;
  const dateRange = (proj.start_date && proj.end_date)
    ? `${proj.start_date} → ${proj.end_date}`
    : proj.start_date ? `vanaf ${proj.start_date}` : '';

  // Header card
  let html = `<div class="proj-detail-header" style="border-left: 4px solid ${proj.color || '#4f8ef7'}">
    <div class="proj-detail-meta">
      <span class="badge badge-proj-${proj.status}">${fmtProjStatus(proj.status)}</span>
      ${dateRange ? `<span class="proj-card-dates">📅 ${dateRange}</span>` : ''}
    </div>
    ${proj.description ? `<div class="proj-card-desc">${escHtml(proj.description)}</div>` : ''}
    <div class="proj-progress" style="margin-top:8px">
      <div class="proj-progress-bar" style="width:${pct}%;background:${proj.color || '#4f8ef7'}"></div>
    </div>
    <div class="proj-card-meta">${doneCount}/${projTasks.length} taken afgerond</div>
  </div>`;

  // Task list grouped: open first, then done
  const open = projTasks.filter(t => t.status !== 'done');
  const done = projTasks.filter(t => t.status === 'done');

  function taskRow(t) {
    const isDone = t.status === 'done';
    return `<div class="daily-task-row" data-id="${t.id}">
      <div class="priority-dot priority-${t.priority || 'medium'}"></div>
      <input type="checkbox" class="status-cb" data-id="${t.id}" ${isDone ? 'checked' : ''} title="Markeer als afgerond" />
      <div class="daily-task-info">
        <div class="daily-task-title ${isDone ? 'done' : ''}">${escHtml(t.title)}</div>
        <div class="daily-task-meta">
          ${t.date ? `<span>📅 ${t.date}</span> · ` : ''}
          ${t.assigned_to ? `<span>→ ${escHtml(t.assigned_to)}</span> · ` : ''}
          <span class="badge badge-${t.status === 'in_progress' ? 'progress' : t.status}">${fmtStatus(t.status)}</span>
          ${t.description ? ` · ${escHtml(t.description).slice(0, 60)}${t.description.length > 60 ? '…' : ''}` : ''}
        </div>
      </div>
      <div class="daily-task-actions">
        <button class="btn btn-sm btn-ghost edit-task-btn" data-id="${t.id}">Edit</button>
      </div>
    </div>`;
  }

  html += '<div id="daily-list">';
  if (projTasks.length === 0) {
    html += `<div class="empty"><div class="empty-icon">📋</div><p>Nog geen taken. Klik "+ Taak" om te beginnen.</p></div>`;
  } else {
    if (open.length)  html += open.map(taskRow).join('');
    if (done.length)  html += `<div class="proj-done-divider">Afgerond</div>` + done.map(taskRow).join('');
  }
  html += '</div>';

  // Stages section
  const projStages = state.stages
    .filter(s => s.project_id == proj.id)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  const usedNames = new Set(projStages.map(s => s.name));
  const presetBtns = DEFAULT_STAGES.map(ds => {
    const used = usedNames.has(ds.name);
    return `<button class="phase-preset-btn${used?' used':''}" data-name="${escHtml(ds.name)}" data-color="${ds.color}"
      style="border-left-color:${ds.color}">${escHtml(ds.name)}</button>`;
  }).join('');
  html += `<div class="proj-stages-section">
    <div class="proj-stages-header">
      <h3>Fases</h3>
    </div>
    <div class="phase-presets">
      ${presetBtns}
      <button class="phase-preset-btn phase-preset-custom" id="add-stage-btn">+ Custom</button>
    </div>`;
  if (projStages.length === 0) {
    html += `<div class="proj-stages-empty">Nog geen fases. Klik een fase hierboven om toe te voegen.</div>`;
  } else {
    html += projStages.map(s => {
      const c = s.color || proj.color || '#4f8ef7';
      const label = escHtml(s.name);
      const stageTasks = state.tasks.filter(t => t.stage_id == s.id);
      // Merge date range from this stage's slots
      const slots = state.stageSlots.filter(sl => sl.stage_id == s.id && sl.start_date && sl.end_date);
      const mergedStart = slots.length ? slots.reduce((min, sl) => sl.start_date < min ? sl.start_date : min, slots[0].start_date) : '';
      const mergedEnd   = slots.length ? slots.reduce((max, sl) => sl.end_date   > max ? sl.end_date   : max, slots[0].end_date)   : '';
      const slotCount = slots.length;
      const openCount = stageTasks.filter(t => t.status !== 'done').length;
      const taskBadge = stageTasks.length > 0 ? ` <span class="stage-task-badge">${openCount}/${stageTasks.length}</span>` : '';
      const slotBadge = slotCount > 1 ? ` <span class="stage-task-badge">${slotCount} slots</span>` : '';
      const taskListHtml = stageTasks.length > 0 ? stageTasks.map(t =>
        `<div class="stage-inline-task ${t.status === 'done' ? 'done' : ''}" data-task-id="${t.id}">
          <input type="checkbox" class="stage-inline-cb" data-id="${t.id}" ${t.status === 'done' ? 'checked' : ''} />
          <span class="stage-inline-title">${escHtml(t.title)}</span>
          ${t.date ? `<span class="stage-inline-date">${t.date}</span>` : ''}
        </div>`
      ).join('') : '<div class="stage-inline-empty">Geen taken</div>';
      return `<div class="proj-stage-block" data-stage-id="${s.id}">
        <div class="proj-stage-row" data-stage-id="${s.id}" style="border-left:3px solid ${c};cursor:pointer">
          <div class="proj-stage-color" style="background:${c}"></div>
          <div class="proj-stage-info">
            <div class="proj-stage-name">${label}${taskBadge}${slotBadge}</div>
            <div class="proj-stage-dates">${(mergedStart && mergedEnd) ? `${mergedStart} → ${mergedEnd}` : '<span style="opacity:.5">Geen tijdslot</span>'}</div>
          </div>
          <span class="stage-expand-arrow" data-stage-id="${s.id}">▸</span>
          <button class="btn btn-sm btn-ghost del-stage-btn" data-stage-id="${s.id}" title="Verwijder fase">🗑</button>
        </div>
        <div class="stage-tasks-drawer hidden" data-stage-id="${s.id}">
          ${taskListHtml}
        </div>
      </div>`;
    }).join('');
  }
  html += '</div>';

  content.innerHTML = html;

  // Checkbox toggles
  content.querySelectorAll('.status-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      const task = state.tasks.find(t => t.id == cb.dataset.id);
      if (!task) return;
      await saveTask({ ...task, status: cb.checked ? 'done' : 'pending' });
      await loadTasks();
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
    });
  });
  content.querySelectorAll('.edit-task-btn').forEach(btn => {
    btn.onclick = () => {
      const task = state.tasks.find(t => t.id == btn.dataset.id);
      if (task) openTaskModal(task);
    };
  });

  document.getElementById('add-stage-btn').onclick = () => openStageModal(null, proj.id);
  content.querySelectorAll('.phase-preset-btn:not(.phase-preset-custom)').forEach(btn => {
    btn.onclick = async () => {
      const name = btn.dataset.name;
      if (state.stages.some(s => s.project_id == proj.id && s.name === name)) {
        toast(`'${name}' bestaat al`);
        return;
      }
      const existing = state.stages.filter(s => s.project_id == proj.id);
      await remoteQuery({ action: 'insert', table: 'project_stages', data: {
        project_id: proj.id,
        name,
        color:      btn.dataset.color,
        sort_order: existing.length,
      }});
      await loadStages();
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
      toast(`'${name}' toegevoegd`);
    };
  });
  // Stage row click → toggle task drawer
  content.querySelectorAll('.proj-stage-row').forEach(row => {
    row.onclick = e => {
      if (e.target.closest('.del-stage-btn')) return;
      const sid = row.dataset.stageId;
      const drawer = content.querySelector(`.stage-tasks-drawer[data-stage-id="${sid}"]`);
      const arrow = row.querySelector('.stage-expand-arrow');
      if (drawer) {
        const open = drawer.classList.toggle('hidden');
        if (arrow) arrow.textContent = open ? '▸' : '▾';
      }
    };
    // Double-click → edit stage
    row.ondblclick = e => {
      if (e.target.closest('.del-stage-btn')) return;
      const stage = state.stages.find(s => s.id == row.dataset.stageId);
      if (stage) openStageModal(stage, proj.id);
    };
  });

  // Inline task checkboxes
  content.querySelectorAll('.stage-inline-cb').forEach(cb => {
    cb.onchange = async () => {
      const task = state.tasks.find(t => t.id == cb.dataset.id);
      if (!task) return;
      await saveTask({ ...task, status: cb.checked ? 'done' : 'pending' });
      await loadTasks();
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
    };
  });

  // Inline task click → open task modal
  content.querySelectorAll('.stage-inline-task').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.stage-inline-cb')) return;
      const task = state.tasks.find(t => t.id == row.dataset.taskId);
      if (task) openTaskModal(task);
    });
  });

  content.querySelectorAll('.del-stage-btn').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Fase verwijderen? Eventuele taken in deze fase verliezen hun fase-koppeling.')) return;
      const stageId = Number(btn.dataset.stageId);
      // Clear tasks' stage_id first (FK cascade will drop slots automatically)
      const taskIds = state.tasks.filter(t => t.stage_id == stageId).map(t => t.id);
      for (const tid of taskIds) {
        await remoteQuery({ action: 'update', table: 'tasks', data: { stage_id: null }, where: { id: tid } });
      }
      await remoteQuery({ action: 'delete', table: 'project_stages', where: { id: stageId } });
      await Promise.all([loadStages(), loadTasks()]);
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
      toast('Fase verwijderd');
    };
  });
}

/* ─── Project Modal ────────────────────────────────────────────────────────── */
function buildProjColorSwatches(selectedColor) {
  const container = document.getElementById('proj-color-swatches');
  if (!container) return;
  container.innerHTML = '';
  COLORS.forEach(color => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (color === selectedColor ? ' selected' : '');
    sw.style.background = color;
    sw.dataset.color = color;
    sw.title = color;
    sw.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    container.appendChild(sw);
  });
}

function openProjectModal(proj) {
  state.editingProject = proj || null;
  const isEdit = !!proj;
  document.getElementById('project-modal-title').textContent = isEdit ? 'Project bewerken' : 'Nieuw project';
  document.getElementById('proj-name').value   = proj?.name        || '';
  document.getElementById('proj-client').value = proj?.client      || '';
  document.getElementById('proj-client-suggestions').classList.add('hidden');
  document.getElementById('proj-desc').value   = proj?.description || '';
  document.getElementById('proj-start').value  = proj?.start_date  || '';
  document.getElementById('proj-end').value    = proj?.end_date    || '';
  document.getElementById('proj-status').value = proj?.status      || 'active';
  document.getElementById('proj-exclude-analysis').checked = !!proj?.exclude_from_analysis;
  document.getElementById('proj-delete').classList.toggle('hidden', !isEdit);
  // Auto-pick an unused color for new projects
  let defaultColor = COLORS[0];
  if (!isEdit) {
    defaultColor = pickProjectColor();
  }
  buildProjColorSwatches(proj?.color || defaultColor);
  document.getElementById('project-modal').classList.remove('hidden');
  document.getElementById('proj-name').focus();
}

function closeProjectModal() {
  document.getElementById('project-modal').classList.add('hidden');
  state.editingProject = null;
}

function wireProjectModal() {
  document.getElementById('proj-cancel').onclick = closeProjectModal;

  document.getElementById('project-modal').addEventListener('mousedown', e => {
    if (e.target === document.getElementById('project-modal')) closeProjectModal();
  });

  // Custom autocomplete for client field (same pattern as the quote wizard)
  const projClientInput = document.getElementById('proj-client');
  const projSugg = document.getElementById('proj-client-suggestions');

  function showProjClientSuggestions(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? state.clients.filter(c => c.name.toLowerCase().includes(q))
      : state.clients;
    if (!matches.length) { projSugg.classList.add('hidden'); return; }
    projSugg.innerHTML = matches.map(c =>
      `<div class="qw-suggestion-item" data-id="${c.id}">${escHtml(c.name)}</div>`
    ).join('');
    projSugg.classList.remove('hidden');
    projSugg.querySelectorAll('.qw-suggestion-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        const c = state.clients.find(cl => cl.id === parseInt(item.dataset.id));
        if (!c) return;
        projClientInput.value = c.name;
        projSugg.classList.add('hidden');
      });
    });
  }

  projClientInput.addEventListener('focus', () => {
    if (state.clients.length) showProjClientSuggestions(projClientInput.value);
  });
  projClientInput.addEventListener('input', e => showProjClientSuggestions(e.target.value));
  projClientInput.addEventListener('blur', () => {
    setTimeout(() => projSugg.classList.add('hidden'), 150);
  });
  projClientInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') projSugg.classList.add('hidden');
  });

  document.getElementById('proj-save').onclick = async () => {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) { shake(document.getElementById('proj-name')); return; }
    const selectedSwatch = document.querySelector('#proj-color-swatches .color-swatch.selected');
    const data = {
      name,
      client:      document.getElementById('proj-client').value.trim(),
      description: document.getElementById('proj-desc').value.trim(),
      start_date:  document.getElementById('proj-start').value || '',
      end_date:    document.getElementById('proj-end').value   || '',
      status:      document.getElementById('proj-status').value,
      color:       selectedSwatch?.dataset.color || COLORS[0],
      exclude_from_analysis: document.getElementById('proj-exclude-analysis').checked ? 1 : 0,
      created_by:  state.config?.name || '',
    };
    if (state.editingProject) {
      await remoteQuery({ action: 'update', table: 'projects', data, where: { id: state.editingProject.id } });
    } else {
      await remoteQuery({ action: 'insert', table: 'projects', data });
      createProjectFolder(data.name); // fire-and-forget
    }
    moveProjectFolder(data.name, data.status); // fire-and-forget: sync folder location to status
    await Promise.all([loadProjects(), loadStages()]);
    closeProjectModal();
    renderView();
    toast('Project opgeslagen');
  };

  document.getElementById('proj-delete').onclick = async () => {
    if (!state.editingProject) return;
    if (!confirm(`Project "${state.editingProject.name}" verwijderen?`)) return;
    await remoteQuery({ action: 'delete', table: 'projects', where: { id: state.editingProject.id } });
    // Unlink tasks from this project
    const linked = state.tasks.filter(t => t.project_id == state.editingProject.id);
    for (const t of linked) {
      await remoteQuery({ action: 'update', table: 'tasks', data: { project_id: null }, where: { id: t.id } });
    }
    await Promise.all([loadProjects(), loadTasks()]);
    closeProjectModal();
    renderView();
    toast('Project verwijderd');
  };
}

async function insertDefaultStages(projectId) {
  for (let i = 0; i < DEFAULT_STAGES.length; i++) {
    await remoteQuery({ action: 'insert', table: 'project_stages', data: {
      project_id: projectId,
      name:       DEFAULT_STAGES[i].name,
      color:      DEFAULT_STAGES[i].color,
      sort_order: i,
    }});
  }
}

function fmtProjStatus(s) {
  return { active: 'Actief', done: 'Afgerond', on_hold: 'In de wacht' }[s] || s;
}

/* ─── Stage Modal ─────────────────────────────────────────────────────────── */

function openStageModal(stage, projectId, suggestedDate = null) {
  state.editingStage = stage ? { ...stage } : { _projectId: projectId };
  const isEdit = !!stage;
  document.getElementById('stage-modal-title').textContent = isEdit ? 'Fase bewerken' : 'Nieuwe fase';
  document.getElementById('stage-name').value  = stage?.name  || '';
  document.getElementById('stage-notes').value = stage?.notes || '';
  document.getElementById('stage-delete').classList.toggle('hidden', !isEdit);
  buildStageColorSwatches(stage?.color || pickNextColor(state.stages));

  // Slot-add inputs prefill
  document.getElementById('stage-slot-start').value = suggestedDate || '';
  document.getElementById('stage-slot-end').value   = suggestedDate || '';

  // Slots + tasks sections only shown for saved stages
  const slotsSection = document.getElementById('stage-slots-section');
  const tasksSection = document.getElementById('stage-tasks-section');
  slotsSection.classList.toggle('hidden', !isEdit);
  tasksSection.classList.toggle('hidden', !isEdit);
  if (isEdit) {
    remoteQuery({ action: 'select', table: 'team_members' }).then(members => {
      const sel = document.getElementById('stage-task-assignee');
      sel.innerHTML = `<option value="">— Niemand —</option>` +
        members.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
    });
    renderStageSlots(stage.id);
    renderStageTasks(stage.id);
  }
  document.getElementById('stage-modal').classList.remove('hidden');
  document.getElementById('stage-name').focus();
}

function renderStageSlots(stageId) {
  const list = document.getElementById('stage-slot-list');
  if (!list) return;
  const slots = state.stageSlots
    .filter(s => s.stage_id == stageId)
    .slice()
    .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
  if (slots.length === 0) {
    list.innerHTML = `<p class="stage-task-empty">Geen tijdsloten — voeg er één toe hieronder.</p>`;
    return;
  }
  list.innerHTML = slots.map(sl => `
    <div class="stage-slot-item" data-id="${sl.id}">
      <span class="stage-slot-dates">${sl.start_date || '—'} → ${sl.end_date || '—'}</span>
      <button class="stage-slot-del" data-id="${sl.id}" title="Verwijder tijdslot">×</button>
    </div>
  `).join('');
  list.querySelectorAll('.stage-slot-del').forEach(btn => {
    btn.onclick = async () => {
      await remoteQuery({ action: 'delete', table: 'stage_slots', where: { id: Number(btn.dataset.id) } });
      await loadStages();
      renderStageSlots(stageId);
    };
  });
}

function renderStageTasks(stageId) {
  const list = document.getElementById('stage-task-list');
  if (!list) return;
  const tasks = stageId ? state.tasks.filter(t => t.stage_id == stageId) : [];
  if (tasks.length === 0) {
    list.innerHTML = `<p class="stage-task-empty">Geen taken — voeg er een toe hieronder.</p>`;
    return;
  }
  list.innerHTML = tasks.map(t => `
    <div class="stm-task-item" data-id="${t.id}">
      <input type="checkbox" class="stm-task-cb" ${t.status === 'done' ? 'checked' : ''} />
      <span class="stm-task-title ${t.status === 'done' ? 'done' : ''}">${escHtml(t.title)}</span>
      ${t.assigned_to ? `<span class="stm-task-assignee">${escHtml(t.assigned_to)}</span>` : ''}
      <button class="stm-task-del" data-id="${t.id}">×</button>
    </div>
  `).join('');
  list.querySelectorAll('.stm-task-cb').forEach(cb => {
    cb.onchange = async () => {
      const id = Number(cb.closest('.stm-task-item').dataset.id);
      await remoteQuery({ action: 'update', table: 'tasks', data: { status: cb.checked ? 'done' : 'pending' }, where: { id } });
      await loadTasks();
      renderStageTasks(stageId);
    };
  });
  list.querySelectorAll('.stm-task-del').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Taak verwijderen?')) return;
      await remoteQuery({ action: 'delete', table: 'tasks', where: { id: Number(btn.dataset.id) } });
      await loadTasks();
      renderStageTasks(stageId);
    };
  });
}

function closeStageModal() {
  document.getElementById('stage-modal').classList.add('hidden');
  state.editingStage = null;
}

function buildStageColorSwatches(selected) {
  const container = document.getElementById('stage-color-swatches');
  container.innerHTML = COLORS.map(c =>
    `<div class="color-swatch${c === selected ? ' selected' : ''}" data-color="${c}" style="background:${c}"></div>`
  ).join('');
  container.querySelectorAll('.color-swatch').forEach(sw => {
    sw.onclick = () => {
      container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    };
  });
}

function wireStageModal() {
  document.getElementById('stage-cancel').onclick = closeStageModal;
  document.getElementById('stage-modal').addEventListener('mousedown', e => {
    if (e.target === document.getElementById('stage-modal')) closeStageModal();
  });

  document.getElementById('stage-task-add-btn').onclick = async () => {
    const titleEl = document.getElementById('stage-task-title');
    const title = titleEl.value.trim();
    if (!title) { shake(titleEl); return; }
    const assignedTo = document.getElementById('stage-task-assignee').value;
    const stage = state.editingStage;
    if (!stage?.id) return;
    await remoteQuery({ action: 'insert', table: 'tasks', data: {
      title,
      assigned_to: assignedTo,
      project_id: stage.project_id || null,
      stage_id: stage.id,
      status: 'pending',
      priority: 'medium',
      created_by: state.config?.name || '',
    }});
    titleEl.value = '';
    await loadTasks();
    renderStageTasks(stage.id);
  };

  document.getElementById('stage-task-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('stage-task-add-btn').click();
  });

  // Keep slot-end in sync with slot-start when empty
  document.getElementById('stage-slot-start').addEventListener('input', () => {
    const end = document.getElementById('stage-slot-end');
    if (!end.value) end.value = document.getElementById('stage-slot-start').value;
  });

  // Add a new time slot to the current stage
  document.getElementById('stage-slot-add-btn').onclick = async () => {
    const stage = state.editingStage;
    if (!stage?.id) { toast('Sla de fase eerst op.'); return; }
    const startEl = document.getElementById('stage-slot-start');
    const endEl   = document.getElementById('stage-slot-end');
    const start = startEl.value;
    const end   = endEl.value || start;
    if (!start) { shake(startEl); return; }
    const existing = state.stageSlots.filter(s => s.stage_id == stage.id);
    await remoteQuery({ action: 'insert', table: 'stage_slots', data: {
      stage_id:   stage.id,
      start_date: start,
      end_date:   end,
      sort_order: existing.length,
    }});
    startEl.value = '';
    endEl.value = '';
    await loadStages();
    renderStageSlots(stage.id);
  };

  document.getElementById('stage-save').onclick = async () => {
    const name = document.getElementById('stage-name').value.trim();
    if (!name) { shake(document.getElementById('stage-name')); return; }
    const selectedSwatch = document.querySelector('#stage-color-swatches .color-swatch.selected');
    const data = {
      name,
      color: selectedSwatch?.dataset.color || COLORS[0],
      notes: document.getElementById('stage-notes').value.trim(),
    };
    try {
      if (state.editingStage?.id) {
        await remoteQuery({ action: 'update', table: 'project_stages', data, where: { id: state.editingStage.id } });
      } else {
        const projectId = state.editingStage._projectId;
        const existing  = state.stages.filter(s => s.project_id == projectId);
        await remoteQuery({ action: 'insert', table: 'project_stages',
          data: { ...data, project_id: projectId, sort_order: existing.length } });
      }
      await loadStages();
      closeStageModal();
      if (state.activeProject) renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
      if (state.view === 'gantt') renderGantt();
      toast('Fase opgeslagen');
    } catch (err) {
      console.error('Stage save error:', err);
      toast('Fout bij opslaan fase: ' + err.message);
    }
  };

  document.getElementById('stage-delete').onclick = async () => {
    if (!state.editingStage?.id) return;
    if (!confirm('Fase verwijderen? Eventuele taken in deze fase verliezen hun fase-koppeling.')) return;
    const stageId = state.editingStage.id;
    const taskIds = state.tasks.filter(t => t.stage_id == stageId).map(t => t.id);
    for (const tid of taskIds) {
      await remoteQuery({ action: 'update', table: 'tasks', data: { stage_id: null }, where: { id: tid } });
    }
    await remoteQuery({ action: 'delete', table: 'project_stages', where: { id: stageId } });
    await Promise.all([loadStages(), loadTasks()]);
    closeStageModal();
    if (state.activeProject) renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
    if (state.view === 'gantt') renderGantt();
    toast('Fase verwijderd');
  };
}

/* ─── Todo Lists View ──────────────────────────────────────────────────────── */
function renderTodo() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');

  ctrl.innerHTML = `
    <button class="btn btn-primary btn-sm" id="new-list-btn">+ Nieuwe lijst</button>
    <button class="btn btn-sm ${state.todoHideDone ? 'btn-primary' : 'btn-ghost'}" id="hide-done-btn">
      ${state.todoHideDone ? 'Toon alles' : 'Verberg afgerond'}
    </button>`;
  document.getElementById('new-list-btn').onclick = () => openListModal(null);
  document.getElementById('hide-done-btn').onclick = () => {
    state.todoHideDone = !state.todoHideDone;
    renderTodo();
  };

  if (state.todoLists.length === 0) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">✅</div><p>No lists yet. Create one to get started!</p></div>`;
    return;
  }

  let html = '<div id="todo-grid">';
  state.todoLists.forEach(list => {
    const items = state.todoItems[list.id] || [];
    const done = items.filter(i => i.completed).length;
    const pct = items.length ? Math.round((done/items.length)*100) : 0;
    const visibleItems = state.todoHideDone ? items.filter(i => !i.completed) : items;

    const itemsHtml = visibleItems.map(item => `
      <div class="todo-item-row" data-item-id="${item.id}" data-list-id="${list.id}" draggable="true">
        <span class="todo-drag-handle" title="Slepen">⠿</span>
        <input type="checkbox" ${item.completed?'checked':''} class="todo-cb" data-item-id="${item.id}" data-list-id="${list.id}" />
        <span class="todo-item-text ${item.completed?'done':''}" title="Dubbelklik om te bewerken">${escHtml(item.text)}</span>
        <button class="todo-item-delete" data-item-id="${item.id}" data-list-id="${list.id}" title="Verwijder">✕</button>
      </div>`).join('');

    html += `<div class="todo-card" data-list-id="${list.id}">
      <div class="todo-card-header" draggable="true">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="card-drag-handle">⠿</span>
          <div class="todo-card-title">${escHtml(list.name)}</div>
        </div>
        ${list.description ? `<div class="todo-card-desc">${escHtml(list.description)}</div>` : ''}
        <div class="todo-progress">
          <div class="todo-progress-bar" style="width:${pct}%"></div>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px">${done}/${items.length} afgerond</div>
      </div>
      <div class="todo-items" data-list-id="${list.id}">${itemsHtml}</div>
      <form class="todo-add-item-form" data-list-id="${list.id}">
        <input type="text" placeholder="Item toevoegen…" class="add-item-input" autocomplete="off" />
        <button type="submit" class="btn btn-primary btn-sm">Toevoegen</button>
      </form>
      <div class="todo-card-actions">
        <button class="btn btn-ghost btn-sm edit-list-btn" data-list-id="${list.id}">Bewerken</button>
      </div>
    </div>`;
  });
  html += '</div>';
  content.innerHTML = html;

  // Checkbox toggles
  content.querySelectorAll('.todo-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      await toggleTodoItem(cb.dataset.listId, cb.dataset.itemId, cb.checked);
    });
  });

  // Delete item buttons
  content.querySelectorAll('.todo-item-delete').forEach(btn => {
    btn.onclick = async () => {
      await deleteTodoItem(btn.dataset.listId, btn.dataset.itemId);
    };
  });

  // Add item forms
  content.querySelectorAll('.todo-add-item-form').forEach(form => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = form.querySelector('.add-item-input');
      const text = input.value.trim();
      if (!text) return;
      await addTodoItem(form.dataset.listId, text);
      input.value = '';
    };
  });

  // Edit list buttons
  content.querySelectorAll('.edit-list-btn').forEach(btn => {
    btn.onclick = () => {
      const list = state.todoLists.find(l => l.id == btn.dataset.listId);
      if (list) openListModal(list);
    };
  });

  // ── Item drag-and-drop reordering ─────────────────────────────────────────
  let dragListId = null;
  let placeholder = null;
  let cardDragSrc = null;

  function getAfterElement(zone, y) {
    const rows = [...zone.querySelectorAll('.todo-item-row:not(.dragging)')];
    return rows.reduce((closest, row) => {
      const box = row.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: row };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  async function persistOrder(zoneListId) {
    const zone = content.querySelector(`.todo-items[data-list-id="${zoneListId}"]`);
    if (!zone) return;
    const rows = [...zone.querySelectorAll('.todo-item-row[data-item-id]')];
    for (let i = 0; i < rows.length; i++) {
      const itemId = Number(rows[i].dataset.itemId);
      await remoteQuery({ action: 'update', table: 'todo_items',
        data: { sort_order: i, list_id: Number(zoneListId) },
        where: { id: itemId } });
    }
  }

  content.querySelectorAll('.todo-item-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      if (cardDragSrc) return;
      dragListId = row.dataset.listId;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      placeholder = document.createElement('div');
      placeholder.className = 'todo-drag-placeholder';
      e.stopPropagation();
    });

    row.addEventListener('dragend', async () => {
      if (!dragListId) return;
      row.classList.remove('dragging');
      if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
      const newListId = row.dataset.listId;
      const toUpdate = new Set([dragListId, newListId].filter(Boolean));
      for (const id of toUpdate) await persistOrder(id);
      dragListId = null;
      placeholder = null;
      await loadTodoLists();
      renderTodo();
    });
  });

  content.querySelectorAll('.todo-items').forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      if (cardDragSrc) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!placeholder) return;
      const after = getAfterElement(zone, e.clientY);
      if (after) zone.insertBefore(placeholder, after);
      else zone.appendChild(placeholder);
    });

    zone.addEventListener('drop', (e) => {
      if (cardDragSrc) return;
      e.preventDefault();
      const dragging = content.querySelector('.todo-item-row.dragging');
      if (!dragging) return;
      dragging.dataset.listId = zone.dataset.listId;
      if (placeholder && placeholder.parentNode === zone) {
        zone.insertBefore(dragging, placeholder);
      } else {
        zone.appendChild(dragging);
      }
      if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    });
  });

  // ── Card drag-and-drop reordering ─────────────────────────────────────────
  const grid = document.getElementById('todo-grid');

  content.querySelectorAll('.todo-card-header').forEach(header => {
    header.addEventListener('dragstart', (e) => {
      cardDragSrc = header.closest('.todo-card');
      cardDragSrc.classList.add('card-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    header.addEventListener('dragend', async () => {
      if (!cardDragSrc) return;
      cardDragSrc.classList.remove('card-dragging');
      const cards = [...grid.querySelectorAll('.todo-card[data-list-id]')];
      for (let i = 0; i < cards.length; i++) {
        await remoteQuery({ action: 'update', table: 'todo_lists',
          data: { sort_order: i }, where: { id: Number(cards[i].dataset.listId) } });
      }
      cardDragSrc = null;
      await loadTodoLists();
      renderTodo();
    });
  });

  grid.addEventListener('dragover', (e) => {
    if (!cardDragSrc) return;
    e.preventDefault();
    const targetCard = e.target.closest('.todo-card');
    if (!targetCard || targetCard === cardDragSrc) return;
    const rect = targetCard.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      grid.insertBefore(cardDragSrc, targetCard);
    } else {
      grid.insertBefore(cardDragSrc, targetCard.nextSibling);
    }
  });

  // ── Inline editing (double-click) ─────────────────────────────────────────
  content.querySelectorAll('.todo-item-text').forEach(span => {
    span.addEventListener('dblclick', () => {
      const row      = span.closest('.todo-item-row');
      const itemId   = Number(row.dataset.itemId);
      const original = span.textContent;

      const input = document.createElement('input');
      input.type      = 'text';
      input.value     = original;
      input.className = 'todo-item-edit-input';
      span.replaceWith(input);
      input.focus();
      input.select();

      let committed = false;
      async function commit() {
        if (committed) return;
        committed = true;
        const newText = input.value.trim();
        if (newText && newText !== original) {
          await remoteQuery({ action: 'update', table: 'todo_items', data: { text: newText }, where: { id: itemId } });
          await loadTodoLists();
          renderTodo();
        } else {
          input.replaceWith(span);
        }
      }

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') {
          committed = true;
          input.replaceWith(span);
        }
      });
    });
  });
}

/* ─── Todo Operations ──────────────────────────────────────────────────────── */
async function addTodoItem(listId, text) {
  const data = { list_id: listId, text, created_by: state.config.name || '' };
  try {
    await remoteQuery({ action: 'insert', table: 'todo_items', data });
  } catch (err) {
    toast(`Fout bij opslaan: ${err.message || err}`, 'error');
    return;
  }
  await loadTodoLists();
  renderTodo();
}

async function toggleTodoItem(listId, itemId, completed) {
  await remoteQuery({ action: 'update', table: 'todo_items', data: { completed: completed ? 1 : 0 }, where: { id: itemId } });
  // Update local state in place — no full re-render so scroll position is kept
  const items = state.todoItems[listId] || [];
  const item = items.find(i => String(i.id) === String(itemId));
  if (item) item.completed = completed ? 1 : 0;

  // Update only the affected row + the card's progress bar
  const row = document.querySelector(`.todo-item-row[data-item-id="${itemId}"]`);
  if (row) {
    const text = row.querySelector('.todo-item-text');
    if (text) text.classList.toggle('done', !!completed);
  }
  const card = document.querySelector(`.todo-card[data-list-id="${listId}"]`);
  if (card) {
    const done = items.filter(i => i.completed).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    const bar = card.querySelector('.todo-progress-bar');
    if (bar) bar.style.width = pct + '%';
    const counter = card.querySelector('.todo-card-header > div:last-child');
    if (counter && counter.textContent.includes('afgerond')) {
      counter.textContent = `${done}/${items.length} afgerond`;
    }
  }

  // If "Verberg afgerond" is on, fade & remove just this row
  if (state.todoHideDone && completed && row) {
    row.style.transition = 'opacity .25s';
    row.style.opacity = '0';
    setTimeout(() => row.remove(), 250);
  }
}

async function deleteTodoItem(listId, itemId) {
  await remoteQuery({ action: 'delete', table: 'todo_items', where: { id: itemId } });
  await loadTodoLists();
  renderTodo();
}

/* ─── Multi-assignee Picker ─────────────────────────────────────────────────── */
let pickerAssignees = [];  // names currently selected in the open task modal

function openAssigneePicker(initialValue) {
  pickerAssignees = initialValue ? initialValue.split(', ').map(s => s.trim()).filter(Boolean) : [];
  renderAssigneePicker();
}

async function renderAssigneePicker() {
  const container = document.getElementById('assignee-picker');
  if (!container) return;

  const members = await remoteQuery({ action: 'select', table: 'team_members' });
  const memberNames = members.map(m => m.name);

  // Team member toggle pills
  const pillsHtml = members.length
    ? `<div class="assignee-pills">${members.map(m => {
        const sel = pickerAssignees.includes(m.name);
        return `<button type="button" class="assignee-pill${sel ? ' selected' : ''}"
                  data-name="${escHtml(m.name)}">${escHtml(m.name)}</button>`;
      }).join('')}</div>`
    : '';

  // Chips for custom names (not in team_members)
  const customNames = pickerAssignees.filter(n => !memberNames.includes(n));
  const customChipsHtml = customNames.length
    ? `<div class="assignee-custom-chips">${customNames.map(n =>
        `<span class="assignee-chip">${escHtml(n)
        }<button type="button" class="chip-remove" data-name="${escHtml(n)}">×</button></span>`
      ).join('')}</div>`
    : '';

  container.innerHTML = `
    ${pillsHtml}
    ${customChipsHtml}
    <input type="text" id="assignee-custom-input" placeholder="Andere naam…" autocomplete="off" />`;

  // Toggle team member pills
  container.querySelectorAll('.assignee-pill').forEach(btn => {
    btn.onclick = () => {
      const name = btn.dataset.name;
      pickerAssignees = pickerAssignees.includes(name)
        ? pickerAssignees.filter(n => n !== name)
        : [...pickerAssignees, name];
      renderAssigneePicker();
    };
  });

  // Remove custom name chips
  container.querySelectorAll('.chip-remove').forEach(btn => {
    btn.onclick = () => {
      pickerAssignees = pickerAssignees.filter(n => n !== btn.dataset.name);
      renderAssigneePicker();
    };
  });

  // Add custom name on Enter
  const customInput = container.querySelector('#assignee-custom-input');
  customInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = customInput.value.trim();
    if (name && !pickerAssignees.includes(name)) {
      pickerAssignees = [...pickerAssignees, name];
      renderAssigneePicker();
    }
  });
}

/* ─── Task Modal ───────────────────────────────────────────────────────────── */
function openTaskModal(task, defaultDate, defaultProjectId) {
  state.editingTask = task || null;
  const isEdit = !!task;

  document.getElementById('task-modal-title').textContent = isEdit ? 'Taak bewerken' : 'Taak toevoegen';
  document.getElementById('task-title').value    = task?.title || '';
  document.getElementById('task-desc').value     = task?.description || '';
  document.getElementById('task-date').value     = task?.date || defaultDate || toDateStr(state.cursor);
  document.getElementById('task-end-date').value = task?.end_date || '';
  const allDay = task ? (task.all_day !== 0) : true;
  document.getElementById('task-all-day').checked = allDay;
  document.getElementById('task-time').value = task?.task_time || '';
  document.getElementById('task-time-group').classList.toggle('hidden', allDay);
  openAssigneePicker(task?.assigned_to ?? state.config.name ?? '');
  document.getElementById('task-status').value = task?.status || 'pending';
  document.getElementById('task-delete').classList.toggle('hidden', !isEdit);

  // Color swatch selection — cycle through unused colors for new tasks
  const selectedColor = task?.color || pickNextColor(state.tasks);
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === selectedColor);
  });

  // Populate project dropdown — active projects only by default
  const projSel = document.getElementById('task-project');
  const preselProject = task?.project_id ?? defaultProjectId ?? null;

  // If the preselected project is inactive, start with all visible so it shows
  const preselObj = preselProject ? state.projects.find(p => p.id == preselProject) : null;
  let showAllProjects = !!(preselObj && preselObj.status !== 'active');

  const hasInactive = state.projects.some(p => p.status !== 'active');
  const projToggle = document.getElementById('task-project-toggle');

  function populateProjectDropdown() {
    const visible = showAllProjects
      ? state.projects
      : state.projects.filter(p => p.status === 'active');
    projSel.innerHTML = '<option value="">— Geen project —</option>' +
      visible.map(p =>
        `<option value="${p.id}" ${preselProject == p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`
      ).join('');
    if (hasInactive) {
      projToggle.textContent = showAllProjects ? '▾ verberg oude projecten' : '▸ toon oude projecten';
      projToggle.classList.remove('hidden');
    } else {
      projToggle.classList.add('hidden');
    }
  }

  populateProjectDropdown();
  projToggle.onclick = (e) => {
    e.preventDefault();
    showAllProjects = !showAllProjects;
    populateProjectDropdown();
  };

  // Populate stage dropdown based on selected project
  function populateStageDropdown(projectId, selectedStageId) {
    const stageSel = document.getElementById('task-stage');
    const projStages = projectId ? state.stages.filter(s => s.project_id == projectId) : [];
    stageSel.innerHTML = '<option value="">— Geen fase —</option>' +
      projStages.map(s =>
        `<option value="${s.id}" ${selectedStageId == s.id ? 'selected' : ''}>${escHtml(s.name)}</option>`
      ).join('') +
      (projectId ? '<option value="__new__">+ Nieuwe fase…</option>' : '');
  }
  populateStageDropdown(preselProject, task?.stage_id ?? null);
  projSel.addEventListener('change', () => populateStageDropdown(projSel.value, null));

  // Handle "Nieuwe fase" selection with inline input
  const stageSel = document.getElementById('task-stage');
  const stageNewInput = document.getElementById('task-stage-new');
  stageNewInput.classList.add('hidden');
  stageNewInput.value = '';

  async function createNewStageFromInput() {
    const name = stageNewInput.value.trim();
    const projectId = projSel.value;
    if (!name || !projectId) {
      stageNewInput.classList.add('hidden');
      stageNewInput.value = '';
      if (stageSel.value === '__new__') stageSel.value = '';
      return;
    }
    const proj = state.projects.find(p => p.id == projectId);
    const existing = state.stages.filter(s => s.project_id == projectId);
    const color = DEFAULT_STAGES.find(ds => ds.name.toLowerCase() === name.toLowerCase())?.color || proj?.color || COLORS[0];
    const result = await remoteQuery({ action: 'insert', table: 'project_stages', data: {
      project_id: parseInt(projectId),
      name,
      color,
      sort_order: existing.length,
      notes: '',
    }});
    await loadStages();
    const newId = result?.id || state.stages.filter(s => s.project_id == projectId).slice(-1)[0]?.id;
    populateStageDropdown(projectId, newId);
    stageNewInput.classList.add('hidden');
    stageNewInput.value = '';
  }

  stageSel.addEventListener('change', function() {
    if (this.value !== '__new__') {
      stageNewInput.classList.add('hidden');
      stageNewInput.value = '';
      return;
    }
    const projectId = projSel.value;
    if (!projectId) { this.value = ''; return; }
    stageNewInput.classList.remove('hidden');
    stageNewInput.value = '';
    stageNewInput.focus();
  });

  stageNewInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await createNewStageFromInput();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stageNewInput.classList.add('hidden');
      stageNewInput.value = '';
      stageSel.value = '';
    }
  });
  stageNewInput.addEventListener('blur', async () => {
    if (!stageNewInput.classList.contains('hidden') && stageNewInput.value.trim()) {
      await createNewStageFromInput();
    }
  });

  document.getElementById('task-modal').classList.remove('hidden');
  document.getElementById('task-title').focus();
}

function closeTaskModal() {
  document.getElementById('task-modal').classList.add('hidden');
  state.editingTask = null;
  // Re-render so any stages created inline from the task modal show up
  if (state.activeProject) {
    renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
  }
}

async function saveTask(taskData) {
  if (taskData.id) {
    const { id, created_at, ...data } = taskData;
    await remoteQuery({ action: 'update', table: 'tasks', data, where: { id: taskData.id } });
  } else {
    await remoteQuery({ action: 'insert', table: 'tasks', data: taskData });
  }
}

function wireTaskModal() {
  document.getElementById('task-cancel').onclick = closeTaskModal;
  document.getElementById('task-all-day').addEventListener('change', e => {
    document.getElementById('task-time-group').classList.toggle('hidden', e.target.checked);
    if (e.target.checked) document.getElementById('task-time').value = '';
  });
  document.getElementById('task-save').onclick = async () => {
    const title = document.getElementById('task-title').value.trim();
    if (!title) { shake(document.getElementById('task-title')); return; }

    const selectedSwatch = document.querySelector('.color-swatch.selected');
    const color = selectedSwatch?.dataset.color || COLORS[0];

    const projVal = document.getElementById('task-project').value;
    const taskData = {
      title,
      description: document.getElementById('task-desc').value.trim(),
      date:        document.getElementById('task-date').value,
      end_date:    document.getElementById('task-end-date').value || '',
      all_day:     document.getElementById('task-all-day').checked ? 1 : 0,
      task_time:   document.getElementById('task-all-day').checked ? '' : (document.getElementById('task-time').value || ''),
      assigned_to: pickerAssignees.join(', '),
      project_id:  projVal ? parseInt(projVal) : null,
      stage_id:    document.getElementById('task-stage').value ? parseInt(document.getElementById('task-stage').value) : null,
      status:      document.getElementById('task-status').value,
      priority:    'medium',
      color,
      created_by:  state.config.name || '',
      ...(state.editingTask ? { id: state.editingTask.id, created_at: state.editingTask.created_at } : {}),
    };

    if (state.editingTask) {
      const snap = { ...state.editingTask };
      pushUndo(`bewerk "${escHtml(snap.title)}"`, async () => {
        await saveTask(snap); await loadTasks(); renderView();
      });
    }
    await saveTask(taskData);
    await loadTasks();
    closeTaskModal();
    if (state.activeProject) {
      renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
    } else {
      renderView();
    }
    toast('Taak opgeslagen');
  };

  document.getElementById('task-delete').onclick = async () => {
    if (!state.editingTask) return;
    if (!confirm('Taak verwijderen?')) return;
    try {
      const task = state.editingTask;
      const snap = { ...task };
      pushUndo(`verwijder "${escHtml(snap.title)}"`, async () => {
        const { id, created_at, ...data } = snap;
        await remoteQuery({ action: 'insert', table: 'tasks', data });
        await loadTasks(); renderView();
      });
      await remoteQuery({ action: 'delete', table: 'tasks', where: { id: task.id } });
      await loadTasks();
      closeTaskModal();
      if (state.activeProject) {
        renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
      } else {
        renderView();
      }
      toast('Taak verwijderd');
    } catch (err) {
      toast('Verwijderen mislukt: ' + err.message);
    }
  };

  // Close on overlay click
  document.getElementById('task-modal').addEventListener('mousedown', e => {
    if (e.target === document.getElementById('task-modal')) closeTaskModal();
  });
}

/* ─── Todo List Modal ──────────────────────────────────────────────────────── */
function openListModal(list) {
  state.editingList = list || null;
  const isEdit = !!list;
  document.getElementById('list-modal-title').textContent = isEdit ? 'Lijst bewerken' : 'Nieuwe lijst';
  document.getElementById('list-name').value = list?.name || '';
  document.getElementById('list-desc').value = list?.description || '';
  document.getElementById('list-delete').classList.toggle('hidden', !isEdit);
  document.getElementById('list-modal').classList.remove('hidden');
  document.getElementById('list-name').focus();
}

function closeListModal() {
  document.getElementById('list-modal').classList.add('hidden');
  state.editingList = null;
}

function wireListModal() {
  document.getElementById('list-cancel').onclick = closeListModal;

  document.getElementById('list-save').onclick = async () => {
    const name = document.getElementById('list-name').value.trim();
    if (!name) { shake(document.getElementById('list-name')); return; }
    const data = {
      name,
      description: document.getElementById('list-desc').value.trim(),
      created_by: state.config.name || '',
    };
    if (state.editingList) {
      await remoteQuery({ action: 'update', table: 'todo_lists', data, where: { id: state.editingList.id } });
    } else {
      await remoteQuery({ action: 'insert', table: 'todo_lists', data });
    }
    await loadTodoLists();
    closeListModal();
    renderTodo();
    toast('Lijst opgeslagen');
  };

  document.getElementById('list-delete').onclick = async () => {
    if (!state.editingList) return;
    if (!confirm('Lijst en alle items verwijderen?')) return;
    await remoteQuery({ action: 'delete', table: 'todo_lists', where: { id: state.editingList.id } });
    await loadTodoLists();
    closeListModal();
    renderTodo();
    toast('Lijst verwijderd');
  };

  document.getElementById('list-modal').addEventListener('mousedown', e => {
    if (e.target === document.getElementById('list-modal')) closeListModal();
  });
}

/* ─── Settings Modal ───────────────────────────────────────────────────────── */
/* ─── Catalog Editor ──────────────────────────────────────────────────────── */

let _catalogTab = 'mat';
let _catDragSrc = null;

function wireCatalog() {
  document.getElementById('open-catalog-btn')?.addEventListener('click', () => {
    _catalogTab = 'mat';
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('catalog-overlay').classList.remove('hidden');
    renderCatalogTab('mat');
  });

  document.getElementById('catalog-close').addEventListener('click', () => {
    document.getElementById('catalog-overlay').classList.add('hidden');
  });

  document.querySelectorAll('.catalog-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.catalog-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _catalogTab = btn.dataset.tab;
      renderCatalogTab(_catalogTab);
    });
  });

}


function renderCatalogTab(type) {
  const body = document.getElementById('catalog-body');
  if (type === 'excl')  { renderCatalogSimpleList(body, PRESET_EXCLUSIONS, 'excl',  'Omschrijving'); return; }
  if (type === 'check') { renderCatalogSimpleList(body, PRESET_CHECKLIST,  'check', 'Checklistpunt'); return; }

  const arr  = type === 'mat' ? PRESET_MATERIALS : PRESET_SERVICES;
  const isMat = type === 'mat';

  body.innerHTML = `
    <table class="catalog-table">
      <thead>
        <tr>
          <th style="width:28px"></th>
          <th>Naam</th>
          ${isMat
            ? `<th style="width:100px">Prijs (€)</th>`
            : `<th style="width:100px">Tarief (€/u)</th>`}
          <th style="width:32px"></th>
        </tr>
      </thead>
      <tbody id="catalog-tbody">
        ${arr.map((p, i) => renderCatalogRow(p, i, isMat)).join('')}
      </tbody>
    </table>
    <button class="catalog-add-btn" id="catalog-add-row">＋ Rij toevoegen</button>
  `;

  wireCatalogTable(type);
  wireCatalogDrag(type);

  document.getElementById('catalog-add-row').addEventListener('click', () => {
    const arr = type === 'mat' ? PRESET_MATERIALS : PRESET_SERVICES;
    if (type === 'mat') arr.push({ name: '', price: 0 });
    else arr.push({ name: '', rate: 0 });
    savePresets();
    renderCatalogTab(type);
    const rows = document.querySelectorAll('#catalog-tbody tr');
    const lastRow = rows[rows.length - 1];
    lastRow?.querySelector('input')?.focus();
  });
}

function renderCatalogSimpleList(body, arr, tabKey, placeholder) {
  body.innerHTML = `
    <table class="catalog-table">
      <thead><tr>
        <th style="width:28px"></th>
        <th>${escHtml(placeholder)}</th>
        <th style="width:32px"></th>
      </tr></thead>
      <tbody id="catalog-tbody">
        ${arr.map((item, i) => `
          <tr data-idx="${i}" draggable="true">
            <td class="drag-handle" title="Versleep">⠿</td>
            <td><input class="catalog-input" data-i="${i}" value="${escHtml(item)}" placeholder="${escHtml(placeholder)}" /></td>
            <td><button class="catalog-del" data-i="${i}" title="Verwijderen">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <button class="catalog-add-btn" id="catalog-add-row">＋ Rij toevoegen</button>
  `;

  const tbody = document.getElementById('catalog-tbody');
  tbody.querySelectorAll('.catalog-input').forEach(inp => {
    inp.addEventListener('input', () => {
      arr[parseInt(inp.dataset.i)] = inp.value;
      savePresets();
    });
  });
  tbody.querySelectorAll('.catalog-del').forEach(btn => {
    btn.addEventListener('click', () => {
      arr.splice(parseInt(btn.dataset.i), 1);
      savePresets();
      renderCatalogTab(tabKey);
    });
  });

  // Drag & drop
  let dragSrc = null;
  tbody.querySelectorAll('tr[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => { dragSrc = parseInt(row.dataset.idx); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over')); });
    row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over')); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drag-over');
      if (dragSrc === null) return;
      const tgt = parseInt(row.dataset.idx);
      if (dragSrc === tgt) return;
      const [moved] = arr.splice(dragSrc, 1);
      arr.splice(tgt, 0, moved);
      dragSrc = null; savePresets(); renderCatalogTab(tabKey);
    });
  });

  document.getElementById('catalog-add-row').addEventListener('click', () => {
    arr.push('');
    savePresets();
    renderCatalogTab(tabKey);
    const rows = document.querySelectorAll('#catalog-tbody tr');
    rows[rows.length - 1]?.querySelector('input')?.focus();
  });
}

function renderCatalogRow(p, i, isMat) {
  return `<tr data-idx="${i}" draggable="true">
    <td class="drag-handle" title="Versleep om te sorteren">⠿</td>
    <td><input class="catalog-input" data-i="${i}" data-f="name" value="${escHtml(p.name)}" placeholder="Naam" /></td>
    ${isMat
      ? `<td><input class="catalog-input catalog-input--sm num" data-i="${i}" data-f="price" type="number" min="0" step="any" value="${p.price || 0}" /></td>`
      : `<td><input class="catalog-input catalog-input--sm num" data-i="${i}" data-f="rate" type="number" min="0" step="any" value="${p.rate || 0}" /></td>`}
    <td><button class="catalog-del" data-i="${i}" title="Verwijderen">✕</button></td>
  </tr>`;
}

function wireCatalogTable(type) {
  const tbody = document.getElementById('catalog-tbody');
  if (!tbody) return;
  const arr = type === 'mat' ? PRESET_MATERIALS : PRESET_SERVICES;

  tbody.querySelectorAll('.catalog-input').forEach(inp => {
    if (inp.type === 'number') inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.i);
      const f = inp.dataset.f;
      if (!arr[i]) return;
      arr[i][f] = inp.type === 'number' ? (parseFloat(inp.value) || 0) : inp.value;
      savePresets();
    });
  });

  tbody.querySelectorAll('.catalog-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.i);
      arr.splice(i, 1);
      savePresets();
      renderCatalogTab(type);
    });
  });
}

function wireCatalogDrag(type) {
  const tbody = document.getElementById('catalog-tbody');
  if (!tbody) return;
  const arr = type === 'mat' ? PRESET_MATERIALS : PRESET_SERVICES;

  tbody.querySelectorAll('tr[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => {
      _catDragSrc = parseInt(row.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (_catDragSrc === null) return;
      const tgt = parseInt(row.dataset.idx);
      if (_catDragSrc === tgt) return;
      const [moved] = arr.splice(_catDragSrc, 1);
      arr.splice(tgt, 0, moved);
      _catDragSrc = null;
      savePresets();
      renderCatalogTab(type);
    });
  });
}

function wireSettings() {
  document.getElementById('settings-btn').onclick = async () => {
    const cfg = state.config || {};
    document.getElementById('cfg-name').value = cfg.name || '';
    document.getElementById('cfg-api-url').value = cfg.apiUrl || 'http://raspberrypi.local:5000';
    document.getElementById('cfg-projects-dir').value = cfg.localProjectsDir || '';
    document.getElementById('cfg-moneybird-token').value = cfg.moneybirdToken || '';
    document.getElementById('cfg-anthropic-token').value = cfg.anthropicToken || '';
    const theme = cfg.theme || 'light';
    document.querySelector(`input[name=theme][value=${theme}]`).checked = true;
    updateThemeCards(theme);
    document.getElementById('settings-modal').classList.remove('hidden');
  };

  document.getElementById('cfg-projects-dir-pick').onclick = async () => {
    toast('Selecteer de Projecten-map (de map die alle losse projectmappen bevat)', 'info', 4000);
    const dir = await api.openFolder();
    if (dir) {
      document.getElementById('cfg-projects-dir').value = dir;
      // Apply immediately so folder buttons work right away without reopening settings
      state.config = { ...state.config, localProjectsDir: dir };
      await api.configSet({ localProjectsDir: dir });
    }
  };

  document.getElementById('settings-cancel').onclick = () =>
    document.getElementById('settings-modal').classList.add('hidden');

  document.querySelectorAll('input[name=theme]').forEach(radio => {
    radio.addEventListener('change', () => {
      applyTheme(radio.value);
      updateThemeCards(radio.value);
    });
  });

  document.getElementById('settings-save').onclick = async () => {
    const theme = document.querySelector('input[name=theme]:checked')?.value || 'light';
    const typedToken = document.getElementById('cfg-moneybird-token').value.trim();
    if (typedToken) _moneybirdAdminId = null; // reset cache on token change
    const typedAnthropicToken = document.getElementById('cfg-anthropic-token').value.trim();
    const newConfig = {
      ...state.config,                           // preserve caldav, localProjectsDir, etc.
      name: document.getElementById('cfg-name').value.trim() || state.config?.name || '',
      mode: 'api',
      apiUrl: document.getElementById('cfg-api-url').value.trim(),
      theme,
      localProjectsDir: document.getElementById('cfg-projects-dir').value.trim() || state.config?.localProjectsDir || '',
      // Keep existing token when field left blank
      moneybirdToken: typedToken || state.config?.moneybirdToken || '',
      anthropicToken: typedAnthropicToken || state.config?.anthropicToken || '',
    };
    await api.configSet(newConfig);
    state.config = newConfig;
    document.getElementById('sidebar-user').textContent = newConfig.name;
    document.getElementById('settings-modal').classList.add('hidden');
    await loadAll();
    renderView();
    startApiPolling();
    toast('Instellingen opgeslagen');
  };

  document.getElementById('settings-modal').addEventListener('mousedown', e => {
    if (e.target === document.getElementById('settings-modal'))
      document.getElementById('settings-modal').classList.add('hidden');
  });

  function updateThemeCards(theme) {
    document.getElementById('radio-light').classList.toggle('selected', theme === 'light');
    document.getElementById('radio-dark').classList.toggle('selected', theme === 'dark');
  }
}

/* ─── Setup Wizard ─────────────────────────────────────────────────────────── */
function showWizard() {
  document.getElementById('wizard-overlay').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
  wizardGoto(0);
}

function showApp() {
  document.getElementById('wizard-overlay').classList.add('hidden');
  document.getElementById('app').style.display = 'flex';
  document.getElementById('sidebar-user').textContent = state.config?.name || '';
}

let wizardFilePath = null;

function wizardGoto(step) {
  document.querySelectorAll('.wizard-step').forEach((s, i) => s.classList.toggle('active', i === step));
  document.querySelectorAll('.step-dot').forEach((d, i) => d.classList.toggle('done', i <= step));
}

function wireWizard() {
  if (window.__WEB_MODE__) {
    document.getElementById('wiz-next-0').onclick = async () => {
      const name = document.getElementById('wiz-name').value.trim();
      if (!name) { shake(document.getElementById('wiz-name')); return; }
      const config = { name, mode: 'api', apiUrl: window.location.origin };
      await api.configSet(config);
      state.config = config;
      showApp(); await loadAll(); renderView();
    };
    return;
  }

  document.getElementById('wiz-next-0').onclick = () => {
    const name = document.getElementById('wiz-name').value.trim();
    if (!name) { shake(document.getElementById('wiz-name')); return; }
    wizardGoto(1);
  };

  document.getElementById('wiz-back-1').onclick = () => wizardGoto(0);

  document.getElementById('wiz-pick-folder').onclick = async () => {
    const folder = await api.openFolder();
    if (folder) {
      wizardFilePath = folder + '/project-manager.db';
      document.getElementById('wiz-path-display').textContent = wizardFilePath;
    }
  };

  document.getElementById('wiz-next-1').onclick = () => {
    if (!wizardFilePath) { toast('Selecteer eerst een map'); return; }
    document.getElementById('wiz-final-path').textContent = wizardFilePath;
    wizardGoto(2);
  };

  document.getElementById('wiz-finish').onclick = async () => {
    const name = document.getElementById('wiz-name').value.trim();
    const config = {
      name,
      mode: 'file',
      filePath: wizardFilePath,
      apiUrl: 'http://raspberrypi.local:5000',
    };
    await api.configSet(config);
    state.config = config;
    showApp();
    await loadAll();
    renderView();
  };
}

/* ─── Navigation ───────────────────────────────────────────────────────────── */
function wireNav() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.cursor = new Date(state.today);
      let view = btn.dataset.view;
      if (view === 'calendar') {
        const prefs = loadCalPrefs();
        view = prefs.view || 'monthly';
        if (prefs.filter) Object.assign(state.calFilter, prefs.filter);
      }
      setView(view);
    });
  });

  document.getElementById('refresh-btn').onclick = async () => {
    await api.refresh();
    await loadAll();
    renderView();
    toast('Refresh');
  };

  document.getElementById('hamburger-btn')?.addEventListener('click', () =>
    document.getElementById('sidebar').classList.add('open'));
  document.getElementById('sidebar-close-btn')?.addEventListener('click', () =>
    document.getElementById('sidebar').classList.remove('open'));
  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () =>
      document.getElementById('sidebar').classList.remove('open')));
}

/* ─── Color Swatches ───────────────────────────────────────────────────────── */
function buildColorSwatches() {
  const container = document.getElementById('task-color-swatches');
  COLORS.forEach((color, i) => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (i === 0 ? ' selected' : '');
    sw.style.background = color;
    sw.dataset.color = color;
    sw.title = color;
    sw.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    container.appendChild(sw);
  });
}

/* ─── Helpers ──────────────────────────────────────────────────────────────── */
// Returns the display color for a task: project color if assigned, else own color
function contrastColor(hex) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return '#fff';
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return (0.299*r + 0.587*g + 0.114*b) / 255 > 0.55 ? '#1a1a1a' : '#fff';
}

function taskColor(task) {
  if (task.project_id) {
    const proj = state.projects.find(p => p.id == task.project_id);
    if (proj?.color) return proj.color;
  }
  return task.color || '#4f8ef7';
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ─── Dutch public holidays ─────────────────────────────────────────────────── */
const _holidayCache = {};

function getEaster(year) {
  const a = year % 19, b = Math.floor(year/100), c = year%100;
  const d = Math.floor(b/4), e = b%4, f = Math.floor((b+8)/25);
  const g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15)%30;
  const i = Math.floor(c/4), k = c%4, l = (32+2*e+2*i-h-k)%7;
  const mm = Math.floor((a+11*h+22*l)/451);
  const month = Math.floor((h+l-7*mm+114)/31);
  const day = ((h+l-7*mm+114)%31)+1;
  return new Date(year, month-1, day);
}

function getDutchHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const e = getEaster(year);
  const add = (base, n) => { const r = new Date(base); r.setDate(r.getDate()+n); return r; };
  let koningsdag = new Date(year, 3, 27);
  if (koningsdag.getDay() === 0) koningsdag = new Date(year, 3, 26);
  _holidayCache[year] = {
    [toDateStr(new Date(year,0,1))]:   'Nieuwjaarsdag',
    [toDateStr(add(e,-2))]:            'Goede Vrijdag',
    [toDateStr(e)]:                    '1e Paasdag',
    [toDateStr(add(e,1))]:             '2e Paasdag',
    [toDateStr(koningsdag)]:           'Koningsdag',
    [toDateStr(new Date(year,4,5))]:   'Bevrijdingsdag',
    [toDateStr(add(e,39))]:            'Hemelvaartsdag',
    [toDateStr(add(e,49))]:            '1e Pinksterdag',
    [toDateStr(add(e,50))]:            '2e Pinksterdag',
    [toDateStr(new Date(year,11,25))]: '1e Kerstdag',
    [toDateStr(new Date(year,11,26))]: '2e Kerstdag',
  };
  return _holidayCache[year];
}

function formatDateLong(date) {
  return date.toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtStatus(s) {
  return { pending: 'Openstaand', in_progress: 'In uitvoering', done: 'Afgerond' }[s] || s;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function toast(msg, type = 'info', ms = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('toast-error');
  if (type === 'error') { el.classList.add('toast-error'); ms = 4000; }
  el.classList.add('show');
  setTimeout(() => { el.classList.remove('show', 'toast-error'); }, ms);
}

function shake(el) {
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.borderColor = 'var(--red)';
  setTimeout(() => { el.style.borderColor = ''; }, 1000);
}

/* ─── Quote Presets ─────────────────────────────────────────────────────────── */
const DEFAULT_PRESET_MATERIALS = [
  { name: 'Polyurea',    price: 0 },
  { name: 'Spuiten',     price: 0 },
  { name: 'Grafisch',    price: 0 },
  { name: 'Stickeren',   price: 0 },
  { name: 'Folie',       price: 0 },
  { name: 'Primer',      price: 0 },
  { name: 'Verf',        price: 0 },
  { name: 'Hout / MDF',  price: 0 },
  { name: 'Staal',       price: 0 },
  { name: 'Bevestiging', price: 0 },
  { name: 'Transport',   price: 0 },
  { name: 'Overig',      price: 0 },
];

const DEFAULT_PRESET_SERVICES = [
  { name: 'Tekenen',            rate: 0 },
  { name: '3D modelleren',      rate: 0 },
  { name: '3D frezen',          rate: 0 },
  { name: 'CNC frezen',         rate: 0 },
  { name: 'Werkplaats',         rate: 0 },
  { name: 'Spuiten',            rate: 0 },
  { name: 'Projectbegeleiding', rate: 0 },
  { name: 'Advies',             rate: 0 },
];

// ─── Dynamic presets (loaded from localStorage, fall back to defaults) ──────

let PRESET_MATERIALS = [];
let PRESET_SERVICES  = [];
let PRESET_EXCLUSIONS = [];
let PRESET_CHECKLIST  = [];

async function loadPresets() {
  try {
    if (state.config?.mode === 'api' && state.config?.apiUrl) {
      const r = await api.apiFetch({ method: 'GET', url: `${state.config.apiUrl}/api/presets` });
      if (r.status < 400 && Array.isArray(r.data) && r.data.length > 0) {
        PRESET_MATERIALS  = r.data.filter(p => p.category === 'mat').map(p => ({ name: p.name, price: p.price }));
        PRESET_SERVICES   = r.data.filter(p => p.category === 'svc').map(p => ({ name: p.name, rate: p.price }));
        PRESET_EXCLUSIONS = r.data.filter(p => p.category === 'excl').map(p => p.name);
        PRESET_CHECKLIST  = r.data.filter(p => p.category === 'check').map(p => p.name);
        if (PRESET_CHECKLIST.length === 0) PRESET_CHECKLIST = [...DEFAULT_CHECKLIST];
        // Cache locally as fallback
        localStorage.setItem('presets_mat', JSON.stringify(PRESET_MATERIALS));
        localStorage.setItem('presets_svc', JSON.stringify(PRESET_SERVICES));
        localStorage.setItem('presets_excl', JSON.stringify(PRESET_EXCLUSIONS));
        localStorage.setItem('presets_check', JSON.stringify(PRESET_CHECKLIST));
        return;
      }
    }
  } catch (_) { /* fall through to localStorage */ }

  // Fallback: localStorage or defaults
  try {
    const mat = localStorage.getItem('presets_mat');
    const svc = localStorage.getItem('presets_svc');
    const excl = localStorage.getItem('presets_excl');
    PRESET_MATERIALS  = mat  ? JSON.parse(mat)  : DEFAULT_PRESET_MATERIALS.map(p => ({ ...p }));
    PRESET_SERVICES   = svc  ? JSON.parse(svc)  : DEFAULT_PRESET_SERVICES.map(p => ({ ...p }));
    PRESET_EXCLUSIONS = excl ? JSON.parse(excl) : [...DEFAULT_EXCLUSIONS];
    const chk = localStorage.getItem('presets_check');
    PRESET_CHECKLIST  = chk  ? JSON.parse(chk)  : [...DEFAULT_CHECKLIST];
  } catch (_) {
    PRESET_MATERIALS  = DEFAULT_PRESET_MATERIALS.map(p => ({ ...p }));
    PRESET_SERVICES   = DEFAULT_PRESET_SERVICES.map(p => ({ ...p }));
    PRESET_EXCLUSIONS = [...DEFAULT_EXCLUSIONS];
    PRESET_CHECKLIST  = [...DEFAULT_CHECKLIST];
  }
}

async function savePresets() {
  // Save locally as cache
  localStorage.setItem('presets_mat', JSON.stringify(PRESET_MATERIALS));
  localStorage.setItem('presets_svc', JSON.stringify(PRESET_SERVICES));
  localStorage.setItem('presets_excl', JSON.stringify(PRESET_EXCLUSIONS));
  localStorage.setItem('presets_check', JSON.stringify(PRESET_CHECKLIST));

  // Sync to Pi
  if (state.config?.mode === 'api' && state.config?.apiUrl) {
    const items = [
      ...PRESET_MATERIALS.map((p, i) => ({ category: 'mat', name: p.name, price: p.price || 0, sort_order: i })),
      ...PRESET_SERVICES.map((p, i)  => ({ category: 'svc', name: p.name, price: p.rate || 0, sort_order: i })),
      ...PRESET_EXCLUSIONS.map((ex, i) => ({ category: 'excl', name: ex, price: 0, sort_order: i })),
      ...PRESET_CHECKLIST.map((ch, i) => ({ category: 'check', name: ch, price: 0, sort_order: i })),
    ];
    try {
      await api.apiFetch({ method: 'PUT', url: `${state.config.apiUrl}/api/presets`, body: { items } });
    } catch (err) {
      console.warn('Failed to sync presets to Pi:', err);
    }
  }
}

// ─── Klanten View ─────────────────────────────────────────────────────────────

function renderKlanten() {
  document.getElementById('toolbar-title').textContent = 'Klanten';
  document.getElementById('toolbar-controls').innerHTML =
    `<button class="btn btn-primary btn-sm" id="klant-add-btn">+ Nieuwe klant</button>`;
  document.getElementById('klant-add-btn').onclick = () => openKlantModal(null);

  const content = document.getElementById('content');
  if (!state.clients.length) {
    content.innerHTML = `
      <div class="empty-state">
        <p>Nog geen klanten.</p>
        <p>Voeg een klant toe via de knop hierboven, of sla klantgegevens op vanuit een offerte.</p>
      </div>`;
    return;
  }

  content.innerHTML = `<div class="klanten-grid">${state.clients.map(c => `
    <div class="klant-card" data-id="${c.id}">
      <div class="klant-card-header">
        <div class="klant-name">${escHtml(c.name)}</div>
      </div>
      ${c.contact  ? `<div class="klant-row"><span class="klant-icon">👤</span>${escHtml(c.contact)}</div>` : ''}
      ${c.address  ? `<div class="klant-row"><span class="klant-icon">📍</span>${escHtml(c.address)}${c.postcode ? ', ' + escHtml(c.postcode) : ''}</div>` : ''}
      ${c.email    ? `<div class="klant-row"><span class="klant-icon">✉</span><a href="mailto:${escHtml(c.email)}" onclick="event.stopPropagation()">${escHtml(c.email)}</a></div>` : ''}
      ${c.phone    ? `<div class="klant-row"><span class="klant-icon">📞</span>${escHtml(c.phone)}</div>` : ''}
      ${c.notes    ? `<div class="klant-notes">${escHtml(c.notes)}</div>` : ''}
      <div class="klant-quote-count">${state.clients && (() => {
        const n = 0; return ''; // quotes not linked by FK, skip count for now
      })()}</div>
    </div>`).join('')}</div>`;

  content.querySelectorAll('.klant-card').forEach(card => {
    card.addEventListener('click', () => {
      const client = state.clients.find(c => c.id === parseInt(card.dataset.id));
      if (client) openKlantModal(client);
    });
  });
}

let _editingClient = null;

function openKlantModal(client) {
  _editingClient = client || null;
  document.getElementById('klant-modal-title').textContent = client ? 'Klant bewerken' : 'Klant toevoegen';
  document.getElementById('klant-name').value    = client?.name    || '';
  document.getElementById('klant-contact').value = client?.contact || '';
  document.getElementById('klant-address').value = client?.address || '';
  document.getElementById('klant-postcode').value= client?.postcode|| '';
  document.getElementById('klant-email').value   = client?.email   || '';
  document.getElementById('klant-phone').value   = client?.phone   || '';
  document.getElementById('klant-notes').value   = client?.notes   || '';
  document.getElementById('klant-delete').classList.toggle('hidden', !client);
  document.getElementById('klant-modal').classList.remove('hidden');
  document.getElementById('klant-name').focus();
}

function closeKlantModal() {
  document.getElementById('klant-modal').classList.add('hidden');
  _editingClient = null;
}

function wireKlantModal() {
  document.getElementById('klant-cancel').onclick = closeKlantModal;

  document.getElementById('klant-save').onclick = async () => {
    const name = document.getElementById('klant-name').value.trim();
    if (!name) { shake(document.getElementById('klant-name')); return; }
    const data = {
      name,
      contact:  document.getElementById('klant-contact').value.trim(),
      address:  document.getElementById('klant-address').value.trim(),
      postcode: document.getElementById('klant-postcode').value.trim(),
      email:    document.getElementById('klant-email').value.trim(),
      phone:    document.getElementById('klant-phone').value.trim(),
      notes:    document.getElementById('klant-notes').value.trim(),
    };
    if (_editingClient) {
      await remoteQuery({ action: 'update', table: 'clients', data, where: { id: _editingClient.id } });
      toast('Klant bijgewerkt');
    } else {
      await remoteQuery({ action: 'insert', table: 'clients', data });
      toast('Klant toegevoegd');
    }
    await loadClients();
    closeKlantModal();
    if (state.view === 'klanten') renderKlanten();
  };

  document.getElementById('klant-delete').onclick = async () => {
    if (!_editingClient) return;
    if (!confirm(`Klant "${_editingClient.name}" verwijderen?`)) return;
    await remoteQuery({ action: 'delete', table: 'clients', where: { id: _editingClient.id } });
    toast('Klant verwijderd');
    await loadClients();
    closeKlantModal();
    if (state.view === 'klanten') renderKlanten();
  };
}

// ─── Bedrijfsanalyse View ──────────────────────────────────────────────────────

let _bizSnapshot = null;

async function renderBedrijfsanalyse() {
  document.getElementById('toolbar-title').textContent = 'Bedrijfsanalyse';
  document.getElementById('toolbar-controls').innerHTML = '';
  const content = document.getElementById('content');

  if (!state.config?.moneybirdToken || !state.config?.anthropicToken) {
    content.innerHTML = `
      <div class="empty-state">
        <p>Bedrijfsanalyse heeft zowel een Moneybird- als een Anthropic API-sleutel nodig.</p>
        <p>Ga naar Instellingen om deze in te stellen.</p>
      </div>`;
    return;
  }

  content.innerHTML = `<div class="biz-dashboard"><div class="biz-loading">⏳ Bedrijfscijfers ophalen…</div></div>`;

  let snap;
  try {
    snap = await computeBusinessSnapshot();
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>Kon bedrijfscijfers niet ophalen: ${escHtml(e.message || String(e))}</p></div>`;
    return;
  }
  if (state.view !== 'analyse') return; // user navigated away while loading
  _bizSnapshot = snap;
  renderBizDashboardContent(snap);
}

// Bouwt de <ul> voor een follow-up-herinneringskaart (offertes op "later" of verzonden
// zonder reactie) — beide gebruiken hetzelfde snooze-mechanisme, alleen een ander
// "sinds"-veld en snooze-veld in de database. Geeft null terug als de lijst leeg is,
// zodat de aanroeper zelf de leeg-state-tekst kan tonen.
function reminderListHtml(list, sinceField, snoozeField, labelFn) {
  if (!list.length) return null;
  return `<ul class="biz-reminders-list">${list.map(q => {
    const since = q[sinceField] ? new Date(q[sinceField]) : new Date(q.created_at || q.quote_date);
    q.__ageDays = Math.floor((Date.now() - since) / 86400000);
    return `<li>
      <span>${escHtml(q.name)} — ${labelFn(q)} (${fmtEur(q.total_price)})</span>
      <div class="biz-snooze-controls">
        <select class="biz-snooze-select" data-id="${q.id}" data-field="${snoozeField}">
          <option value="" selected disabled>😴 Snooze…</option>
          <option value="1d">1 dag</option>
          <option value="1w">1 week</option>
          <option value="1m">1 maand</option>
          <option value="custom">📅 Specifieke datum…</option>
        </select>
        <input type="date" class="biz-snooze-date hidden" data-id="${q.id}" />
        <button class="btn btn-secondary btn-sm biz-snooze-apply hidden" data-id="${q.id}">Snooze</button>
      </div>
    </li>`;
  }).join('')}</ul>`;
}

// Beste-gok suggestie voor handmatig koppelen van een niet-gematcht Moneybird-project
// aan een project in deze app — simpele woord-overlap/substring-score, geen externe
// libs nodig voor dit soort eenmalige, door de gebruiker te bevestigen suggesties.
function guessProjectMatch(mbName, localProjects) {
  const norm = s => s.toLowerCase().trim();
  const mbNorm = norm(mbName);
  const mbWords = mbNorm.split(/\s+/).filter(Boolean);
  let best = null, bestScore = 0;
  localProjects.forEach(p => {
    const pNorm = norm(p.name);
    const pWords = pNorm.split(/\s+/).filter(Boolean);
    let score = mbWords.filter(w => pWords.includes(w)).length;
    if (pNorm.includes(mbNorm) || mbNorm.includes(pNorm)) score += 5;
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return bestScore > 0 ? best : null;
}

// Dropdown om een niet-gematcht Moneybird-project handmatig aan een project in deze
// app te koppelen — beste gok staat als eerste, niet-placeholder optie bovenin.
function unmatchedCostLinkHtml(c) {
  const suggestion = guessProjectMatch(c.name, state.projects || []);
  const rest = (state.projects || [])
    .filter(p => p.id !== suggestion?.id)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<select class="biz-link-mb-project" data-mb-id="${escHtml(String(c.mbProjectId))}">
    <option value="" selected disabled>🔗 Koppel aan project…</option>
    ${suggestion ? `<option value="${suggestion.id}">⭐ ${escHtml(suggestion.name)} (suggestie)</option>` : ''}
    ${rest.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('')}
  </select>`;
}

function renderBizDashboardContent(snap) {
  const content = document.getElementById('content');
  const cached = loadCachedInsights();
  const warnings = computeWarnings(snap);
  const score = computeBusinessScore(snap);

  const now = new Date();
  const dayOfMonth = now.getDate();
  // Vergelijk met een evenredig deel van vorige maand zodat dag 10 eerlijk is t.o.v. dag 10
  const daysInLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const lastMonthProrated = snap.lastMonthRevenue * (dayOfMonth / daysInLastMonth);
  const revChangePct = dayOfMonth <= 3 ? null : pctChange(snap.thisMonthRevenue, lastMonthProrated);
  // Voor openstaande facturen is een dáling juist positief, dus het teken omdraaien.
  const outChangePct = pctChange(snap.outstanding.sum, snap.outstandingLastMonth.sum);

  const chgBadge = (pct, invert = false) => {
    if (pct == null) return '';
    const good = invert ? pct <= 0 : pct >= 0;
    return `<span class="biz-chg ${good ? 'biz-chg-up' : 'biz-chg-down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
  };

  const maxTrend = Math.max(1, ...snap.revenueTrend6mo.map(m => m.total));

  content.innerHTML = `
  <div class="biz-dashboard">
    <div class="biz-toprow">
      <button class="btn btn-secondary btn-sm" id="biz-refresh-btn">🔄 Vernieuw analyse</button>
      <span class="biz-updated-at">${cached ? 'AI-analyse van ' + fmtDateTime(cached.generatedAt) : 'Nog geen AI-analyse gegenereerd'}</span>
    </div>

    <div class="biz-advice-banner">
      ${cached?.advice
        ? `<div class="biz-advice-tag">📌 Belangrijkste advies</div><div class="biz-advice-text">Mijn advies: ${escHtml(cached.advice)}</div>`
        : `<span class="biz-advice-empty">Klik op "Vernieuw analyse" voor een AI-advies op basis van je actuele cijfers.</span>`}
    </div>

    <div class="biz-kpi-grid">
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">📈 Omzet deze maand</div>
        <div class="biz-kpi-value">${snap.moneybirdError ? '—' : fmtEur(snap.thisMonthRevenue)} ${chgBadge(revChangePct)}</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">🗓️ Omzet dit jaar</div>
        <div class="biz-kpi-value">${snap.moneybirdError ? '—' : fmtEur(snap.revenueYTD)}</div>
        <div class="biz-kpi-sub">Gefactureerd t/m vandaag</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">✦ Winst dit jaar</div>
        <div class="biz-kpi-value">${snap.moneybirdError || snap.costsYTD == null ? '—' : fmtEur(snap.profitYTD)}</div>
        <div class="biz-kpi-sub">Omzet min inkoopkosten, excl. btw</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">💰 Openstaande facturen</div>
        <div class="biz-kpi-value">${snap.moneybirdError ? '—' : fmtEur(snap.outstanding.sum)} ${chgBadge(outChangePct, /*invert=*/true)}</div>
        <div class="biz-kpi-sub">${snap.moneybirdError ? 'Moneybird niet bereikbaar' : `${snap.outstanding.count} facturen${snap.overdueCount ? `, ${snap.overdueCount} te laat` : ''}`}</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">📂 Lopende projecten</div>
        <div class="biz-kpi-value">${snap.activeProjects.length}</div>
        <div class="biz-kpi-sub">${snap.unplannedProjects.length ? `waarvan ${snap.unplannedProjects.length} nog niet ingepland` : ''}</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">📋 Openstaande offertes</div>
        <div class="biz-kpi-value">${fmtEur(snap.openQuotesValue)}</div>
        <div class="biz-kpi-sub">${snap.openQuotes.length} aanvragen${snap.openQuoteVariantsIgnored ? `<br>${snap.openQuoteVariantsIgnored} variant${snap.openQuoteVariantsIgnored === 1 ? '' : 'en'} niet dubbel geteld` : ''}${snap.laterQuotes.length ? `<br>+ ${snap.laterQuotes.length} op "later" (${fmtEur(snap.laterQuotesValue)}, niet meegeteld)` : ''}</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">📅 Orderportefeuille</div>
        <div class="biz-kpi-value">${fmtEur(snap.orderportefeuille)}</div>
        <div class="biz-kpi-sub">${snap.acceptedQuotes.length} geaccepteerde offertes${snap.fulfilledQuotes.length ? `<br>+ ${snap.fulfilledQuotes.length} afgerond (${fmtEur(snap.fulfilledQuotesValue)}, al geleverd, niet meegeteld)` : ''}</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">⏱️ Effectief uurloon (dit jaar)</div>
        <div class="biz-kpi-value">${snap.effectiveHourlyRate != null ? fmtEur(snap.effectiveHourlyRate) + '/u' : '—'}</div>
        <div class="biz-kpi-sub">${snap.effectiveHourlyRate != null
          ? `${fmtEur(snap.profitYTD)} winst ÷ ${Math.round(snap.hoursYTD)} u (2 man, t/m nu)`
          : (snap.moneybirdError ? 'Moneybird niet bereikbaar' : 'Geen kostendata beschikbaar')}</div>
      </div>
      <div class="biz-kpi-card">
        <div class="biz-kpi-label">📊 Winstmarge (dit jaar)</div>
        ${(() => {
          const margin = (snap.revenueYTD && snap.costsYTD != null && snap.revenueYTD > 0)
            ? (snap.profitYTD / snap.revenueYTD) * 100 : null;
          return `<div class="biz-kpi-value">${margin != null ? margin.toFixed(1) + '%' : '—'}</div>
          <div class="biz-kpi-sub">${margin != null
            ? `${fmtEur(snap.profitYTD)} winst op ${fmtEur(snap.revenueYTD)} omzet`
            : (snap.moneybirdError ? 'Moneybird niet bereikbaar' : 'Geen kostendata beschikbaar')}</div>`;
        })()}
      </div>
    </div>

    <div class="biz-secondary-grid">
      <div class="biz-score-card">
        <div class="biz-card-title">🎯 Bedrijfsscore</div>
        <div class="biz-score-value">${score.total.toFixed(1)}<span class="biz-score-max">/10</span></div>
        <div class="biz-score-breakdown">
          ${Object.entries(score.breakdown).map(([k, v]) => {
            let sub = '';
            if (k === 'cashflow' && !snap.moneybirdError && snap.avgMonthlyRevenue3mo > 0) {
              const ratio = snap.outstanding.sum / snap.avgMonthlyRevenue3mo;
              sub = `<span class="biz-score-row-sub">${fmtEur(snap.outstanding.sum)} openstaand = ${ratio.toFixed(1)}× maandomzet</span>`;
            }
            if (k === 'facturen' && !snap.moneybirdError) {
              sub = snap.overdueCount > 0
                ? `<span class="biz-score-row-sub">${snap.overdueCount} factuur${snap.overdueCount !== 1 ? 'en' : ''} ouder dan 30 dagen onbetaald</span>`
                : `<span class="biz-score-row-sub">Alle facturen binnen 30 dagen</span>`;
            }
            if (k === 'orderportefeuille' && snap.avgMonthlyRevenue3mo > 0) {
              const months = snap.orderportefeuille / snap.avgMonthlyRevenue3mo;
              sub = `<span class="biz-score-row-sub">${fmtEur(snap.orderportefeuille)} = ${months.toFixed(1)} maand dekking</span>`;
            }
            return `<div class="biz-score-row">
              <span class="biz-score-row-label">${BIZ_SCORE_LABELS[k] || k}${sub}</span>
              <div class="biz-score-bar"><div class="biz-score-bar-fill" style="width:${v * 10}%"></div></div>
              <span class="biz-score-row-val">${v.toFixed(1)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="biz-warnings-card">
        <div class="biz-card-title">⚠️ Aandachtspunten</div>
        ${warnings.length
          ? `<ul class="biz-warnings-list">${warnings.map(w => `<li>${w.icon} ${escHtml(w.text)}</li>`).join('')}</ul>`
          : `<p class="biz-empty-sub">Geen bijzonderheden — alles ziet er gezond uit.</p>`}
      </div>
    </div>

    <div class="biz-reminders-card">
      <div class="biz-card-title">🔔 Follow-up: offertes op "later"</div>
      ${reminderListHtml(snap.staleLaterQuotes, 'later_since', 'later_snoozed_until', q => `al ${q.__ageDays} dagen op "later"`)
        || `<p class="biz-empty-sub">Geen "later"-offertes die langer dan ${BIZ_THRESHOLDS.laterReminderDays} dagen wachten op een follow-up.</p>`}
    </div>

    <div class="biz-reminders-card">
      <div class="biz-card-title">🔔 Follow-up: verzonden offertes</div>
      ${reminderListHtml(snap.staleSentQuotes, 'sent_since', 'sent_snoozed_until', q => `al ${q.__ageDays} dagen verzonden, geen reactie`)
        || `<p class="biz-empty-sub">Geen verzonden offertes die langer dan ${BIZ_THRESHOLDS.sentReminderDays} dagen wachten op een reactie.</p>`}
    </div>

    <div class="biz-trend-card">
      <div class="biz-card-title">📊 Omzettrend (laatste 6 maanden)</div>
      ${snap.moneybirdError
        ? `<p class="biz-empty-sub">Moneybird-data niet beschikbaar.</p>`
        : `<div class="biz-trend-bars">
            ${snap.revenueTrend6mo.map(m => `
              <div class="biz-trend-col">
                <div class="biz-trend-bar-track"><div class="biz-trend-bar" style="height:${Math.max(2, (m.total / maxTrend) * 100)}%" title="${fmtEur(m.total)}"></div></div>
                <div class="biz-trend-label">${m.label}</div>
              </div>`).join('')}
          </div>`}
    </div>

    <div class="biz-trend-card">
      <div class="biz-card-title">⏱️ Uurloon trend (laatste 6 maanden)</div>
      ${snap.moneybirdError || !snap.hourlyRateTrend6mo.length
        ? `<p class="biz-empty-sub">Moneybird-data niet beschikbaar.</p>`
        : (() => {
            const rates = snap.hourlyRateTrend6mo.map(m => m.rate);
            const avgs  = snap.hourlyRateTrend6mo.map(m => m.avg3mo);
            const maxVal = Math.max(1, ...rates.map(Math.abs), ...avgs.map(Math.abs));
            const toH = v => Math.max(2, (Math.abs(v) / maxVal) * 100);
            return `<div class="biz-trend-bars">
              ${snap.hourlyRateTrend6mo.map(m => `
                <div class="biz-trend-col">
                  <div class="biz-trend-bar-track biz-trend-bar-track--dual">
                    <div class="biz-trend-bar${m.rate < 0 ? ' biz-trend-bar--neg' : ''}" style="height:${toH(m.rate)}%" title="${fmtEur(m.rate)}/u"></div>
                    <div class="biz-trend-avg-line" style="bottom:${toH(m.avg3mo)}%" title="3mnd gem: ${fmtEur(m.avg3mo)}/u"></div>
                  </div>
                  <div class="biz-trend-label">${m.label}</div>
                  <div class="biz-trend-val${m.rate < 0 ? ' biz-trend-val--neg' : ''}">${fmtEur(m.rate)}</div>
                </div>`).join('')}
            </div>
            <div class="biz-trend-legend"><span class="biz-trend-legend-avg">— 3 mnd gemiddelde</span></div>`;
          })()}
    </div>

    <div class="biz-costs-card">
      <div class="biz-card-title">📊 Winst per project: prognose vs. daadwerkelijk</div>
      ${snap.costsError
        ? `<p class="biz-empty-sub">Moneybird-kosten/projectdata niet beschikbaar.</p>`
        : (snap.projectMargins.length || snap.activeProjectMargins.length || snap.unmatchedProjectCosts.length || snap.explicitMbLinks.length)
          ? `<div class="pm-table">
              ${(() => {
                const cur = localStorage.getItem('pm_sort') || 'winst';
                const dir = localStorage.getItem('pm_sort_dir') || 'desc';
                const hdr = (s, label) => {
                  const active = cur === s;
                  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
                  return `<button class="pm-hdr-btn pm-sort-btn${active?' pm-sort-active':''}" data-sort="${s}">${label}${arrow}</button>`;
                };
                return `<div class="pm-row pm-hdr">
                <span class="pm-hdr-name-cell">${hdr('name','Naam')} ${hdr('date','Datum')}</span>
                <span>${hdr('prognose','Prognose')}</span>
                <span>${hdr('gefactureerd','Gefactureerd')}</span>
                <span>${hdr('marge','Marge %')}</span>
                <span>${hdr('vsprognose','vs. prognose')}</span>
                <span>${hdr('winst','Winst')}</span>
              </div>`;
              })()}
              ${(() => {
                const sortKey = localStorage.getItem('pm_sort') || 'winst';
                const sortDir = localStorage.getItem('pm_sort_dir') || 'desc';
                const d = sortDir === 'asc' ? -1 : 1;
                const sortFn = (a, b) => {
                  if (sortKey === 'name') { const r = a.name.localeCompare(b.name, 'nl'); return d * r; }
                  if (sortKey === 'date') { const r = (a.startDate || '').localeCompare(b.startDate || ''); return d * r; }
                  if (sortKey === 'prognose') return d * ((b.estimatedProfit || 0) - (a.estimatedProfit || 0));
                  if (sortKey === 'gefactureerd') return d * ((b.actualRevenue || 0) - (a.actualRevenue || 0));
                  if (sortKey === 'marge') {
                    const ma = a.actualRevenue > 0 ? a.actualProfit / a.actualRevenue : null;
                    const mb2 = b.actualRevenue > 0 ? b.actualProfit / b.actualRevenue : null;
                    if (ma === null && mb2 === null) return 0;
                    if (ma === null) return 1; if (mb2 === null) return -1;
                    return d * (mb2 - ma);
                  }
                  if (sortKey === 'winst') return d * ((b.actualProfit || 0) - (a.actualProfit || 0));
                  // vsprognose (en legacy 'margin') — nulls altijd onderaan
                  if (a.profitRatioPct === null && b.profitRatioPct === null) return 0;
                  if (a.profitRatioPct === null) return 1;
                  if (b.profitRatioPct === null) return -1;
                  return d * (b.profitRatioPct - a.profitRatioPct);
                };
                const ackedProjects = new Set(JSON.parse(localStorage.getItem('biz_acknowledged_projects') || '[]'));
                return [...snap.projectMargins].sort(sortFn).map(m => {
                const acked = ackedProjects.has(m.name);
                const delta = m.profitRatioPct === null ? null : m.profitRatioPct - 100;
                const pctClass = acked ? 'biz-margin-ack' : (delta === null ? '' : delta < -50 ? 'biz-margin-bad' : delta < -10 ? 'biz-margin-warn' : 'biz-margin-good');
                const profitClass = acked ? 'biz-margin-ack' : (m.actualProfit < 0 ? 'biz-margin-bad' : 'biz-margin-good');
                const revenueMargePct = m.actualRevenue > 0 ? (m.actualProfit / m.actualRevenue) * 100 : null;
                const margeClass = acked ? 'biz-margin-ack' : (revenueMargePct === null ? '' : revenueMargePct < 0 ? 'biz-margin-bad' : revenueMargePct < 20 ? 'biz-margin-warn' : 'biz-margin-good');
                const notActual = !m.revenueIsActual ? ' <span class="biz-margin-note" title="Nog geen omzet getagd in Moneybird — offertebedrag als schatting">*</span>' : '';
                const colEst  = m.hasQuote ? fmtEur(m.estimatedProfit) : '—';
                const colGef  = `${fmtEur(m.actualRevenue)}${notActual}`;
                const colMrg  = revenueMargePct !== null ? `<span class="${margeClass}">${revenueMargePct.toFixed(0)}%</span>` : '—';
                const colVsPr = m.profitRatioPct !== null ? `<span class="pm-pct ${pctClass}">${fmtProfitDelta(m.profitRatioPct)}</span>` : '—';
                const colWst  = `<span class="pm-actual ${profitClass}">${fmtEur(m.actualProfit)}</span>`;
                const lessonButton = m.projectId
                  ? `<button class="pm-ack-btn${m.analysisAcknowledged ? ' pm-acknowledged' : ''}" data-project-id="${m.projectId}" title="${m.analysisAcknowledged ? escHtml(m.analysisNote) : 'Leg vast waarom deze afwijking al besproken is'}">${m.analysisAcknowledged ? '✓ Les vastgelegd' : 'Markeer als besproken'}</button>`
                  : '';
                return `<div class="pm-row">
                  <span class="pm-name">${escHtml(m.name)}${lessonButton}</span>
                  <span class="pm-col-est">${colEst}</span>
                  <span class="pm-col-gef">${colGef}</span>
                  <span class="pm-col-marge">${colMrg}</span>
                  <span class="pm-col-pct">${colVsPr}</span>
                  <span class="pm-col-winst">${colWst}</span>
                </div>`;
              }).join('')
              })()}
              ${snap.activeProjectMargins.length ? (() => {
                const sortKey = localStorage.getItem('pm_sort') || 'winst';
                const sortDir = localStorage.getItem('pm_sort_dir') || 'desc';
                const d = sortDir === 'asc' ? -1 : 1;
                const sortFn = (a, b) => {
                  if (sortKey === 'name') return d * a.name.localeCompare(b.name, 'nl');
                  if (sortKey === 'date') return d * (a.startDate || '').localeCompare(b.startDate || '');
                  if (sortKey === 'gefactureerd') return d * ((b.quoteValue || 0) - (a.quoteValue || 0));
                  return d * ((b.estimatedProfit || 0) - (a.estimatedProfit || 0));
                };
                const sec = 'active_projects';
                const collapsed = localStorage.getItem(`pm_sec_${sec}`) === '1';
                return `<div class="pm-section-hdr${collapsed ? ' pm-sec-collapsed' : ''}" data-sec="${sec}">
                    <span class="pm-sec-arrow">${collapsed ? '▶' : '▾'}</span> Lopende projecten (prognose)
                  </div>
                  <div class="pm-section-body${collapsed ? ' hidden' : ''}" id="pm-sec-body-${sec}">
                    ${[...snap.activeProjectMargins].sort(sortFn).map(m => `<div class="pm-row pm-row-active">
                      <span class="pm-name">${escHtml(m.name)}</span>
                      <span class="pm-col-est">${m.estimatedProfit != null ? fmtEur(m.estimatedProfit) : '—'}</span>
                      <span class="pm-col-gef" style="color:var(--text2);font-size:11px">${m.quoteValue ? fmtEur(m.quoteValue) : '—'}</span>
                      <span class="pm-col-marge"></span>
                      <span class="pm-col-pct"></span>
                      <span class="pm-col-winst" style="color:var(--text2);font-size:11px">nog lopend</span>
                    </div>`).join('')}
                  </div>`;
              })() : ''}
              ${(() => {
                const hidden = new Set(JSON.parse(localStorage.getItem('pm_hidden_mb_projects') || '[]'));
                const visible = snap.unmatchedProjectCosts.filter(c => !hidden.has(c.name.toLowerCase()));
                const hiddenItems = snap.unmatchedProjectCosts.filter(c => hidden.has(c.name.toLowerCase()));
                if (!snap.unmatchedProjectCosts.length) return '';
                const sec = 'unmatched';
                const collapsed = localStorage.getItem(`pm_sec_${sec}`) === '1';
                return `<div class="pm-section-hdr${collapsed ? ' pm-sec-collapsed' : ''}" data-sec="${sec}">
                    <span class="pm-sec-arrow">${collapsed ? '▶' : '▾'}</span> Niet gekoppeld aan project in deze app
                  </div>
                  <div class="pm-section-body${collapsed ? ' hidden' : ''}" id="pm-sec-body-${sec}">
                    ${visible.map(c => `<div class="pm-row pm-row-unmatched">
                      <span class="pm-name">${escHtml(c.name)}</span>
                      <span class="pm-col-gef biz-margin-note">Kosten: ${fmtEur(c.cost)}</span>
                      <span class="pm-col-link" style="grid-column:3/-1">
                        ${unmatchedCostLinkHtml(c)}
                        <button class="pm-hide-btn" data-hide="${escHtml(c.name)}" title="Verberg uit overzicht">Verberg</button>
                      </span>
                    </div>`).join('')}
                    ${hiddenItems.length ? `<div class="pm-show-hidden">
                      ${hiddenItems.length} verborgen — <button class="pm-link-btn" id="pm-show-hidden-btn">Toon verborgen</button>
                    </div>` : ''}
                  </div>`;
              })()}
              ${snap.explicitMbLinks.length ? (() => {
                const sec = 'explicit';
                const collapsed = localStorage.getItem(`pm_sec_${sec}`) === '1';
                return `<div class="pm-section-hdr${collapsed ? ' pm-sec-collapsed' : ''}" data-sec="${sec}">
                    <span class="pm-sec-arrow">${collapsed ? '▶' : '▾'}</span> Handmatig gekoppelde Moneybird-projecten
                  </div>
                  <div class="pm-section-body${collapsed ? ' hidden' : ''}" id="pm-sec-body-${sec}">
                    ${snap.explicitMbLinks.map(l => `<div class="pm-row pm-row-unmatched">
                      <span class="pm-name">${escHtml(l.mbName)} <span style="opacity:.55">→ ${escHtml(l.projectName)}</span></span>
                      <span class="pm-col-link" style="grid-column:2/-1">
                        <button class="pm-unlink-btn" data-project="${l.projectId}" data-mb="${escHtml(l.mbId)}" title="Koppeling weghalen">✕ ontkoppel</button>
                      </span>
                    </div>`).join('')}
                  </div>`;
              })() : ''}
            </div>`
          : `<p class="biz-empty-sub">Geen afgesloten projecten met Moneybird-kosten/omzet gevonden.</p>`}
    </div>

    <div class="biz-insights-card">
      <div class="biz-card-title">🤖 AI Inzichten</div>
      ${cached?.insights?.length
        ? `<ul class="biz-insights-list">${cached.insights.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul>`
        : `<p class="biz-empty-sub">Nog geen inzichten gegenereerd. Klik op "Vernieuw analyse".</p>`}
    </div>

    <div class="biz-chat-card">
      <div class="biz-card-title">💬 Vraag het je bedrijfscoach</div>
      <div class="biz-quick-questions">
        ${BIZ_QUICK_QUESTIONS.map(q => `<button class="biz-quick-btn" data-q="${escHtml(q)}">${escHtml(q)}</button>`).join('')}
      </div>
      <div class="biz-chat-messages" id="biz-chat-messages"></div>
      <div class="biz-chat-input-row">
        <input type="text" id="biz-chat-input" placeholder="Stel een vraag over je bedrijf…" autocomplete="off" />
        <button class="btn btn-primary btn-sm" id="biz-chat-send">Verstuur</button>
        <button class="btn btn-ghost btn-sm" id="biz-chat-clear" title="Wis gesprek">🗑</button>
      </div>
    </div>
  </div>`;

  document.getElementById('biz-refresh-btn').onclick = () => refreshBizInsights(snap);

  const reminderListKeyFor = field => field === 'sent_snoozed_until' ? 'staleSentQuotes' : 'staleLaterQuotes';
  const applySnooze = async (quoteId, field, until, label) => {
    await snoozeQuoteReminder(quoteId, until, field);
    toast(`Herinnering uitgesteld tot ${label}`);
    const listKey = reminderListKeyFor(field);
    snap[listKey] = snap[listKey].filter(q => q.id != quoteId);
    renderBizDashboardContent(snap);
  };
  document.querySelectorAll('.biz-snooze-select').forEach(sel => {
    const id = parseInt(sel.dataset.id);
    const field = sel.dataset.field;
    const dateInput = document.querySelector(`.biz-snooze-date[data-id="${sel.dataset.id}"]`);
    const applyBtn  = document.querySelector(`.biz-snooze-apply[data-id="${sel.dataset.id}"]`);
    sel.onchange = async () => {
      if (sel.value === 'custom') {
        dateInput.classList.remove('hidden');
        applyBtn.classList.remove('hidden');
        return;
      }
      const labels = { '1d': '1 dag', '1w': '1 week', '1m': '1 maand' };
      await applySnooze(id, field, computeSnoozeUntil(sel.value), labels[sel.value]);
    };
    applyBtn.onclick = async () => {
      if (!dateInput.value) { shake(dateInput); return; }
      await applySnooze(id, field, new Date(dateInput.value), dateInput.value);
    };
  });
  document.querySelectorAll('.biz-link-mb-project').forEach(sel => {
    sel.onchange = async () => {
      const localProjectId = Number(sel.value);
      if (!localProjectId) return;
      const mbProjectId = String(sel.dataset.mbId);
      const proj = state.projects.find(p => p.id === localProjectId);
      // Voeg toe aan de bestaande koppelingen i.p.v. overschrijven, zodat meerdere
      // Moneybird-projecten aan hetzelfde lokale project kunnen hangen.
      const ids = proj ? mbIdsOf(proj) : [];
      if (!ids.includes(mbProjectId)) ids.push(mbProjectId);
      const newVal = ids.join(',');
      await remoteQuery({ action: 'update', table: 'projects', data: { moneybird_project_id: newVal }, where: { id: localProjectId } });
      if (proj) proj.moneybird_project_id = newVal;
      toast('Project gekoppeld');
      await renderBedrijfsanalyse();
    };
  });
  // Sorteerknopjes project marges
  document.querySelectorAll('.pm-sort-btn').forEach(btn => {
    btn.onclick = () => {
      const cur = localStorage.getItem('pm_sort') || 'winst';
      if (btn.dataset.sort === cur) {
        const dir = localStorage.getItem('pm_sort_dir') || 'desc';
        localStorage.setItem('pm_sort_dir', dir === 'desc' ? 'asc' : 'desc');
      } else {
        localStorage.setItem('pm_sort', btn.dataset.sort);
        localStorage.setItem('pm_sort_dir', 'desc');
      }
      renderBizDashboardContent(_bizSnapshot);
    };
  });
  // Begrepen-knop per project (onderdrukt waarschuwingskleuren voor bekende afwijkingen)
  document.querySelectorAll('.pm-ack-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const name = btn.dataset.ack;
      const acked = new Set(JSON.parse(localStorage.getItem('biz_acknowledged_projects') || '[]'));
      if (acked.has(name)) { acked.delete(name); } else { acked.add(name); }
      localStorage.setItem('biz_acknowledged_projects', JSON.stringify([...acked]));
      renderBizDashboardContent(_bizSnapshot);
    };
  });
  // Collapsible secties (niet-gekoppeld / handmatig-gekoppeld / lopend)
  document.querySelectorAll('.pm-section-hdr').forEach(hdr => {
    hdr.onclick = () => {
      const sec = hdr.dataset.sec;
      const body = document.getElementById(`pm-sec-body-${sec}`);
      const nowCollapsed = !hdr.classList.contains('pm-sec-collapsed');
      hdr.classList.toggle('pm-sec-collapsed', nowCollapsed);
      hdr.querySelector('.pm-sec-arrow').textContent = nowCollapsed ? '▶' : '▾';
      body?.classList.toggle('hidden', nowCollapsed);
      localStorage.setItem(`pm_sec_${sec}`, nowCollapsed ? '1' : '0');
    };
  });

  // Verberg / toon verborgen ongematchte projecten
  document.querySelectorAll('.pm-hide-btn').forEach(btn => {
    btn.onclick = () => {
      const name = btn.dataset.hide.toLowerCase();
      const hidden = new Set(JSON.parse(localStorage.getItem('pm_hidden_mb_projects') || '[]'));
      hidden.add(name);
      localStorage.setItem('pm_hidden_mb_projects', JSON.stringify([...hidden]));
      renderBizDashboardContent(snap);
    };
  });
  document.getElementById('pm-show-hidden-btn')?.addEventListener('click', () => {
    localStorage.removeItem('pm_hidden_mb_projects');
    renderBizDashboardContent(snap);
  });
  // Moneybird-project ontkoppelen (uit de kommagescheiden lijst halen)
  document.querySelectorAll('.pm-unlink-btn').forEach(btn => {
    btn.onclick = async () => {
      const projectId = Number(btn.dataset.project);
      const mbId = String(btn.dataset.mb);
      const proj = state.projects.find(p => p.id === projectId);
      if (!proj) return;
      const newVal = mbIdsOf(proj).filter(x => x !== mbId).join(',');
      await remoteQuery({ action: 'update', table: 'projects', data: { moneybird_project_id: newVal }, where: { id: projectId } });
      proj.moneybird_project_id = newVal;
      toast('Koppeling weggehaald');
      await renderBedrijfsanalyse();
    };
  });

  renderBizChatMessages();
  wireBizChatPanel();
}

async function refreshBizInsights(snap) {
  const btn = document.getElementById('biz-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyseren…'; }
  try {
    await generateBusinessInsights(snap);
    toast('Analyse vernieuwd');
    renderBizDashboardContent(snap);
  } catch (e) {
    toast('AI-analyse mislukt: ' + (e.message || e), 'error', 5000);
  } finally {
    const btn2 = document.getElementById('biz-refresh-btn');
    if (btn2) { btn2.disabled = false; btn2.textContent = '🔄 Vernieuw analyse'; }
  }
}

function renderBizChatMessages() {
  const container = document.getElementById('biz-chat-messages');
  if (!container) return;
  const history = loadChatHistory();
  container.innerHTML = history.length
    ? history.map(m => `
        <div class="biz-chat-msg biz-chat-${m.role}">
          <div class="biz-chat-bubble">${escHtml(m.content).replace(/\n/g, '<br>')}</div>
        </div>`).join('')
    : `<p class="biz-chat-empty">Stel een vraag over je bedrijf, of gebruik een van de knoppen hierboven.</p>`;
  container.scrollTop = container.scrollHeight;
}

function wireBizChatPanel() {
  const input    = document.getElementById('biz-chat-input');
  const sendBtn  = document.getElementById('biz-chat-send');
  const clearBtn = document.getElementById('biz-chat-clear');
  if (!input) return;

  const send = async (presetText) => {
    const q = (presetText ?? input.value).trim();
    if (!q) return;
    input.value = '';
    sendBtn.disabled = true;
    const priorHistory = loadChatHistory();
    saveChatHistory([...priorHistory, { role: 'user', content: q }]);
    renderBizChatMessages();
    try {
      const reply = await sendBizChatMessage(q, priorHistory);
      saveChatHistory([...loadChatHistory(), { role: 'assistant', content: reply }]);
      renderBizChatMessages();
    } catch (e) {
      toast('AI-fout: ' + (e.message || e), 'error', 5000);
    } finally {
      sendBtn.disabled = false;
    }
  };

  sendBtn.onclick = () => send();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  clearBtn.onclick = () => {
    if (!confirm('Gespreksgeschiedenis wissen?')) return;
    clearChatHistory();
    renderBizChatMessages();
  };
  document.querySelectorAll('.biz-quick-btn').forEach(btn => {
    btn.onclick = () => send(btn.dataset.q);
  });
}

// ─── Quote State ──────────────────────────────────────────────────────────────

// qe = quoteEditor live state (in-memory while editing)
let qe = null;
let _qeDirty = false;
function markQEDirty() { _qeDirty = true; }

// Vaste-stuksprijs-regels uit extras_json, met terugval op het oude formaat (één
// fixed_price/fixed_qty) voor offertes die zijn opgeslagen vóórdat meerdere regels
// (bv. 3x groot blok, 2x klein, 8x middel) mogelijk werden.
function getQuoteFixedItems(extras) {
  if (Array.isArray(extras.fixed_items)) return extras.fixed_items;
  if (extras.fixed_price != null) return [{ name: '', quantity: extras.fixed_qty ?? 1, unit_price: extras.fixed_price }];
  return [];
}

function freshQE(quote) {
  // Prefer DB-stored extras_json (synced across devices); fall back to localStorage for legacy quotes
  let stored = {};
  if (quote?.extras_json) {
    try { stored = JSON.parse(quote.extras_json) || {}; } catch (_) { stored = {}; }
  } else if (quote?.id) {
    try { stored = JSON.parse(localStorage.getItem('qextra_' + quote.id) || '{}'); } catch (_) { stored = {}; }
  }
  return {
    id:         quote?.id         ?? null,
    name:       quote?.name       ?? '',
    project_name: quote?.project_name ?? '',
    variant_group: quote?.variant_group ?? '',
    client:     quote?.client     ?? '',
    client_contact: stored.client_contact ?? '',
    client_address: stored.client_address ?? '',
    client_postcode: stored.client_postcode ?? '',
    client_email: stored.client_email ?? '',
    client_phone: stored.client_phone ?? '',
    quote_date: quote?.quote_date ?? toDateStr(new Date()),
    margin:     quote?.margin     ?? 20,
    outsource_margin: stored.outsource_margin ?? 15,
    // Vaste-stuksprijs-modus: meerdere regels met eigen aantal × stuksprijs
    // (bv. 3x groot blok, 2x klein, 8x middel) i.p.v. één vaste prijs voor de hele offerte.
    fixed_items:   getQuoteFixedItems(stored),
    fixed_enabled: getQuoteFixedItems(stored).length > 0,
    status:     quote?.status     ?? 'draft',
    notes:      quote?.notes      ?? '',
    image_data:     quote?.image_data || (quote?.id ? localStorage.getItem('qimg_' + quote.id) : '') || '',
    extra_images:   stored.extra_images ?? [],
    // Alleen samengevoegde offertes hebben deze volgorde. Hiermee kunnen ook lege
    // Materiaal-/Diensten-blokken in de editor en interne PDF zichtbaar blijven.
    merged_sections: Array.isArray(stored.merged_sections) ? stored.merged_sections : [],
    checklist_done: quote?.id ? true : false,
    materials:  [],
    services:   [],
    exclusions: [],
    // PDF options
    pdf_opts: stored.pdf_opts ?? {
      show_title_page: true,
      show_project_image: true,
      show_extra_images: true,
      show_exclusions: true,
      show_notes: true,
      show_validity: true,
      show_client_address: true,
    },
  };
}

// ─── Quote List View ──────────────────────────────────────────────────────────

let _quotesFilter       = new Set(); // leeg = alle statussen
let _quotesSort         = { field: 'date', dir: 'desc' };
let _quotesSearch       = '';
let _quotesHideGeleverd = false;
let _allQuotes          = []; // cached for client-side filter/sort
let _selectedQuoteIds   = new Set(); // gereserveerd (checkboxes verwijderd)
let _expandedVariantGroups = new Set();
let _expandedProjectGroups = new Set();

function quoteVariantGroupId() {
  // Timestamp + random suffix is sufficient here: this is an opaque local grouping
  // key, not an externally exposed identifier.
  return `variants-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _renderQuoteTable() {
  let list = _allQuotes.slice();

  // Filter
  if (_quotesFilter.size) list = list.filter(q => _quotesFilter.has(q.status));
  const needle = _quotesSearch.trim().toLowerCase();
  if (needle) {
    list = list.filter(q => [q.name, q.client, q.project_name]
      .some(value => String(value || '').toLowerCase().includes(needle)));
  }
  if (_quotesHideGeleverd) {
    list = list.filter(q => {
      const linkName = (q.project_name || q.name || '').trim().toLowerCase();
      return !(q.status === 'accepted' && linkName && state.projects?.find(p => p.name.trim().toLowerCase() === linkName && p.status === 'done'));
    });
  }

  // Sort
  list.sort((a, b) => {
    let va, vb;
    if (_quotesSort.field === 'price') {
      va = a.total_price ?? -Infinity;
      vb = b.total_price ?? -Infinity;
    } else {
      va = a.quote_date || '';
      vb = b.quote_date || '';
    }
    return _quotesSort.dir === 'asc' ? (va > vb ? 1 : va < vb ? -1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0);
  });

  if (!list.length) {
    document.getElementById('ql-table-wrap').innerHTML =
      `<div class="empty" style="margin-top:40px"><div class="empty-icon">🔍</div><p>Geen offertes gevonden voor deze zoekopdracht of filter.</p></div>`;
    return;
  }

  let html = `<table class="quotes-table">
    <thead><tr>
      <th>Project</th><th>Klant</th><th>Datum</th>
      <th style="text-align:right">Totaal excl. BTW</th><th>Status</th><th></th>
    </tr></thead><tbody>`;
  const renderQuoteRow = (q, isVariantChild = false) => {
    const hasTotal = q.total_price != null;
    const linkName = (q.project_name || q.name || '').trim().toLowerCase();
    const fulfilled = q.status === 'accepted' && linkName && state.projects?.find(p => p.name.trim().toLowerCase() === linkName && p.status === 'done');
    return `<tr class="quote-row${isVariantChild ? ' ql-variant-child' : ''}" data-id="${q.id}">
      <td><strong>${escHtml(q.name)}</strong>${q.variant_group ? ` <span class="ql-variant-badge" title="Alternatieve offerte binnen dezelfde aanvraag">variant</span>` : ''}</td>
      <td>${escHtml(q.client)}</td>
      <td>${q.quote_date || '—'}</td>
      <td class="amount qt-total${hasTotal ? '' : ' loading'}" id="qt-total-${q.id}">${hasTotal ? fmtEur(q.total_price) : '…'}</td>
      <td><div style="display:flex;align-items:center;gap:6px;white-space:nowrap">
        <select class="badge badge-${q.status} quote-status-select" data-id="${q.id}">
          ${quoteStatusOptionsHtml(q.status)}
        </select>${fulfilled ? `<span title="Gekoppeld project is afgerond — al geleverd" style="font-size:10px;color:var(--text2);opacity:0.7">✓ geleverd</span>` : ''}
      </div></td>
      <td><button class="quote-delete-btn" data-id="${q.id}" title="Verwijder">✕</button></td>
    </tr>`;
  };

  // A grouped row keeps alternatives together. Its total is intentionally the
  // highest option, matching the pipeline calculation in Bedrijfsanalyse.
  const groups = new Map();
  list.forEach(q => {
    if (q.variant_group) {
      const members = groups.get(q.variant_group) || [];
      members.push(q);
      groups.set(q.variant_group, members);
    }
  });

  // Project groups: quotes sharing the same project_name (≥ 2) collapse into one row
  const projectGroupMap = new Map();
  list.forEach(q => {
    const key = q.project_name ? q.project_name.trim() : '';
    if (key && !q.variant_group) {
      const arr = projectGroupMap.get(key) || [];
      arr.push(q);
      projectGroupMap.set(key, arr);
    }
  });
  for (const [key, arr] of projectGroupMap) {
    if (arr.length < 2) projectGroupMap.delete(key);
  }

  // Totaal van de gefilterde selectie (variant-groep = hoogste prijs; project-groep = som van delen)
  let selectionTotal = 0;
  let selectionCount = 0;
  const seenGroupsForTotal = new Set();
  const seenProjectGroupsForTotal = new Set();
  list.forEach(q => {
    if (q.variant_group) {
      if (!seenGroupsForTotal.has(q.variant_group)) {
        seenGroupsForTotal.add(q.variant_group);
        const grpMembers = groups.get(q.variant_group) || [q];
        const grpBase = grpMembers.filter(m => m.status !== 'rejected');
        const highest = (grpBase.length > 0 ? grpBase : grpMembers).reduce((best, item) =>
          Number(item.total_price || 0) > Number(best.total_price || 0) ? item : best, (grpBase.length > 0 ? grpBase : grpMembers)[0]);
        selectionTotal += Number(highest.total_price || 0);
        selectionCount++;
      }
    } else if (q.project_name && projectGroupMap.has(q.project_name.trim())) {
      const key = q.project_name.trim();
      if (!seenProjectGroupsForTotal.has(key)) {
        seenProjectGroupsForTotal.add(key);
        const members = projectGroupMap.get(key);
        selectionTotal += members.filter(m => m.status !== 'rejected').reduce((acc, m) => acc + Number(m.total_price || 0), 0);
        selectionCount++;
      }
    } else {
      selectionTotal += Number(q.total_price || 0);
      selectionCount++;
    }
  });

  document.querySelectorAll('.pm-ack-btn').forEach(btn => {
    btn.onclick = async () => {
      const projectId = Number(btn.dataset.projectId);
      const project = state.projects.find(p => p.id === projectId);
      if (!project) return;
      const note = window.prompt(
        'Waarom is deze afwijking al besproken? De AI zal dit niet opnieuw als hoofdadvies noemen.',
        project.analysis_note || ''
      );
      if (note === null) return;
      if (!note.trim()) { toast('Vul een korte les of verklaring in.', 'error'); return; }
      await remoteQuery({ action: 'update', table: 'projects', data: { analysis_acknowledged: 1, analysis_note: note.trim() }, where: { id: projectId } });
      project.analysis_acknowledged = 1;
      project.analysis_note = note.trim();
      toast('Projectles vastgelegd');
      await renderBedrijfsanalyse();
    };
  });
  const renderedGroups = new Set();
  const renderedProjectGroups = new Set();
  list.forEach(q => {
    if (q.variant_group) {
      if (renderedGroups.has(q.variant_group)) return;
      renderedGroups.add(q.variant_group);
      const members = groups.get(q.variant_group) || [q];
      const nonRejected = members.filter(m => m.status !== 'rejected');
      const priceBase = nonRejected.length > 0 ? nonRejected : members;
      const highest = priceBase.reduce((best, item) =>
        Number(item.total_price || 0) > Number(best.total_price || 0) ? item : best, priceBase[0]);
      const expanded = _expandedVariantGroups.has(q.variant_group);
      const client = [...new Set(members.map(item => item.client).filter(Boolean))].join(', ') || '—';
      const latestDate = members.map(item => item.quote_date || '').sort().at(-1) || '—';
      const groupName = members[0].project_name?.trim() || members[0].name || '—';
      const vStatuses = [...new Set(members.map(m => m.status))];
      let vStatusCell;
      if (vStatuses.includes('accepted')) {
        vStatusCell = `<span class="badge badge-accepted">${fmtQuoteStatus('accepted')}</span>`;
      } else if (vStatuses.every(s => s === 'rejected')) {
        vStatusCell = `<span class="badge badge-rejected">${fmtQuoteStatus('rejected')}</span>`;
      } else {
        const vis = [...new Set(nonRejected.map(m => m.status))];
        vStatusCell = vis.length === 1
          ? `<span class="badge badge-${vis[0]}">${fmtQuoteStatus(vis[0])}</span>`
          : `<span class="ql-group-status">${vis.map(s => fmtQuoteStatus(s)).join(' + ')}</span>`;
      }
      html += `<tr class="quote-variant-group" data-group="${escHtml(q.variant_group)}">
        <td><strong>${escHtml(groupName)}</strong> <span class="ql-group-chevron">${expanded ? '▾' : '▸'}</span></td>
        <td>${escHtml(client)}</td>
        <td>${latestDate}</td>
        <td class="amount">${fmtEur(highest.total_price)} <span class="ql-group-total-note">${members.length} varianten</span></td>
        <td>${vStatusCell}</td><td></td>
      </tr>`;
      if (expanded) members.forEach(member => { html += renderQuoteRow(member, true); });
    } else if (q.project_name && projectGroupMap.has(q.project_name.trim())) {
      const key = q.project_name.trim();
      if (renderedProjectGroups.has(key)) return;
      renderedProjectGroups.add(key);
      const members = projectGroupMap.get(key);
      const expanded = _expandedProjectGroups.has(key);
      const client = [...new Set(members.map(m => m.client).filter(Boolean))].join(', ') || '—';
      const latestDate = members.map(m => m.quote_date || '').sort().at(-1) || '—';
      const sum = members.filter(m => m.status !== 'rejected').reduce((acc, m) => acc + Number(m.total_price || 0), 0);
      const statuses = [...new Set(members.map(m => m.status))];
      let statusCell;
      if (statuses.includes('accepted')) {
        statusCell = `<span class="badge badge-accepted">${fmtQuoteStatus('accepted')}</span>`;
      } else if (statuses.every(s => s === 'rejected')) {
        statusCell = `<span class="badge badge-rejected">${fmtQuoteStatus('rejected')}</span>`;
      } else {
        const visible = [...new Set(members.filter(m => m.status !== 'rejected').map(m => m.status))];
        statusCell = visible.length === 1
          ? `<span class="badge badge-${visible[0]}">${fmtQuoteStatus(visible[0])}</span>`
          : `<span class="ql-group-status">${visible.map(s => fmtQuoteStatus(s)).join(' + ')}</span>`;
      }
      html += `<tr class="quote-project-group" data-project="${escHtml(key)}">
        <td><strong>${escHtml(key)}</strong> <span class="ql-group-chevron ql-project-chevron">${expanded ? '▾' : '▸'}</span></td>
        <td>${escHtml(client)}</td>
        <td>${latestDate}</td>
        <td class="amount">${fmtEur(sum)} <span class="ql-group-total-note">${members.length} delen</span></td>
        <td>${statusCell}</td><td></td>
      </tr>`;
      if (expanded) members.forEach(member => { html += renderQuoteRow(member, true); });
    } else {
      html += renderQuoteRow(q);
    }
  });
  html += `</tbody><tfoot><tr>
    <td colspan="3" class="ql-total-label">${selectionCount} ${selectionCount === 1 ? 'offerte' : 'offertes'}</td>
    <td class="ql-total-amount">${fmtEur(selectionTotal)}</td>
    <td colspan="2"></td>
  </tr></tfoot></table>`;
  document.getElementById('ql-table-wrap').innerHTML = html;

  document.querySelectorAll('.quote-status-select').forEach(select => {
    select.onclick = e => e.stopPropagation();
    select.onchange = async (e) => {
      const quote = _allQuotes.find(q => q.id == select.dataset.id);
      if (!quote) return;
      const newStatus = e.target.value;
      await changeQuoteStatus(quote, newStatus);
      quote.status = newStatus;
      select.className = `badge badge-${newStatus} quote-status-select`;
      toast('Status bijgewerkt');
      _renderQuoteTable();
    };
  });

  document.querySelectorAll('.quote-row').forEach(row => {
    row.onclick = async (e) => {
      if (e.target.closest('.quote-delete-btn, .quote-status-select')) return;
      const [full] = await remoteQuery({ action: 'select', table: 'quotes', where: { id: row.dataset.id } });
      if (full) openQuoteEditor(full);
    };
  });

  document.querySelectorAll('.quote-variant-group').forEach(row => {
    row.onclick = () => {
      const group = row.dataset.group;
      if (_expandedVariantGroups.has(group)) _expandedVariantGroups.delete(group);
      else _expandedVariantGroups.add(group);
      _renderQuoteTable();
    };
  });

  document.querySelectorAll('.quote-project-group').forEach(row => {
    row.onclick = () => {
      const key = row.dataset.project;
      if (_expandedProjectGroups.has(key)) _expandedProjectGroups.delete(key);
      else _expandedProjectGroups.add(key);
      _renderQuoteTable();
    };
  });

  document.querySelectorAll('.quote-delete-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const quote = _allQuotes.find(q => q.id == btn.dataset.id);
      if (!quote) return;
      if (!confirm(`Verwijder offerte "${quote.name}"?`)) return;
      await remoteQuery({ action: 'delete', table: 'quotes', where: { id: quote.id } });
      _allQuotes = _allQuotes.filter(q => q.id !== quote.id);
      toast(`Offerte "${quote.name}" verwijderd`);
      _renderQuoteTable();
    };
  });
}

function _updateQuoteSelectionActions() {
  const n = _selectedQuoteIds.size;
  let mergeBtn = document.getElementById('ql-merge-btn');
  let groupBtn = document.getElementById('ql-group-btn');
  if (n >= 2) {
    if (!mergeBtn) {
      mergeBtn = document.createElement('button');
      mergeBtn.id = 'ql-merge-btn';
      mergeBtn.className = 'btn btn-secondary btn-sm';
      mergeBtn.onclick = mergeSelectedQuotes;
      document.getElementById('toolbar-controls').appendChild(mergeBtn);
    }
    if (!groupBtn) {
      groupBtn = document.createElement('button');
      groupBtn.id = 'ql-group-btn';
      groupBtn.className = 'btn btn-secondary btn-sm';
      groupBtn.onclick = groupSelectedQuotes;
      document.getElementById('toolbar-controls').appendChild(groupBtn);
    }
    mergeBtn.textContent = `Samenvoegen (${n})`;
    const selected = _allQuotes.filter(q => _selectedQuoteIds.has(q.id));
    const commonGroup = selected[0]?.variant_group && selected.every(q => q.variant_group === selected[0].variant_group);
    groupBtn.textContent = commonGroup ? `Bundel opheffen (${n})` : `Bundelen als varianten (${n})`;
    groupBtn.title = commonGroup
      ? 'Deze offertes zijn weer losse aanvragen in de bedrijfsanalyse'
      : 'Tel in openstaande offertes alleen de hoogste variant mee';
  } else {
    mergeBtn?.remove();
    groupBtn?.remove();
  }
}

async function groupSelectedQuotes() {
  const selected = _allQuotes.filter(q => _selectedQuoteIds.has(q.id));
  if (selected.length < 2) return;
  const commonGroup = selected[0]?.variant_group && selected.every(q => q.variant_group === selected[0].variant_group);
  const group = commonGroup ? '' : quoteVariantGroupId();
  const label = commonGroup ? 'de bundel opheffen' : 'deze offertes als varianten van één aanvraag bundelen';
  if (!confirm(`Wil je ${label}?`)) return;
  await Promise.all(selected.map(q => remoteQuery({
    action: 'update', table: 'quotes', data: { variant_group: group }, where: { id: q.id },
  })));
  selected.forEach(q => { q.variant_group = group; });
  _selectedQuoteIds.clear();
  toast(commonGroup
    ? 'Offertes zijn weer losse aanvragen'
    : 'Varianten gebundeld — alleen de hoogste open variant telt mee');
  _renderQuoteTable();
  _updateQuoteSelectionActions();
}

async function mergeSelectedQuotes() {
  if (_selectedQuoteIds.size < 2) return;
  const ids = [..._selectedQuoteIds];

  // Haal volledige data op voor alle geselecteerde offertes
  toast('Offertes samenvoegen…', 'info', 6000);
  const [fullQuotes, allItems] = await Promise.all([
    Promise.all(ids.map(id => remoteQuery({ action: 'select', table: 'quotes', where: { id } }).then(r => r[0]))),
    Promise.all(ids.map(id => remoteQuery({ action: 'select', table: 'quote_items', where: { quote_id: id } }))),
  ]);

  // Gebruik de nieuwste offerte als basis voor metadata
  const base = fullQuotes.slice().sort((a, b) => (b.quote_date || '').localeCompare(a.quote_date || ''))[0];

  // Combineer alle items (materialen + diensten + exclusies), gegroepeerd per bronofferte
  const usedSectionLabels = new Map();
  const sourceLabels = fullQuotes.map((quote, idx) => {
    const baseLabel = quote?.name || `Onderdeel ${idx + 1}`;
    const count = (usedSectionLabels.get(baseLabel) || 0) + 1;
    usedSectionLabels.set(baseLabel, count);
    return count === 1 ? baseLabel : `${baseLabel} (${count})`;
  });
  const mergedItems = [];
  allItems.forEach((items, idx) => {
    const label    = sourceLabels[idx];
    const srcQuote = fullQuotes[idx];
    let srcExtras = {};
    try { srcExtras = JSON.parse(srcQuote?.extras_json || '{}') || {}; } catch {}
    const srcGlobalMargin    = (srcQuote?.margin           != null && srcQuote?.margin           !== '') ? parseFloat(srcQuote.margin)           : 20;
    const srcOutsourceMargin = (srcExtras.outsource_margin != null && srcExtras.outsource_margin !== '') ? parseFloat(srcExtras.outsource_margin) : 0;
    (items || []).forEach(it => {
      // Bak de effectieve marge in zodat items met null-marge niet de globale marge
      // van de basisofferte overnemen — anders klopt het samengevoegde totaal niet.
      let margin = it.margin;
      if (margin == null || margin === '') {
        if (it.type === 'material') margin = srcGlobalMargin;
        else if (it.type === 'service' && it.is_outsourced) margin = srcOutsourceMargin;
      }
      mergedItems.push({ ...it, id: undefined, quote_id: undefined, section_label: label, margin });
    });
  });

  // Bouw de samengevoegde extras_json op basis van de basisofferte.
  // fixed_items worden NIET meegenomen: als één bronofferte een vaste stuksprijs had,
  // mag die niet de totaalprijs van de samengevoegde offerte overnemen — de merged
  // offerte telt gewoon alle items bij elkaar op via calcQuoteTotals.
  let baseExtras = {};
  try { baseExtras = JSON.parse(base.extras_json || '{}') || {}; } catch {}
  const mergedExtras = {
    ...baseExtras,
    fixed_items: [],
    merged_sections: sourceLabels,
  };

  const names = fullQuotes.map(q => q.name).join(' + ');
  const mergedName = names.length > 80 ? base.name + ' (samengevoegd)' : names;

  // Sla de nieuwe, samengevoegde offerte op
  const newQuote = await remoteQuery({ action: 'insert', table: 'quotes', data: {
    name: mergedName,
    client: base.client || '',
    quote_date: base.quote_date || '',
    margin: base.margin,
    status: 'draft',
    notes: fullQuotes.map(q => q.notes).filter(Boolean).join('\n\n---\n\n'),
    project_name: base.project_name || '',
    created_by: state.config?.name || '',
    image_data: base.image_data || '',
    extras_json: JSON.stringify(mergedExtras),
    total_price: null,
  }});

  for (const item of mergedItems) {
    await remoteQuery({ action: 'insert', table: 'quote_items', data: { ...item, quote_id: newQuote.id } });
  }

  _selectedQuoteIds.clear();
  toast(`Samengevoegd tot "${mergedName}" — originelen blijven bewaard`, 'success', 5000);

  // Open de nieuwe offerte meteen in de editor
  const [full] = await remoteQuery({ action: 'select', table: 'quotes', where: { id: newQuote.id } });
  if (full) openQuoteEditor(full);
}

function _renderQuoteFilterBar() {
  const FILTERS = [
    { key: null,       label: 'Alle' },
    { key: 'draft',    label: 'Concept' },
    { key: 'sent',     label: 'Verzonden' },
    { key: 'later',    label: 'Later' },
    { key: 'accepted', label: 'Geaccepteerd' },
    { key: 'rejected', label: 'Afgewezen' },
  ];
  const sortIcon = (field) => {
    if (_quotesSort.field !== field) return '↕';
    return _quotesSort.dir === 'desc' ? '↓' : '↑';
  };
  return `<div class="ql-controls-bar">
    <label class="ql-search-wrap" for="ql-search">
      <span>⌕</span><input id="ql-search" type="search" value="${escHtml(_quotesSearch)}" placeholder="Zoek project of klant…" autocomplete="off" />
    </label>
    <div class="ql-filters">
      ${FILTERS.map(f => {
        const isAll = f.key === null;
        const active = isAll ? _quotesFilter.size === 0 : _quotesFilter.has(f.key);
        return `<button class="ql-chip${f.key ? ' badge-' + f.key : ''}${active ? ' ql-chip-active' : ''}" data-filter="${f.key ?? ''}">${f.label}</button>`;
      }).join('')}
      <button class="ql-chip${_quotesHideGeleverd ? ' ql-chip-active' : ''}" data-geleverd="1" style="margin-left:6px">Verberg geleverd</button>
    </div>
    <div class="ql-sorts">
      <button class="ql-sort-btn${_quotesSort.field === 'date'  ? ' active' : ''}" data-sort="date">Datum ${sortIcon('date')}</button>
      <button class="ql-sort-btn${_quotesSort.field === 'price' ? ' active' : ''}" data-sort="price">Prijs ${sortIcon('price')}</button>
    </div>
  </div>`;
}

function wireQuoteSearch() {
  const search = document.getElementById('ql-search');
  if (!search) return;
  search.oninput = () => {
    _quotesSearch = search.value;
    _renderQuoteTable();
  };
}

async function renderQuoteList() {
  const ctrl = document.getElementById('toolbar-controls');
  const content = document.getElementById('content');
  ctrl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-quote-btn">+ Nieuwe offerte</button>`;
  document.getElementById('new-quote-btn').onclick = () => openQuoteWizard();

  // Alleen lichte kolommen ophalen — image_data/extras_json (foto's, JSON-blobs) zijn
  // groot en worden pas geladen zodra je een specifieke offerte opent.
  _allQuotes = await remoteQuery({
    action: 'select',
    table: 'quotes',
    columns: ['id', 'name', 'client', 'quote_date', 'total_price', 'status', 'project_name', 'variant_group'],
  });

  if (!Array.isArray(_allQuotes) || _allQuotes.length === 0) {
    content.innerHTML =
      `<div class="empty"><div class="empty-icon">💶</div><p>Nog geen offertes. Klik op "+ Nieuwe offerte" om te beginnen.</p></div>`;
    return;
  }

  content.innerHTML = `<div id="ql-bar-wrap">${_renderQuoteFilterBar()}</div><div id="ql-table-wrap"></div>`;
  wireQuoteSearch();
  _renderQuoteTable();

  // Event delegation: filter chips and sort buttons bubble up to content.
  // Gebruik onclick (assignment) zodat herhaalde aanroepen van renderQuoteList()
  // geen gestapelde listeners veroorzaken die het filter direct terugdraaien.
  content.onclick = e => {
    const gevBtn  = e.target.closest('[data-geleverd]');
    const chip    = e.target.closest('.ql-chip');
    const sortBtn = e.target.closest('.ql-sort-btn');
    if (gevBtn) {
      _quotesHideGeleverd = !_quotesHideGeleverd;
      document.getElementById('ql-bar-wrap').innerHTML = _renderQuoteFilterBar();
      wireQuoteSearch();
      _renderQuoteTable();
    } else if (chip) {
      const key = chip.dataset.filter || null;
      if (!key) {
        _quotesFilter.clear(); // "Alle" reset
      } else if (_quotesFilter.has(key)) {
        _quotesFilter.delete(key);
      } else {
        _quotesFilter.add(key);
      }
      document.getElementById('ql-bar-wrap').innerHTML = _renderQuoteFilterBar();
      wireQuoteSearch();
      _renderQuoteTable();
    } else if (sortBtn) {
      const field = sortBtn.dataset.sort;
      _quotesSort = _quotesSort.field === field
        ? { field, dir: _quotesSort.dir === 'desc' ? 'asc' : 'desc' }
        : { field, dir: 'desc' };
      document.getElementById('ql-bar-wrap').innerHTML = _renderQuoteFilterBar();
      wireQuoteSearch();
      _renderQuoteTable();
    }
  };

  // ── Eenmalige achtergrond-backfill: alleen offertes zonder opgeslagen total_price ──
  // (legacy offertes van vóór de total_price-kolom — na deze keer staat 'ie vast)
  const legacyQuotes = _allQuotes.filter(q => q.total_price == null);
  for (const q of legacyQuotes) {
    const [items, [fullQ]] = await Promise.all([
      remoteQuery({ action: 'select', table: 'quote_items', where: { quote_id: q.id } }),
      remoteQuery({ action: 'select', table: 'quotes', where: { id: q.id }, columns: ['margin', 'extras_json'] }),
    ]);
    const subtotal = computeLegacyQuoteSubtotal({ ...q, ...fullQ }, items || []);
    await remoteQuery({ action: 'update', table: 'quotes', data: { total_price: subtotal }, where: { id: q.id } });
    const el = document.getElementById(`qt-total-${q.id}`);
    if (el) { el.textContent = fmtEur(subtotal); el.classList.remove('loading'); }
  }
}

// ─── Quote Wizard ─────────────────────────────────────────────────────────────

let qwImageData = '';
let qwSelectedClient = null;

function openQuoteWizard() {
  qwImageData = '';
  qwSelectedClient = null;
  document.getElementById('qw-client').value = '';
  document.getElementById('qw-name').value = '';

  // Reset custom autocomplete
  const sugg = document.getElementById('qw-client-suggestions');
  if (sugg) sugg.classList.add('hidden');
  document.getElementById('qw-desc').value = '';
  document.getElementById('qw-img-preview').classList.add('hidden');
  document.getElementById('qw-drop-zone').classList.remove('hidden');
  document.getElementById('qw-file-input').value = '';

  // Build checkboxes
  const matChecks = document.getElementById('qw-mat-checks');
  matChecks.innerHTML = PRESET_MATERIALS.map((p, i) => `
    <label class="qw-check-item">
      <input type="checkbox" class="qw-mat-cb" data-idx="${i}" />
      <span>${escHtml(p.name)}</span>
      ${p.price ? `<span class="qw-check-rate">€${p.price}</span>` : ''}
    </label>`).join('');

  const svcChecks = document.getElementById('qw-svc-checks');
  svcChecks.innerHTML = PRESET_SERVICES.map((p, i) => `
    <label class="qw-check-item">
      <input type="checkbox" class="qw-svc-cb" data-idx="${i}" />
      <span>${escHtml(p.name)}</span>
      ${p.rate ? `<span class="qw-check-rate">€${p.rate}/u</span>` : ''}
    </label>`).join('');

  const exclChecks = document.getElementById('qw-excl-checks');
  exclChecks.innerHTML = PRESET_EXCLUSIONS.map((ex, i) => `
    <label class="qw-check-item">
      <input type="checkbox" class="qw-excl-cb" data-idx="${i}" />
      <span>${escHtml(ex)}</span>
    </label>`).join('');

  qwGoto(0);
  document.getElementById('quote-wizard-overlay').classList.remove('hidden');
  wireQuoteWizard();
}

function qwGoto(step) {
  document.querySelectorAll('#quote-wizard .wizard-step').forEach((s, i) => s.classList.toggle('active', i === step));
  document.querySelectorAll('#quote-wizard .step-dot').forEach((d, i) => d.classList.toggle('done', i <= step));
}

function wireQuoteWizard() {
  // Only wire once
  if (document.getElementById('quote-wizard-overlay').dataset.wired) return;
  document.getElementById('quote-wizard-overlay').dataset.wired = '1';

  document.getElementById('qw-cancel').onclick = () =>
    document.getElementById('quote-wizard-overlay').classList.add('hidden');

  // Custom autocomplete for client field
  const qwClientInput = document.getElementById('qw-client');
  const qwSugg = document.getElementById('qw-client-suggestions');

  function showClientSuggestions(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? state.clients.filter(c => c.name.toLowerCase().includes(q))
      : state.clients;
    if (!matches.length) { qwSugg.classList.add('hidden'); return; }
    qwSugg.innerHTML = matches.map(c =>
      `<div class="qw-suggestion-item" data-id="${c.id}">${escHtml(c.name)}</div>`
    ).join('');
    qwSugg.classList.remove('hidden');
    qwSugg.querySelectorAll('.qw-suggestion-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent blur firing first
        const c = state.clients.find(cl => cl.id === parseInt(item.dataset.id));
        if (!c) return;
        qwSelectedClient = c;
        qwClientInput.value = c.name;
        qwSugg.classList.add('hidden');
      });
    });
  }

  qwClientInput.addEventListener('focus', () => {
    if (state.clients.length) showClientSuggestions(qwClientInput.value);
  });
  qwClientInput.addEventListener('input', e => {
    const typed = e.target.value.trim();
    const exact = state.clients.find(c => c.name.trim().toLowerCase() === typed.toLowerCase());
    qwSelectedClient = exact || null;
    showClientSuggestions(typed);
  });
  qwClientInput.addEventListener('blur', () => {
    // Small delay so mousedown on suggestion fires first
    setTimeout(() => qwSugg.classList.add('hidden'), 150);
  });
  qwClientInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') qwSugg.classList.add('hidden');
  });

  document.getElementById('qw-next-0').onclick = () => {
    const client = document.getElementById('qw-client').value.trim();
    const name   = document.getElementById('qw-name').value.trim();
    if (!client) { shake(document.getElementById('qw-client')); return; }
    if (!name)   { shake(document.getElementById('qw-name')); return; }
    qwGoto(1);
  };

  document.getElementById('qw-back-1').onclick = () => qwGoto(0);
  document.getElementById('qw-next-1').onclick = () => qwGoto(2);
  document.getElementById('qw-back-2').onclick = () => qwGoto(1);

  // Drag & drop
  const dropZone = document.getElementById('qw-drop-zone');
  dropZone.addEventListener('click', () => document.getElementById('qw-file-input').click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-active'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-active'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-active');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) qwLoadImage(file);
  });
  document.getElementById('qw-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) qwLoadImage(file);
  });
  document.getElementById('qw-img-remove').onclick = () => {
    qwImageData = '';
    document.getElementById('qw-img-preview').classList.add('hidden');
    document.getElementById('qw-drop-zone').classList.remove('hidden');
    document.getElementById('qw-file-input').value = '';
  };

  // Finish wizard
  document.getElementById('qw-finish').onclick = () => {
    const client = document.getElementById('qw-client').value.trim();
    const name   = document.getElementById('qw-name').value.trim();
    const notes  = document.getElementById('qw-desc').value.trim();

    const selectedMaterials = [...document.querySelectorAll('.qw-mat-cb:checked')]
      .map(cb => { const p = PRESET_MATERIALS[parseInt(cb.dataset.idx)]; return { name: p.name, quantity: 1, unit: '', unit_price: p.price || 0, margin: null }; });
    const selectedServices = [...document.querySelectorAll('.qw-svc-cb:checked')]
      .map(cb => { const p = PRESET_SERVICES[parseInt(cb.dataset.idx)]; return { name: p.name, quantity: 1, unit: 'uur', unit_price: p.rate || 0 }; });
    const selectedExclusions = [...document.querySelectorAll('.qw-excl-cb:checked')]
      .map(cb => PRESET_EXCLUSIONS[parseInt(cb.dataset.idx)]);

    document.getElementById('quote-wizard-overlay').classList.add('hidden');

    qe = freshQE(null);
    qe.client     = client;
    qe.name       = name;
    qe.notes      = notes;
    qe.image_data = qwImageData;
    qe.materials  = selectedMaterials;
    qe.services   = selectedServices;
    qe.exclusions = selectedExclusions;
    // If a saved client was selected, pre-fill all contact details
    if (qwSelectedClient) {
      qe.client_contact  = qwSelectedClient.contact  || '';
      qe.client_address  = qwSelectedClient.address  || '';
      qe.client_postcode = qwSelectedClient.postcode || '';
      qe.client_email    = qwSelectedClient.email    || '';
      qe.client_phone    = qwSelectedClient.phone    || '';
    }
    // Mark as quote-editor view so setView() can intercept unsaved changes on back
    state.view = 'quote-editor';
    _qeDirty = false;
    renderQuoteEditorView();
  };
}

function qwLoadImage(file) {
  const reader = new FileReader();
  reader.onload = e => {
    qwImageData = e.target.result;
    document.getElementById('qw-preview-img').src = qwImageData;
    document.getElementById('qw-img-preview').classList.remove('hidden');
    document.getElementById('qw-drop-zone').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

// ─── Quote Editor ─────────────────────────────────────────────────────────────

async function openQuoteEditor(quote) {
  qe = freshQE(quote);
  _qeDirty = false;
  state.view = 'quote-editor';   // so setView() can detect unsaved changes on back

  // Load existing items if editing
  if (qe.id) {
    const items = await remoteQuery({ action: 'select', table: 'quote_items', where: { quote_id: qe.id } });
    qe.materials  = items.filter(i => i.type === 'material').map(i => ({ ...i, section_label: i.section_label || null }));
    qe.services   = items.filter(i => i.type === 'service').map(i => ({ ...i, section_label: i.section_label || null }));
    qe.exclusions = items.filter(i => i.type === 'exclusion').map(i => i.name);
    // Bijhouden hoeveel items succesvol geladen zijn, als veiligheidsmarge bij opslaan.
    qe._originalItemCount = items.length;
  }

  renderQuoteEditorView();
}

function renderQuoteEditorView() {
  const ctrl = document.getElementById('toolbar-controls');
  ctrl.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="qe-back">← Offertes</button>
    <button class="btn btn-secondary btn-sm" id="qe-delete-btn" ${!qe.id ? 'style="display:none"' : ''}>Verwijder</button>
    <button class="btn btn-secondary btn-sm" id="qe-dup-btn" ${!qe.id ? 'style="display:none"' : ''} title="Maak kopie van deze offerte">⧉ Dupliceer</button>
    <button class="btn btn-secondary btn-sm" id="qe-project-btn" title="Maak project aan voor deze offerte">📁 Project</button>
    <button class="btn btn-secondary btn-sm" id="qe-folder-btn" title="Open projectmap in Finder">📂 Map</button>
    <button class="btn btn-primary btn-sm" id="qe-save-btn">Opslaan</button>
    <div class="pdf-dropdown" id="pdf-dropdown">
      <button class="btn btn-secondary btn-sm" id="qe-pdf-btn">📄 PDF ▾</button>
      <div class="pdf-dropdown-menu hidden" id="pdf-dropdown-menu">
        <button class="pdf-dropdown-item" id="pdf-internal">📋 Interne offerte (volledig)</button>
        <button class="pdf-dropdown-item" id="pdf-client">📄 Klantofferte (eindprijs)</button>
      </div>
    </div>
    <div class="pdf-dropdown" id="mb-dropdown">
      <button class="btn btn-secondary btn-sm" id="qe-mb-btn" ${!qe.id ? 'style="display:none"' : ''} title="Factuur aanmaken in Moneybird">💶 Moneybird ▾</button>
      <div class="pdf-dropdown-menu hidden" id="mb-dropdown-menu">
        <button class="pdf-dropdown-item" id="mb-gespec">📋 Gespecificeerde factuur</button>
        <button class="pdf-dropdown-item" id="mb-totaal">💰 Totaalfactuur</button>
      </div>
    </div>`;

  document.getElementById('toolbar-title').textContent = qe.name || 'Nieuwe offerte';
  document.getElementById('qe-back').onclick = () => setView('quotes');
  document.getElementById('qe-save-btn').onclick = saveQuote;
  document.getElementById('qe-dup-btn')?.addEventListener('click', duplicateQuote);
  document.getElementById('qe-project-btn').onclick = async () => {
    // Sla de offerte eerst op — anders bestaat het project straks wel, maar de
    // (nieuwe/gewijzigde) offerte alleen nog in het geheugen.
    if (!qe.name.trim()) { shake(document.getElementById('qe-name')); toast('Vul een projectnaam in'); return; }
    if (!qe.id || _qeDirty) await performSave();
    const linkName = quoteProjectName();
    await createProjectFromQuote(linkName, true, qe.status === 'accepted' ? 'active' : 'on_hold');
    await linkQuoteToProject(linkName);
  };
  document.getElementById('qe-folder-btn').onclick  = () => openProjectFolder(quoteProjectName());
  document.getElementById('qe-pdf-btn').onclick = () => {
    document.getElementById('mb-dropdown-menu')?.classList.add('hidden');
    document.getElementById('pdf-dropdown-menu').classList.toggle('hidden');
  };
  document.getElementById('pdf-internal').onclick = () => { document.getElementById('pdf-dropdown-menu').classList.add('hidden'); exportQuotePdf('internal'); };
  document.getElementById('pdf-client').onclick = () => { document.getElementById('pdf-dropdown-menu').classList.add('hidden'); exportQuotePdf('client'); };
  document.getElementById('qe-mb-btn')?.addEventListener('click', () => {
    document.getElementById('pdf-dropdown-menu')?.classList.add('hidden');
    document.getElementById('mb-dropdown-menu').classList.toggle('hidden');
  });
  document.getElementById('mb-gespec')?.addEventListener('click', () => { document.getElementById('mb-dropdown-menu').classList.add('hidden'); exportToMoneybird('gespecificeerd'); });
  document.getElementById('mb-totaal')?.addEventListener('click',  () => { document.getElementById('mb-dropdown-menu').classList.add('hidden'); exportToMoneybird('totaal'); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#pdf-dropdown')) document.getElementById('pdf-dropdown-menu')?.classList.add('hidden');
    if (!e.target.closest('#mb-dropdown'))  document.getElementById('mb-dropdown-menu')?.classList.add('hidden');
  });
  document.getElementById('qe-delete-btn')?.addEventListener('click', deleteQuote);

  const content = document.getElementById('content');
  content.innerHTML = `
    <!-- Top fields -->
    <div class="qe-topbar">
      <div class="qe-fields">
        <input class="qi-input qe-name"   id="qe-name"   value="${escHtml(qe.name)}"       placeholder="Projectnaam *" />
        <input class="qi-input qe-date"   id="qe-date"   type="date" value="${qe.quote_date}" />
        <select class="qi-input qe-status" id="qe-status">
          ${quoteStatusOptionsHtml(qe.status)}
        </select>
      </div>
    </div>

    <!-- Project link row -->
    <div class="qe-project-link-row">
      <span class="qe-project-link-label">Project</span>
      <div class="qe-project-link-wrap">
        <input class="qi-input" id="qe-project-link"
               placeholder="Offertenaam wordt gebruikt als projectnaam"
               autocomplete="off"
               value="${escHtml(qe.project_name || '')}" />
        <div class="qe-project-suggestions hidden" id="qe-project-suggestions"></div>
      </div>
      <button class="btn btn-ghost btn-sm" id="qe-project-link-clear" title="Koppeling wissen" style="${qe.project_name ? '' : 'visibility:hidden'}">✕</button>
    </div>

    <!-- Client details (collapsible) -->
    <details class="qe-details" open>
      <summary class="qe-details-title">Klantgegevens</summary>
      <div class="qe-client-picker-row">
        <select id="qe-client-select" class="qi-input">
          <option value="">— Kies bestaande klant —</option>
          ${state.clients.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-ghost btn-sm" id="qe-save-as-client" title="Huidige gegevens opslaan als klant">Opslaan als klant</button>
      </div>
      <div class="qe-client-grid">
        <input class="qi-input" id="qe-client" value="${escHtml(qe.client)}" placeholder="Bedrijf / klantnaam" />
        <input class="qi-input" id="qe-client-contact" value="${escHtml(qe.client_contact)}" placeholder="Contactpersoon" />
        <input class="qi-input" id="qe-client-address" value="${escHtml(qe.client_address)}" placeholder="Adres" />
        <input class="qi-input" id="qe-client-postcode" value="${escHtml(qe.client_postcode)}" placeholder="Postcode + Plaats" />
        <input class="qi-input" id="qe-client-email" value="${escHtml(qe.client_email)}" placeholder="E-mail" type="email" />
        <input class="qi-input" id="qe-client-phone" value="${escHtml(qe.client_phone)}" placeholder="Telefoon" type="tel" />
      </div>
    </details>

    <!-- Images -->
    <input type="file" id="qe-file-input" accept="image/*" style="display:none" />
    <input type="file" id="qe-extra-file-input" accept="image/*" multiple style="display:none" />
    <div class="qe-images-row">
      <div class="qe-img-slot qe-img-main">
        ${qe.image_data
          ? `<div class="qe-image-preview">
               <img src="${qe.image_data}" alt="Hoofdafbeelding" />
               <div class="qe-img-actions">
                 <button class="qe-img-btn" id="qe-img-change-btn">↑ Wijzigen</button>
                 <button class="qe-img-btn qe-img-btn--remove" onclick="qe.image_data='';if(qe.id)localStorage.removeItem('qimg_'+qe.id);renderQuoteEditorView()">✕</button>
               </div>
             </div>`
          : `<button class="qe-add-img-btn" id="qe-img-add-btn">
               <svg viewBox="0 0 20 20" fill="none" style="width:15px;height:15px;vertical-align:middle;margin-right:6px"><rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="7.5" cy="9" r="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 14l4-4 3 3 2-2 5 5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>Hoofdafbeelding
             </button>`
        }
      </div>
      <div class="qe-extra-images" id="qe-extra-images">
        ${(qe.extra_images||[]).map((img, i) => `
          <div class="qe-extra-thumb">
            <img src="${img}" alt="Extra ${i+1}" />
            <button class="qe-extra-del" data-idx="${i}">✕</button>
          </div>`).join('')}
        <button class="qe-extra-add-btn" id="qe-extra-add-btn" title="Extra afbeelding toevoegen">＋</button>
      </div>
    </div>

    <div class="qe-notes-wrap">
      <textarea class="qe-notes" id="qe-notes" placeholder="Toelichting — omschrijf het project, de aanpak of bijzondere afspraken…">${escHtml(qe.notes)}</textarea>
      <button class="btn btn-secondary btn-sm qe-ai-btn" id="qe-ai-gen-btn" type="button" title="Laat AI een toelichting schrijven op basis van je steekwoorden">✨ Genereer</button>
    </div>

    <!-- PDF Options -->
    <details class="qe-details">
      <summary class="qe-details-title">PDF-opties</summary>
      <div class="qe-pdf-opts" id="qe-pdf-opts">
        <label class="qe-opt"><input type="checkbox" data-opt="show_title_page" ${qe.pdf_opts.show_title_page ? 'checked' : ''} /> Titelblad</label>
        <label class="qe-opt"><input type="checkbox" data-opt="show_project_image" ${qe.pdf_opts.show_project_image ? 'checked' : ''} /> Projectafbeelding op titelblad</label>
        <label class="qe-opt"><input type="checkbox" data-opt="show_extra_images" ${qe.pdf_opts.show_extra_images ? 'checked' : ''} /> Extra afbeeldingen (bijlagepagina)</label>
        <label class="qe-opt"><input type="checkbox" data-opt="show_client_address" ${qe.pdf_opts.show_client_address ? 'checked' : ''} /> Klantadres op offerte</label>
        <label class="qe-opt"><input type="checkbox" data-opt="show_exclusions" ${qe.pdf_opts.show_exclusions ? 'checked' : ''} /> Exclusief-lijst</label>
        <label class="qe-opt"><input type="checkbox" data-opt="show_notes" ${qe.pdf_opts.show_notes ? 'checked' : ''} /> Toelichting</label>
        <label class="qe-opt"><input type="checkbox" data-opt="show_validity" ${qe.pdf_opts.show_validity ? 'checked' : ''} /> Geldigheidsclausule (30 dagen)</label>
      </div>
    </details>

    <!-- Materials -->
    <div class="qe-section">
      <div class="qe-section-header">
        <span class="qe-section-title">Materialen</span>
        <div class="qe-margin-ctrl">
          Marge <input type="number" id="qe-margin" value="${qe.margin}" min="0" max="200" step="1" />%
        </div>
      </div>
      <div class="preset-wrap" id="mat-preset-wrap">
        <button class="qe-add-btn" id="mat-add-btn" type="button">＋ Materiaal toevoegen</button>
        <div class="preset-menu hidden" id="mat-preset-menu">
          <input class="preset-search" placeholder="Zoeken…" id="mat-preset-search" autocomplete="off" />
          <div class="preset-list" id="mat-preset-list"></div>
          <button class="preset-empty-btn" id="mat-empty-btn" type="button">＋ Lege regel</button>
        </div>
      </div>
      <table class="qi-table">
        <thead><tr>
          <th style="width:3%"></th>
          <th style="width:3%"></th>
          <th style="width:27%">Omschrijving</th>
          <th style="width:7%">Aantal</th>
          <th style="width:8%">Eenheid</th>
          <th class="num" style="width:7%" title="Marge per item (leeg = globale marge)">%</th>
          <th class="num" style="width:14%">Stukprijs</th>
          <th class="num" style="width:17%">Totaal</th>
          <th style="width:4%"></th>
        </tr></thead>
        <tbody id="mat-tbody"></tbody>
      </table>
      <div class="qe-mat-subtotals" id="mat-subtotals"></div>
    </div>

    <!-- Services -->
    <div class="qe-section">
      <div class="qe-section-header">
        <span class="qe-section-title">Diensten</span>
        <div class="qe-margin-ctrl" title="Marge die wordt toegepast op uitbesteed werk">
          Marge uitbesteed <input type="number" id="qe-out-margin" value="${qe.outsource_margin}" min="0" max="200" step="1" />%
        </div>
      </div>
      <div class="preset-wrap" id="svc-preset-wrap">
        <button class="qe-add-btn" id="svc-add-btn" type="button">＋ Dienst toevoegen</button>
        <div class="preset-menu hidden" id="svc-preset-menu">
          <input class="preset-search" placeholder="Zoeken…" id="svc-preset-search" autocomplete="off" />
          <div class="preset-list" id="svc-preset-list"></div>
          <button class="preset-empty-btn" id="svc-empty-btn" type="button">＋ Lege regel</button>
        </div>
      </div>
      <table class="qi-table">
        <thead><tr>
          <th style="width:3%"></th>
          <th style="width:3%"></th>
          <th style="width:24%">Dienst</th>
          <th style="width:6%" title="Vink aan als deze dienst wordt uitbesteed">Uitb.</th>
          <th style="width:7%">Aantal</th>
          <th style="width:8%">Eenheid</th>
          <th class="num" style="width:7%" title="Marge per item (leeg = geen marge voor eigen werk, globale uitbestedingsmarge voor uitbesteed)">%</th>
          <th class="num" style="width:14%">Tarief</th>
          <th class="num" style="width:13%">Totaal</th>
          <th style="width:4%"></th>
        </tr></thead>
        <tbody id="svc-tbody"></tbody>
      </table>
      <div class="qe-mat-subtotals" id="svc-subtotals"></div>
    </div>

    <!-- Vaste stuksprijs -->
    <div class="qe-section qe-fixed-section">
      <div class="qe-section-header">
        <label class="qe-fixed-toggle-label">
          <input type="checkbox" id="qe-fixed-enabled" ${qe.fixed_enabled ? 'checked' : ''} />
          <span class="qe-section-title">Vaste stuksprijs</span>
        </label>
        <span class="qe-fixed-hint">Zelf bepalen wat je per stuk vraagt (bv. 3× groot blok, 2× klein, 8× middel); eigen verdiensten = verkoopprijs − inkoop materialen</span>
      </div>
      <div class="qe-fixed-body ${qe.fixed_enabled ? '' : 'hidden'}">
        <table class="qi-table">
          <thead><tr>
            <th style="width:46%">Omschrijving</th>
            <th style="width:16%">Aantal</th>
            <th class="num" style="width:17%">Stuksprijs</th>
            <th class="num" style="width:17%">Totaal</th>
            <th style="width:4%"></th>
          </tr></thead>
          <tbody id="fixed-tbody"></tbody>
        </table>
        <button class="qe-add-btn" id="fixed-add-btn" type="button">＋ Regel toevoegen</button>
        <div class="qe-mat-subtotals" id="qe-fixed-total-row"></div>
      </div>
    </div>

    <!-- Exclusions -->
    <div class="qe-section qe-excl-section">
      <div class="qe-section-header">
        <span class="qe-section-title">Exclusief</span>
      </div>
      <div class="excl-list" id="excl-list"></div>
      <div class="excl-add-row">
        <input class="qi-input excl-new-input" id="excl-new-input" placeholder="Toevoegen…" />
        <button class="btn btn-ghost btn-sm" id="excl-add-btn">＋</button>
      </div>
      <div class="excl-presets" id="excl-presets"></div>
    </div>

    <!-- Totals -->
    <div class="qe-totals-panel" id="qe-totals-panel"></div>
  `;

  // Wire preset dropdown menus
  wirePresetMenus();

  // Wire live-field changes (header fields)
  document.getElementById('qe-name').addEventListener('input',   e => { qe.name = e.target.value; document.getElementById('toolbar-title').textContent = qe.name || 'Nieuwe offerte'; markQEDirty(); });
  document.getElementById('qe-client').addEventListener('input',  e => { qe.client = e.target.value; markQEDirty(); });
  document.getElementById('qe-client-contact').addEventListener('input', e => { qe.client_contact = e.target.value; markQEDirty(); });
  document.getElementById('qe-client-address').addEventListener('input', e => { qe.client_address = e.target.value; markQEDirty(); });
  document.getElementById('qe-client-postcode').addEventListener('input', e => { qe.client_postcode = e.target.value; markQEDirty(); });
  document.getElementById('qe-client-email').addEventListener('input', e => { qe.client_email = e.target.value; markQEDirty(); });
  document.getElementById('qe-client-phone').addEventListener('input', e => { qe.client_phone = e.target.value; markQEDirty(); });

  // Client picker — selecting an existing client fills the fields
  document.getElementById('qe-client-select').addEventListener('change', e => {
    const id = parseInt(e.target.value);
    if (!id) return;
    const c = state.clients.find(cl => cl.id === id);
    if (!c) return;
    qe.client          = c.name;
    qe.client_contact  = c.contact  || '';
    qe.client_address  = c.address  || '';
    qe.client_postcode = c.postcode || '';
    qe.client_email    = c.email    || '';
    qe.client_phone    = c.phone    || '';
    document.getElementById('qe-client').value          = qe.client;
    document.getElementById('qe-client-contact').value  = qe.client_contact;
    document.getElementById('qe-client-address').value  = qe.client_address;
    document.getElementById('qe-client-postcode').value = qe.client_postcode;
    document.getElementById('qe-client-email').value    = qe.client_email;
    document.getElementById('qe-client-phone').value    = qe.client_phone;
    markQEDirty();
    e.target.value = ''; // reset dropdown
  });

  // Save current client fields to the clients database
  const saveAsClientBtn = document.getElementById('qe-save-as-client');
  if (saveAsClientBtn) saveAsClientBtn.onclick = async () => {
    try {
      // Read directly from DOM so we always get the latest typed value
      const name = (document.getElementById('qe-client')?.value || '').trim();
      if (!name) { toast('Voer eerst een klantnaam in', 'error'); return; }
      const clientData = {
        name,
        contact:  (document.getElementById('qe-client-contact')?.value  || '').trim(),
        address:  (document.getElementById('qe-client-address')?.value  || '').trim(),
        postcode: (document.getElementById('qe-client-postcode')?.value || '').trim(),
        email:    (document.getElementById('qe-client-email')?.value    || '').trim(),
        phone:    (document.getElementById('qe-client-phone')?.value    || '').trim(),
      };
      const existing = state.clients.find(c => c.name.trim().toLowerCase() === name.toLowerCase());
      if (existing) {
        if (!confirm(`Klant "${name}" bestaat al. Gegevens bijwerken?`)) return;
        await remoteQuery({ action: 'update', table: 'clients', data: clientData, where: { id: existing.id } });
        toast(`Klant "${name}" bijgewerkt`);
      } else {
        await remoteQuery({ action: 'insert', table: 'clients', data: clientData });
        toast(`Klant "${name}" opgeslagen`);
      }
      await loadClients();
      // Refresh the select dropdown without re-rendering the whole editor
      const sel = document.getElementById('qe-client-select');
      if (sel) {
        sel.innerHTML = '<option value="">— Kies bestaande klant —</option>' +
          state.clients.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
      }
    } catch (err) {
      toast('Fout bij opslaan klant: ' + (err.message || err), 'error', 4000);
      console.error('save-as-client error:', err);
    }
  };
  // Project link autocomplete
  (function wireProjectLink() {
    const projInput = document.getElementById('qe-project-link');
    const projSugg  = document.getElementById('qe-project-suggestions');
    const projClear = document.getElementById('qe-project-link-clear');
    if (!projInput) return;

    function buildSuggestions(filter) {
      const q = (filter || '').trim().toLowerCase();
      const matches = state.projects.filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 10);
      if (!matches.length) { projSugg.classList.add('hidden'); return; }
      projSugg.innerHTML = matches.map(p =>
        `<div class="qe-project-suggestion-item" data-name="${escHtml(p.name)}">${escHtml(p.name)}</div>`
      ).join('');
      projSugg.classList.remove('hidden');
    }

    projInput.addEventListener('focus', () => buildSuggestions(projInput.value));
    projInput.addEventListener('input', e => {
      qe.project_name = e.target.value.trim();
      projClear.style.visibility = qe.project_name ? '' : 'hidden';
      buildSuggestions(e.target.value);
      markQEDirty();
    });
    projInput.addEventListener('blur', () => setTimeout(() => projSugg.classList.add('hidden'), 150));
    projInput.addEventListener('keydown', e => { if (e.key === 'Escape') projSugg.classList.add('hidden'); });
    projSugg.addEventListener('mousedown', e => {
      const item = e.target.closest('[data-name]');
      if (!item) return;
      projInput.value = item.dataset.name;
      qe.project_name = item.dataset.name;
      projClear.style.visibility = '';
      projSugg.classList.add('hidden');
      markQEDirty();
    });
    projClear.onclick = () => {
      projInput.value = '';
      qe.project_name = '';
      projClear.style.visibility = 'hidden';
      projSugg.classList.add('hidden');
      markQEDirty();
    };
  })();

  document.getElementById('qe-date').addEventListener('change',   e => { qe.quote_date = e.target.value; markQEDirty(); });
  document.getElementById('qe-status').addEventListener('change', async e => {
    if (qe.id) {
      await changeQuoteStatus(qe, e.target.value);
      toast('Status opgeslagen');
    } else {
      qe.status = e.target.value;
      markQEDirty();
    }
  });
  document.getElementById('qe-notes').addEventListener('input',   e => { qe.notes = e.target.value; markQEDirty(); });
  document.getElementById('qe-ai-gen-btn').onclick = generateToelichtingLLM;
  document.getElementById('qe-margin').addEventListener('focus',  e => e.target.select());
  document.getElementById('qe-margin').addEventListener('input',  e => {
    qe.margin = parseFloat(e.target.value) || 0;
    document.querySelectorAll('.qi-margin').forEach(inp => { inp.placeholder = qe.margin; });
    updateTotals();
    markQEDirty();
  });
  const outMarginEl = document.getElementById('qe-out-margin');
  if (outMarginEl) {
    outMarginEl.addEventListener('focus', e => e.target.select());
    outMarginEl.addEventListener('input', e => {
      qe.outsource_margin = parseFloat(e.target.value) || 0;
      updateSvcSubtotals();
      updateTotals();
      markQEDirty();
    });
  }

  // Vaste stuksprijs wiring
  const fixedEnabled = document.getElementById('qe-fixed-enabled');
  const fixedBody    = document.querySelector('.qe-fixed-body');
  const fixedAddBtn   = document.getElementById('fixed-add-btn');

  if (fixedEnabled) {
    fixedEnabled.addEventListener('change', e => {
      qe.fixed_enabled = e.target.checked;
      if (e.target.checked) {
        if (!qe.fixed_items.length) qe.fixed_items.push({ name: '', quantity: 1, unit_price: 0 });
        fixedBody?.classList.remove('hidden');
        renderFixedTable();
      } else {
        fixedBody?.classList.add('hidden');
      }
      updateTotals();
      markQEDirty();
    });
  }
  if (fixedAddBtn) {
    fixedAddBtn.addEventListener('click', () => {
      qe.fixed_items.push({ name: '', quantity: 1, unit_price: 0 });
      renderFixedTable();
      updateTotals();
      markQEDirty();
    });
  }

  // PDF options wiring
  document.querySelectorAll('#qe-pdf-opts input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => { qe.pdf_opts[cb.dataset.opt] = cb.checked; });
  });

  // Main image change / add wiring
  const qeFileInput = document.getElementById('qe-file-input');
  qeFileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { qe.image_data = ev.target.result; renderQuoteEditorView(); };
    reader.readAsDataURL(file);
  });
  document.getElementById('qe-img-change-btn')?.addEventListener('click', () => qeFileInput.click());
  document.getElementById('qe-img-add-btn')?.addEventListener('click',    () => qeFileInput.click());

  // Extra images wiring
  const extraInput = document.getElementById('qe-extra-file-input');
  extraInput.addEventListener('change', e => {
    const files = [...e.target.files];
    let loaded = 0;
    files.forEach(f => {
      const reader = new FileReader();
      reader.onload = ev => {
        qe.extra_images.push(ev.target.result);
        loaded++;
        if (loaded === files.length) renderQuoteEditorView();
      };
      reader.readAsDataURL(f);
    });
    extraInput.value = '';
  });
  document.getElementById('qe-extra-add-btn')?.addEventListener('click', () => extraInput.click());
  document.querySelectorAll('.qe-extra-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      qe.extra_images.splice(parseInt(btn.dataset.idx), 1);
      renderQuoteEditorView();
    });
  });

  renderMatTable();
  renderSvcTable();
  renderFixedTable();
  wireExclusions();
  updateTotals();
  updateChecklistBadge();
}

// ─── Render sub-tables ────────────────────────────────────────────────────────

function renderMatTable() {
  const tbody = document.getElementById('mat-tbody');
  if (!tbody) return;

  let _lastMatSection = null;
  const itemRows = qe.materials.map((m, i) => {
    let header = '';
    if (m.section_label && m.section_label !== _lastMatSection) {
      header = `<tr class="qi-section-hdr"><td colspan="9">${escHtml(m.section_label)}</td></tr>`;
      _lastMatSection = m.section_label;
    }
    return header + `
    <tr draggable="true" data-idx="${i}" class="${m.enabled === 0 ? 'qi-row-disabled' : ''}">
      <td class="drag-handle" title="Versleep">⠿</td>
      <td style="text-align:center"><input type="checkbox" class="qi-check qi-enabled" data-t="mat" data-i="${i}" data-f="enabled" ${m.enabled !== 0 ? 'checked' : ''} title="Post aan/uit" /></td>
      <td><input class="qi-input" data-t="mat" data-i="${i}" data-f="name"       value="${escHtml(m.name)}"       placeholder="Omschrijving" /></td>
      <td><input class="qi-input num" data-t="mat" data-i="${i}" data-f="quantity"  value="${m.quantity ?? 1}"  type="number" min="0" step="any" /></td>
      <td><input class="qi-input qi-unit" data-t="mat" data-i="${i}" data-f="unit" value="${escHtml(m.unit ?? 'st')}" placeholder="st" maxlength="8" /></td>
      <td><input class="qi-input num qi-margin" data-t="mat" data-i="${i}" data-f="margin" value="${m.margin ?? ''}" type="number" min="0" max="500" step="1" placeholder="${qe.margin}" title="Marge % (leeg = globaal ${qe.margin}%)" /></td>
      <td><input class="qi-input num" data-t="mat" data-i="${i}" data-f="unit_price" value="${m.unit_price ?? 0}" type="number" min="0" step="any" /></td>
      <td class="num" id="mat-row-total-${i}">${m.enabled !== 0 ? fmtEur((m.quantity ?? 1) * (m.unit_price ?? 0)) : '—'}</td>
      <td><button class="qi-del" data-t="mat" data-i="${i}">✕</button></td>
    </tr>`;
  }).join('');
  const emptySections = (qe.merged_sections || [])
    .filter(label => !qe.materials.some(m => m.section_label === label))
    .map(label => `<tr class="qi-section-hdr"><td colspan="9">${escHtml(label)} — Materialen</td></tr><tr class="qi-section-empty"><td colspan="9">Geen materialen</td></tr>`)
    .join('');
  tbody.innerHTML = itemRows + emptySections || `<tr><td colspan="9" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik een materiaal hierboven om toe te voegen</td></tr>`;

  wireTableInputs('mat');
  wireDragDrop('mat');
  updateMatSubtotals();
}

function renderSvcTable() {
  const tbody = document.getElementById('svc-tbody');
  if (!tbody) return;

  let _lastSvcSection = null;
  const itemRows = qe.services.map((s, i) => {
    let header = '';
    if (s.section_label && s.section_label !== _lastSvcSection) {
      header = `<tr class="qi-section-hdr"><td colspan="10">${escHtml(s.section_label)}</td></tr>`;
      _lastSvcSection = s.section_label;
    }
    return header + `
    <tr draggable="true" data-idx="${i}" class="${s.is_outsourced ? 'svc-row-outsourced' : ''}${s.enabled === 0 ? ' qi-row-disabled' : ''}">
      <td class="drag-handle" title="Versleep">⠿</td>
      <td style="text-align:center"><input type="checkbox" class="qi-check qi-enabled" data-t="svc" data-i="${i}" data-f="enabled" ${s.enabled !== 0 ? 'checked' : ''} title="Post aan/uit" /></td>
      <td><input class="qi-input" data-t="svc" data-i="${i}" data-f="name"       value="${escHtml(s.name)}"      placeholder="Dienst" /></td>
      <td style="text-align:center"><input type="checkbox" class="qi-check" data-t="svc" data-i="${i}" data-f="is_outsourced" ${s.is_outsourced ? 'checked' : ''} title="Uitbesteed werk" /></td>
      <td><input class="qi-input num" data-t="svc" data-i="${i}" data-f="quantity"  value="${s.quantity ?? 1}" type="number" min="0" step="0.5" /></td>
      <td><input class="qi-input qi-unit" data-t="svc" data-i="${i}" data-f="unit" value="${escHtml(s.unit ?? 'uur')}" placeholder="uur" maxlength="8" /></td>
      <td class="svc-margin-cell">
        <span class="svc-mrgna">—</span>
        <input class="qi-input num qi-margin svc-margin-inp" data-t="svc" data-i="${i}" data-f="margin" value="${s.margin ?? ''}" type="number" min="0" max="500" step="1" placeholder="${qe.outsource_margin ?? 0}" title="Marge % (leeg = globale uitbestedingsmarge van ${qe.outsource_margin ?? 0}%)" />
      </td>
      <td class="num"><input class="qi-input num" data-t="svc" data-i="${i}" data-f="unit_price" value="${s.unit_price ?? 0}" type="number" min="0" step="any" /></td>
      <td class="num" id="svc-row-total-${i}">${s.enabled !== 0 ? fmtEur((s.quantity ?? 1) * (s.unit_price ?? 0)) : '—'}</td>
      <td><button class="qi-del" data-t="svc" data-i="${i}">✕</button></td>
    </tr>`;
  }).join('');
  const emptySections = (qe.merged_sections || [])
    .filter(label => !qe.services.some(s => s.section_label === label))
    .map(label => `<tr class="qi-section-hdr"><td colspan="10">${escHtml(label)} — Diensten</td></tr><tr class="qi-section-empty"><td colspan="10">Geen diensten</td></tr>`)
    .join('');
  tbody.innerHTML = itemRows + emptySections || `<tr><td colspan="10" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik een dienst hierboven om toe te voegen</td></tr>`;

  wireTableInputs('svc');
  wireDragDrop('svc');
  updateSvcSubtotals();
}

function renderFixedTable() {
  const tbody = document.getElementById('fixed-tbody');
  if (!tbody) return;

  tbody.innerHTML = qe.fixed_items.map((it, i) => `
    <tr>
      <td><input class="qi-input" data-i="${i}" data-f="name" value="${escHtml(it.name || '')}" placeholder="bv. Groot blok" /></td>
      <td><input class="qi-input num" data-i="${i}" data-f="quantity" value="${it.quantity ?? 1}" type="number" min="0" step="any" /></td>
      <td><input class="qi-input num" data-i="${i}" data-f="unit_price" value="${it.unit_price ?? 0}" type="number" min="0" step="any" /></td>
      <td class="num" id="fixed-row-total-${i}">${fmtEur((it.quantity ?? 1) * (it.unit_price ?? 0))}</td>
      <td><button class="qi-del" data-i="${i}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="5" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik "Regel toevoegen" om een stuksprijs-regel toe te voegen</td></tr>`;

  wireFixedTableInputs();
  updateFixedTotalRow();
}

function updateFixedTotalRow() {
  const el = document.getElementById('qe-fixed-total-row');
  if (!el) return;
  const total = qe.fixed_items.reduce((s, it) => s + (it.quantity ?? 1) * (it.unit_price ?? 0), 0);
  el.innerHTML = `<div class="row bold"><span>Totaal vaste stuksprijs</span><span>${fmtEur(total)}</span></div>`;
}

function wireFixedTableInputs() {
  const tbody = document.getElementById('fixed-tbody');
  if (!tbody) return;

  tbody.querySelectorAll('.qi-input').forEach(inp => {
    if (inp.type === 'number') inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.i);
      const field = inp.dataset.f;
      if (!qe.fixed_items[i]) return;
      qe.fixed_items[i][field] = field === 'name' ? inp.value : (parseFloat(inp.value) || 0);
      const rowTotal = document.getElementById(`fixed-row-total-${i}`);
      if (rowTotal) rowTotal.textContent = fmtEur((qe.fixed_items[i].quantity ?? 1) * (qe.fixed_items[i].unit_price ?? 0));
      updateFixedTotalRow();
      updateTotals();
      markQEDirty();
    });
  });

  tbody.querySelectorAll('.qi-del').forEach(btn => {
    btn.onclick = () => {
      const i = parseInt(btn.dataset.i);
      qe.fixed_items.splice(i, 1);
      renderFixedTable();
      updateTotals();
      markQEDirty();
    };
  });
}

function wireTableInputs(type) {
  const tbody = document.getElementById(type === 'mat' ? 'mat-tbody' : 'svc-tbody');
  if (!tbody) return;

  tbody.querySelectorAll('.qi-input').forEach(inp => {
    if (inp.type === 'number') inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.i);
      const field = inp.dataset.f;
      const arr = type === 'mat' ? qe.materials : qe.services;
      if (!arr[i]) return;
      if (field === 'name' || field === 'unit') {
        arr[i][field] = inp.value;
      } else if (field === 'margin') {
        arr[i][field] = inp.value === '' ? null : (parseFloat(inp.value) ?? null);
      } else {
        arr[i][field] = parseFloat(inp.value) || 0;
      }
      // Update just the row total cell
      const rowTotal = document.getElementById(`${type}-row-total-${i}`);
      if (rowTotal) rowTotal.textContent = fmtEur(arr[i].quantity * arr[i].unit_price);
      if (type === 'mat') updateMatSubtotals();
      if (type === 'svc') updateSvcSubtotals();
      updateTotals();
      markQEDirty();
    });
  });

  tbody.querySelectorAll('.qi-check').forEach(chk => {
    chk.addEventListener('change', () => {
      const i = parseInt(chk.dataset.i);
      const field = chk.dataset.f;
      const arr = type === 'mat' ? qe.materials : qe.services;
      if (!arr[i]) return;
      arr[i][field] = chk.checked ? 1 : 0;
      const row = chk.closest('tr');
      if (field === 'enabled') {
        // Toggle disabled styling and re-render just the total cell
        if (row) row.classList.toggle('qi-row-disabled', !chk.checked);
        const rowTotal = document.getElementById(`${type}-row-total-${i}`);
        if (rowTotal) rowTotal.textContent = chk.checked ? fmtEur(arr[i].quantity * arr[i].unit_price) : '—';
      } else {
        // Toggle the outsourced styling on the row (CSS handles margin cell visibility)
        if (row) row.classList.toggle('svc-row-outsourced', !!chk.checked);
        // Clear per-item margin when unchecking outsourced — it no longer applies
        if (field === 'is_outsourced' && !chk.checked) {
          arr[i].margin = null;
          const marginInp = row?.querySelector('.svc-margin-inp');
          if (marginInp) marginInp.value = '';
        }
      }
      if (type === 'mat') updateMatSubtotals();
      if (type === 'svc') updateSvcSubtotals();
      updateTotals();
      markQEDirty();
    });
  });

  tbody.querySelectorAll('.qi-del').forEach(btn => {
    btn.onclick = () => {
      const i = parseInt(btn.dataset.i);
      if (type === 'mat') { qe.materials.splice(i, 1); renderMatTable(); }
      else                { qe.services.splice(i, 1);  renderSvcTable(); }
      updateTotals();
      markQEDirty();
    };
  });
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────

let _dragSrcIdx = null;
let _dragType   = null;

function wireDragDrop(type) {
  const tbody = document.getElementById(type === 'mat' ? 'mat-tbody' : 'svc-tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => {
      _dragSrcIdx = parseInt(row.dataset.idx);
      _dragType   = type;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (_dragType !== type || _dragSrcIdx === null) return;
      const tgtIdx = parseInt(row.dataset.idx);
      if (_dragSrcIdx === tgtIdx) return;
      const arr = type === 'mat' ? qe.materials : qe.services;
      const [moved] = arr.splice(_dragSrcIdx, 1);
      arr.splice(tgtIdx, 0, moved);
      _dragSrcIdx = null;
      if (type === 'mat') { renderMatTable(); updateTotals(); }
      else { renderSvcTable(); updateTotals(); }
      markQEDirty();
    });
  });
}

// ─── Preset Dropdown Menus ────────────────────────────────────────────────────

function wirePresetMenus() {
  _wirePresetMenu('mat', PRESET_MATERIALS,
    p    => { qe.materials.push({ name: p.name, quantity: 1, unit: p.unit, unit_price: p.price ?? 0, margin: null }); renderMatTable(); updateTotals(); markQEDirty(); },
    name => { qe.materials.push({ name: name || '', quantity: 1, unit: 'st', unit_price: 0, margin: null }); renderMatTable(); updateTotals(); markQEDirty(); }
  );
  _wirePresetMenu('svc', PRESET_SERVICES,
    p    => { qe.services.push({ name: p.name, quantity: 1, unit: p.unit || 'uur', unit_price: p.rate ?? 0, margin: null }); renderSvcTable(); updateTotals(); markQEDirty(); },
    name => { qe.services.push({ name: name || '', quantity: 1, unit: 'uur', unit_price: 0, margin: null }); renderSvcTable(); updateTotals(); markQEDirty(); }
  );
}

function _wirePresetMenu(type, presets, onAdd, onEmpty) {
  const addBtn   = document.getElementById(`${type}-add-btn`);
  const menu     = document.getElementById(`${type}-preset-menu`);
  const search   = document.getElementById(`${type}-preset-search`);
  const list     = document.getElementById(`${type}-preset-list`);
  const emptyBtn = document.getElementById(`${type}-empty-btn`);
  if (!addBtn || !menu) return;

  const renderList = (filter = '') => {
    const lc = filter.trim().toLowerCase();
    const groups = {};
    presets.forEach(p => {
      if (lc && !p.name.toLowerCase().includes(lc)) return;
      const cat = p.category || 'Overig';
      (groups[cat] = groups[cat] || []).push(p);
    });
    const entries = Object.entries(groups);

    // "Aanmaken: [naam]" row when search text matches nothing exactly
    const exactMatch = presets.some(p => p.name.toLowerCase() === lc);
    const customRow = (filter.trim() && !exactMatch) ? `
      <div class="preset-item preset-item--custom" data-custom="${escHtml(filter.trim())}">
        <span>＋ Aanmaken: <strong>${escHtml(filter.trim())}</strong></span>
      </div>` : '';

    list.innerHTML = customRow + (entries.length ? entries.map(([cat, items]) => `
      <div class="preset-group">
        <div class="preset-group-label">${cat}</div>
        ${items.map(p => `
          <div class="preset-item" data-name="${escHtml(p.name)}">
            <span>${escHtml(p.name)}</span>
            <span class="preset-item-meta">${p.rate != null ? `€${p.rate}/u` : p.price != null ? `€${p.price}` : ''}</span>
          </div>`).join('')}
      </div>`).join('')
      : (!filter.trim() ? `<div class="preset-no-results">Geen resultaten</div>` : ''));

    list.querySelectorAll('.preset-item[data-name]').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        const p = presets.find(x => x.name === item.dataset.name);
        if (p) onAdd(p);
        closeAllPresetMenus();
      });
    });
    list.querySelectorAll('.preset-item--custom').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        const name = item.dataset.custom;
        onEmpty(name);  // pass name to create a pre-filled empty row
        closeAllPresetMenus();
      });
    });
  };

  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    closeAllPresetMenus();
    if (!isOpen) {
      menu.classList.remove('hidden');
      search.value = '';
      renderList();
      search.focus();
    }
  });

  search.addEventListener('input', () => renderList(search.value));
  search.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllPresetMenus(); });
  emptyBtn.addEventListener('mousedown', e => { e.preventDefault(); onEmpty(''); closeAllPresetMenus(); });
}

function closeAllPresetMenus() {
  ['mat', 'svc'].forEach(t => document.getElementById(`${t}-preset-menu`)?.classList.add('hidden'));
}

// ─── Exclusions ───────────────────────────────────────────────────────────────

const DEFAULT_EXCLUSIONS = [
  'Transportkosten',
  'Parkeerkosten',
  'Meerwerk buiten scope',
  'Stickerwerk / belettering',
  'Aanlevering 3D-bestanden door klant',
  'Hef- of kraankosten',
  'Vergunningen',
  'Opslag na levering',
  'Elektra / stroom op locatie',
  'Ontwerp­aanpassingen na goedkeuring',
];

const DEFAULT_CHECKLIST = [
  'Is duidelijk of transport inbegrepen is of niet?',
  'Is duidelijk dat de offerte gebaseerd is op een 3D-model aangeleverd door de klant?',
  'Is duidelijk dat wij alleen de basiskleur schilderen en stickerwerk voor rekening van de klant is?',
];

function renderExclusions() {
  const list = document.getElementById('excl-list');
  if (!list) return;

  list.innerHTML = qe.exclusions.map((ex, i) => `
    <div class="excl-item" data-idx="${i}">
      <span class="excl-text">${escHtml(ex)}</span>
      <button class="excl-del" data-i="${i}" title="Verwijder">✕</button>
    </div>`).join('');

  list.querySelectorAll('.excl-del').forEach(btn => {
    btn.addEventListener('click', () => {
      qe.exclusions.splice(parseInt(btn.dataset.i), 1);
      renderExclusions();
    });
  });

  // Preset suggestions: only show those not yet added
  const presets = document.getElementById('excl-presets');
  if (!presets) return;
  const added = new Set(qe.exclusions.map(e => e.toLowerCase()));
  const available = PRESET_EXCLUSIONS.filter(e => !added.has(e.toLowerCase()));

  presets.innerHTML = available.length
    ? available.map(e => `<button class="excl-suggest-btn" data-val="${escHtml(e)}">${escHtml(e)}</button>`).join('')
    : '';

  presets.querySelectorAll('.excl-suggest-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qe.exclusions.push(btn.dataset.val);
      renderExclusions();
      markQEDirty();
    });
  });
}

function wireExclusions() {
  const input = document.getElementById('excl-new-input');
  const addBtn = document.getElementById('excl-add-btn');
  if (!input || !addBtn) return;

  const addExcl = () => {
    const val = input.value.trim();
    if (!val) return;
    qe.exclusions.push(val);
    input.value = '';
    renderExclusions();
    markQEDirty();
  };

  addBtn.addEventListener('click', addExcl);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addExcl(); } });
  renderExclusions();
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function calcQuoteTotals(items, globalMargin, outsourceMargin) {
  // Only include enabled items (enabled === 0 means toggled off)
  const activeItems = items.filter(i => i.enabled !== 0);
  const matItems = activeItems.filter(i => i.type === 'material');
  const svcItems = activeItems.filter(i => i.type === 'service');
  // Use explicit null checks so 0% margin isn't overridden by the default
  const globalMarginPct    = (globalMargin    != null && globalMargin    !== '') ? parseFloat(globalMargin)    : 20;
  const outsourceMarginPct = (outsourceMargin != null && outsourceMargin !== '') ? parseFloat(outsourceMargin) : 0;

  // Materials: cost-passthrough + margin
  const matEx = matItems.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const matTotal = matItems.reduce((s, i) => {
    const pct = (i.margin != null && i.margin !== '') ? parseFloat(i.margin) : globalMarginPct;
    return s + (i.quantity * i.unit_price * (1 + pct / 100));
  }, 0);
  const matMargin = matTotal - matEx;

  // Services: split into self vs outsourced
  const svcSelfItems = svcItems.filter(i => !i.is_outsourced);
  const svcOutItems  = svcItems.filter(i =>  i.is_outsourced);
  // Self services: per-item margin if set; otherwise unit_price is already the selling price (no markup)
  const svcSelfTotal = svcSelfItems.reduce((s, i) => {
    const pct = (i.margin != null && i.margin !== '') ? parseFloat(i.margin) : 0;
    return s + (i.quantity * i.unit_price * (1 + pct / 100));
  }, 0);
  // Outsourced: per-item margin overrides global outsource margin
  const svcOutCost   = svcOutItems.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const svcOutTotal  = svcOutItems.reduce((s, i) => {
    const pct = (i.margin != null && i.margin !== '') ? parseFloat(i.margin) : outsourceMarginPct;
    return s + (i.quantity * i.unit_price * (1 + pct / 100));
  }, 0);
  const svcOutMargin = svcOutTotal - svcOutCost;
  const svcTotal     = svcSelfTotal + svcOutTotal;

  const subtotal = matTotal + svcTotal;
  const btw = subtotal * 0.21;
  const grandTotal = subtotal + btw;

  // Profit = own labour revenue + margins on materials and outsourced work
  const profit = svcSelfTotal + matMargin + svcOutMargin;

  return {
    matEx, matMargin, matTotal,
    svcSelfTotal, svcOutCost, svcOutMargin, svcOutTotal, svcTotal,
    subtotal, btw, grandTotal,
    marginPct: globalMarginPct, outsourceMarginPct,
    profit,
  };
}

// Computes the subtotal (excl. BTW) for a quote row + its raw quote_items,
// used to backfill quotes.total_price for legacy quotes saved before that column existed.
function computeLegacyQuoteSubtotal(quote, items) {
  let extras = {};
  try { extras = JSON.parse(quote.extras_json || '{}') || {}; } catch (_) {}
  const fixedItems = getQuoteFixedItems(extras);
  if (fixedItems.length) {
    return fixedItems.reduce((s, it) => s + (it.quantity ?? 1) * (it.unit_price ?? 0), 0);
  }
  return calcQuoteTotals(items, quote.margin, extras.outsource_margin ?? 0).subtotal;
}

// Berekent de geoffreerde "eigen verdiensten" (de winst die in de offerte was
// ingecalculeerd: eigen-arbeidsomzet + marge op materiaal/uitbesteed werk, dus
// exclusief de cost-passthrough) — voor vergelijking met de daadwerkelijke winst
// (offertebedrag minus werkelijke Moneybird-kosten) in de Bedrijfsanalyse.
function computeQuoteProfit(quote, items) {
  let extras = {};
  try { extras = JSON.parse(quote.extras_json || '{}') || {}; } catch (_) {}
  const fixedItems = getQuoteFixedItems(extras);
  if (fixedItems.length) {
    const matInkoop    = items.filter(i => i.enabled !== 0 && i.type === 'material')
      .reduce((s, i) => s + (i.quantity ?? 1) * (i.unit_price ?? 0), 0);
    const svcOutInkoop = items.filter(i => i.enabled !== 0 && i.type === 'service' && i.is_outsourced)
      .reduce((s, i) => s + (i.quantity ?? 1) * (i.unit_price ?? 0), 0);
    const revenue = fixedItems.reduce((s, it) => s + (it.quantity ?? 1) * (it.unit_price ?? 0), 0);
    return revenue - matInkoop - svcOutInkoop;
  }
  return calcQuoteTotals(items, quote.margin, extras.outsource_margin ?? 0).profit;
}

function calcQETotals() {
  // Vaste stuksprijs modus: verkoopprijs per stuk is handmatig bepaald, met meerdere
  // regels mogelijk (bv. 3x groot blok, 2x klein, 8x middel, elk met eigen stuksprijs).
  if (qe.fixed_enabled && qe.fixed_items?.length) {
    const matInkoop     = qe.materials.filter(m => m.enabled !== 0)
      .reduce((s, m) => s + (m.quantity ?? 1) * (m.unit_price ?? 0), 0);
    const svcOutInkoop  = qe.services.filter(s => s.enabled !== 0 && s.is_outsourced)
      .reduce((s, sv) => s + (sv.quantity ?? 1) * (sv.unit_price ?? 0), 0);
    const revenue    = qe.fixed_items.reduce((s, it) => s + (it.quantity ?? 1) * (it.unit_price ?? 0), 0);
    const profit     = revenue - matInkoop - svcOutInkoop;
    const subtotal   = revenue;
    const btw        = subtotal * 0.21;
    return {
      matEx: matInkoop, matMargin: 0, matTotal: matInkoop,
      svcSelfTotal: 0, svcOutCost: 0, svcOutMargin: 0, svcOutTotal: 0, svcTotal: 0,
      subtotal, btw, grandTotal: subtotal + btw,
      marginPct: 0, outsourceMarginPct: qe.outsource_margin,
      profit,
      isFixedPrice: true, fixedRevenue: revenue, fixedItems: qe.fixed_items,
    };
  }
  // Standaard marge-modus
  const allItems = [
    ...qe.materials.map(i => ({ ...i, type: 'material' })),
    ...qe.services.map(i => ({ ...i, type: 'service' })),
  ];
  return calcQuoteTotals(allItems, qe.margin, qe.outsource_margin);
}

function margeLabel(marginPct) {
  // Only show % when all materials use the same (global) margin
  const hasOverride = qe?.materials?.some(m => m.margin != null && m.margin !== '' && parseFloat(m.margin) !== marginPct);
  return hasOverride ? 'Marge' : `Marge (${marginPct}%)`;
}

function updateMatSubtotals() {
  const el = document.getElementById('mat-subtotals');
  if (!el || !qe) return;
  const t = calcQETotals();
  if (t.isFixedPrice) {
    el.innerHTML = `
      <div class="row"><span>Inkoop materialen</span><span>${fmtEur(t.matEx)}</span></div>`;
  } else {
    el.innerHTML = `
      <div class="row"><span>Subtotaal materialen</span><span>${fmtEur(t.matEx)}</span></div>
      <div class="row"><span>${margeLabel(t.marginPct)}</span><span>+ ${fmtEur(t.matMargin)}</span></div>
      <div class="row bold"><span>Totaal materialen</span><span>${fmtEur(t.matTotal)}</span></div>`;
  }
}

function updateSvcSubtotals() {
  const el = document.getElementById('svc-subtotals');
  if (!el || !qe) return;
  const t = calcQETotals();
  if (t.isFixedPrice) {
    el.innerHTML = '';  // diensten tellen niet mee in vaste-prijs-modus
    return;
  }
  const hasOutsourced = t.svcOutCost > 0;
  el.innerHTML = `
    <div class="row"><span>Eigen diensten</span><span>${fmtEur(t.svcSelfTotal)}</span></div>
    ${hasOutsourced ? `
      <div class="row"><span>Uitbesteed (kostprijs)</span><span>${fmtEur(t.svcOutCost)}</span></div>
      <div class="row"><span>Marge uitbesteed (${t.outsourceMarginPct}%)</span><span>+ ${fmtEur(t.svcOutMargin)}</span></div>
    ` : ''}
    <div class="row bold"><span>Totaal diensten</span><span>${fmtEur(t.svcTotal)}</span></div>`;
}

function updateTotals() {
  updateMatSubtotals();
  updateSvcSubtotals();
  const el = document.getElementById('qe-totals-panel');
  if (!el || !qe) return;
  const t = calcQETotals();

  if (t.isFixedPrice) {
    el.innerHTML = `
      <div class="qt-row"><span class="qt-label">Inkoop materialen</span><span class="qt-val">${fmtEur(t.matEx)}</span></div>
      <div class="qt-divider"></div>
      <div class="qt-row"><span class="qt-label">Totaal verkoopprijs</span><span class="qt-val">${fmtEur(t.fixedRevenue)}</span></div>
      <div class="qt-row"><span class="qt-label">BTW (21%)</span><span class="qt-val">+ ${fmtEur(t.btw)}</span></div>
      <div class="qt-row final"><span class="qt-label">TOTAAL excl. BTW</span><span class="qt-val">${fmtEur(t.subtotal)}</span></div>
      <div class="qt-row incl-note"><span class="qt-label">Incl. BTW</span><span class="qt-val">${fmtEur(t.grandTotal)}</span></div>
      <div class="qt-divider"></div>
      <div class="qt-row profit"><span class="qt-label">Eigen verdiensten</span><span class="qt-val">${fmtEur(t.profit)}</span></div>`;
    return;
  }

  const hasOutsourced = t.svcOutCost > 0;
  el.innerHTML = `
    <div class="qt-row"><span class="qt-label">Materialen (excl. marge)</span><span class="qt-val">${fmtEur(t.matEx)}</span></div>
    <div class="qt-row"><span class="qt-label">${margeLabel(t.marginPct)}</span><span class="qt-val">+ ${fmtEur(t.matMargin)}</span></div>
    <div class="qt-row"><span class="qt-label">Totaal materialen</span><span class="qt-val">${fmtEur(t.matTotal)}</span></div>
    <div class="qt-row"><span class="qt-label">Eigen diensten</span><span class="qt-val">${fmtEur(t.svcSelfTotal)}</span></div>
    ${hasOutsourced ? `
      <div class="qt-row"><span class="qt-label">Uitbesteed (kostprijs)</span><span class="qt-val">${fmtEur(t.svcOutCost)}</span></div>
      <div class="qt-row"><span class="qt-label">Marge uitbesteed (${t.outsourceMarginPct}%)</span><span class="qt-val">+ ${fmtEur(t.svcOutMargin)}</span></div>
    ` : ''}
    <div class="qt-divider"></div>
    <div class="qt-row final"><span class="qt-label">TOTAAL excl. BTW</span><span class="qt-val">${fmtEur(t.subtotal)}</span></div>
    <div class="qt-row"><span class="qt-label">BTW (21%)</span><span class="qt-val">+ ${fmtEur(t.btw)}</span></div>
    <div class="qt-row incl-note"><span class="qt-label">Incl. BTW</span><span class="qt-val">${fmtEur(t.grandTotal)}</span></div>
    <div class="qt-divider"></div>
    <div class="qt-row profit"><span class="qt-label">Eigen verdiensten</span><span class="qt-val">${fmtEur(t.profit)}</span></div>`;
}

// ─── Save / Delete Quote ──────────────────────────────────────────────────────

function openSaveChecklist(onConfirm) {
  const container = document.getElementById('checklist-items');
  container.innerHTML = PRESET_CHECKLIST.map((item, i) => `
    <div class="checklist-item" data-idx="${i}">
      <input type="checkbox" id="clcb-${i}" class="cl-cb" />
      <label for="clcb-${i}">${escHtml(item)}</label>
    </div>`).join('');

  const confirmBtn = document.getElementById('checklist-confirm');
  confirmBtn.disabled = true;

  const updateConfirm = () => {
    const allChecked = [...container.querySelectorAll('.cl-cb')].every(c => c.checked);
    confirmBtn.disabled = !allChecked;
  };

  container.querySelectorAll('.checklist-item').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      const cb = row.querySelector('.cl-cb');
      cb.checked = !cb.checked;
      row.classList.toggle('checked', cb.checked);
      updateConfirm();
    });
  });
  container.querySelectorAll('.cl-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.checklist-item').classList.toggle('checked', cb.checked);
      updateConfirm();
    });
  });

  document.getElementById('checklist-cancel').onclick = () =>
    document.getElementById('checklist-overlay').classList.add('hidden');

  document.getElementById('checklist-confirm').onclick = () => {
    document.getElementById('checklist-overlay').classList.add('hidden');
    onConfirm();
  };

  document.getElementById('checklist-overlay').classList.remove('hidden');
}

async function saveQuote() {
  if (!qe.name.trim()) { shake(document.getElementById('qe-name')); toast('Vul een projectnaam in'); return; }
  if (qe.checklist_done) {
    await performSave();
  } else {
    openSaveChecklist(() => { qe.checklist_done = true; updateChecklistBadge(); performSave(); });
  }
}

function updateChecklistBadge() {
  const btn = document.getElementById('qe-save-btn');
  if (!btn) return;
  btn.title = qe.checklist_done ? '✓ Controlelijst afgerond' : '';
  // Small dot indicator on save button
  let dot = btn.querySelector('.checklist-dot');
  if (qe.checklist_done && !dot) {
    dot = document.createElement('span');
    dot.className = 'checklist-dot';
    dot.title = 'Controlelijst afgerond';
    btn.appendChild(dot);
  } else if (!qe.checklist_done && dot) {
    dot.remove();
  }
}

let _savingQuote = false;
async function performSave() {
  if (_savingQuote) return;
  _savingQuote = true;
  const _saveTotals = calcQETotals();
  const extrasJson = JSON.stringify({
    client_contact: qe.client_contact,
    client_address: qe.client_address,
    client_postcode: qe.client_postcode,
    client_email: qe.client_email,
    client_phone: qe.client_phone,
    extra_images: qe.extra_images,
    pdf_opts: qe.pdf_opts,
    outsource_margin: qe.outsource_margin,
    fixed_items: qe.fixed_enabled ? qe.fixed_items : [],
    merged_sections: qe.merged_sections || [],
  });
  const quoteData = {
    name: qe.name.trim(), client: qe.client.trim(), quote_date: qe.quote_date,
    margin: qe.margin, status: qe.status, notes: qe.notes.trim(),
    project_name: qe.project_name || '',
    variant_group: qe.variant_group || '',
    created_by: state.config?.name || '',
    image_data: qe.image_data || '',
    extras_json: extrasJson,
    total_price: _saveTotals.subtotal,
  };

  try {
    let quoteId = qe.id;
    if (quoteId) {
      // Veiligheidscheck: als de offerte bij openen items had maar de huidige staat leeg is,
      // blokkeer dan het opslaan. Dit voorkomt dat een laad- of netwerkfout alle regels wist.
      const currentItemCount = qe.materials.length + qe.services.length + qe.exclusions.length;
      if (currentItemCount === 0 && (qe._originalItemCount ?? 0) > 0) {
        toast('Opslaan geblokkeerd: offerte lijkt leeg terwijl er eerder regels waren. Heropen de offerte en probeer opnieuw.', 'error', 7000);
        _savingQuote = false;
        return false;
      }
    }

    const allItems = [
      ...qe.materials.map((m, i) => ({ type: 'material', name: m.name, quantity: m.quantity, unit: m.unit || '', unit_price: m.unit_price, sort_order: i, margin: (m.margin == null || m.margin === '') ? null : parseFloat(m.margin), is_outsourced: 0, enabled: m.enabled !== 0 ? 1 : 0, ...(m.section_label ? { section_label: m.section_label } : {}) })),
      ...qe.services.map((s, i)  => ({ type: 'service',  name: s.name, quantity: s.quantity, unit: 'uur', unit_price: s.unit_price, sort_order: i, margin: null, is_outsourced: s.is_outsourced ? 1 : 0, enabled: s.enabled !== 0 ? 1 : 0, ...(s.section_label ? { section_label: s.section_label } : {}) })),
      ...qe.exclusions.map((ex, i) => ({ type: 'exclusion', name: ex, quantity: 0, unit: '', unit_price: 0, sort_order: i, margin: null, is_outsourced: 0, enabled: 1 })),
    ];
    const saved = await remoteQuery({
      action: 'save_quote',
      table: 'quotes',
      data: { id: quoteId, quote: quoteData, items: allItems },
    });
    quoteId = saved.id;
    qe.id = quoteId;

    // Cleanup legacy localStorage entries (now stored in DB)
    if (quoteId) {
      localStorage.removeItem('qimg_' + quoteId);
      localStorage.removeItem('qextra_' + quoteId);
    }

    const delBtn = document.getElementById('qe-delete-btn');
    if (delBtn) delBtn.style.display = '';

    _qeDirty = false;
    toast('Offerte opgeslagen');

    // When status is "verzonden" or "geaccepteerd", offer to create a matching project
    if ((qe.status === 'sent' || qe.status === 'accepted') && qe.name) {
      const linkName = quoteProjectName();
      const existing = state.projects.find(p => p.name.trim().toLowerCase() === linkName.toLowerCase());
      await createProjectFromQuote(linkName, /*silent=*/false, qe.status === 'accepted' ? 'active' : 'on_hold');
      await linkQuoteToProject(linkName);
    }
    return true;
  } catch (err) {
    toast('Opslaan mislukt: ' + (err.message || err), 'error', 4000);
    console.error('saveQuote error:', err);
    return false;
  } finally {
    _savingQuote = false;
  }
}

async function deleteQuote() {
  if (!qe.id) return;
  if (!confirm(`Offerte "${qe.name}" verwijderen?`)) return;
  await remoteQuery({ action: 'delete', table: 'quotes', where: { id: qe.id } });
  qe = null;
  toast('Offerte verwijderd');
  setView('quotes');
}

// ─── Duplicate Quote ─────────────────────────────────────────────────────────

async function duplicateQuote() {
  if (!qe.id) { toast('Sla de offerte eerst op', 'warn'); return; }
  try {
    // A duplicate is normally an alternative for the same enquiry. Group the
    // original and its copy immediately, so the pipeline never double-counts it.
    const variantGroup = qe.variant_group || quoteVariantGroupId();
    if (!qe.variant_group) {
      await remoteQuery({ action: 'update', table: 'quotes', data: { variant_group: variantGroup }, where: { id: qe.id } });
      qe.variant_group = variantGroup;
    }
    const extrasJson = JSON.stringify({
      client_contact:  qe.client_contact,
      client_address:  qe.client_address,
      client_postcode: qe.client_postcode,
      client_email:    qe.client_email,
      client_phone:    qe.client_phone,
      extra_images:    qe.extra_images,
      pdf_opts:        qe.pdf_opts,
      outsource_margin: qe.outsource_margin,
      fixed_items: qe.fixed_enabled ? qe.fixed_items : [],
      merged_sections: qe.merged_sections || [],
    });
    const newQuoteData = {
      name:       qe.name + ' (kopie)',
      project_name: quoteProjectName(), // keep linked to the same project/folder as the original
      variant_group: variantGroup,
      client:     qe.client,
      quote_date: toDateStr(new Date()),
      margin:     qe.margin,
      status:     'draft',
      notes:      qe.notes,
      created_by: state.config?.name || '',
      image_data: qe.image_data || '',
      extras_json: extrasJson,
      total_price: calcQETotals().subtotal,
    };
    const res = await remoteQuery({ action: 'insert', table: 'quotes', data: newQuoteData });
    const newId = res.id;
    const allItems = [
      ...qe.materials.map((m, i) => ({ quote_id: newId, type: 'material', name: m.name, quantity: m.quantity, unit: m.unit || '', unit_price: m.unit_price, sort_order: i, margin: (m.margin == null || m.margin === '') ? null : parseFloat(m.margin), is_outsourced: 0, enabled: m.enabled !== 0 ? 1 : 0 })),
      ...qe.services.map( (s, i) => ({ quote_id: newId, type: 'service',  name: s.name, quantity: s.quantity, unit: 'uur', unit_price: s.unit_price, sort_order: i, margin: null, is_outsourced: s.is_outsourced ? 1 : 0, enabled: s.enabled !== 0 ? 1 : 0 })),
      ...qe.exclusions.map((ex, i) => ({ quote_id: newId, type: 'exclusion', name: ex, quantity: 0, unit: '', unit_price: 0, sort_order: i, margin: null, is_outsourced: 0, enabled: 1 })),
    ];
    for (const item of allItems) {
      await remoteQuery({ action: 'insert', table: 'quote_items', data: item });
    }
    toast('Offerte gedupliceerd als variant — alleen de hoogste open variant telt mee');
    await openQuoteEditor({ id: newId, ...newQuoteData });
  } catch (err) {
    toast('Dupliceren mislukt: ' + (err.message || err), 'error', 4000);
  }
}

// ─── Moneybird Integration ────────────────────────────────────────────────────

/* ─── AI Toelichting Genereren ─────────────────────────────────────────────── */
async function generateToelichtingLLM() {
  const token = state.config?.anthropicToken;
  if (!token) {
    toast('Geen Anthropic API-sleutel ingesteld. Ga naar Instellingen → AI-assistent.', 'error', 4000);
    return;
  }
  const textarea = document.getElementById('qe-notes');
  const keywords = textarea.value.trim();
  if (!keywords) {
    toast('Typ eerst een paar steekwoorden in het toelichtingsveld.', 'info', 3000);
    return;
  }
  const btn = document.getElementById('qe-ai-gen-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Genereren…';
  try {
    const requestBody = _buildToelichtingRequest(keywords);
    const text = await _sendClaudeRequest(token, requestBody);
    textarea.value = text;
    qe.notes = text;
    markQEDirty();
  } catch (err) {
    toast(`AI-fout: ${err.message}`, 'error', 5000);
    console.error('[Claude API]', err);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Genereer';
  }
}

// Bouwt de Claude-request inclusief projectfoto en offertegegevens (materialen/diensten/klant) als context
function _buildToelichtingRequest(keywords) {
  const contextLines = [];
  if (qe.name)   contextLines.push(`Projectnaam: ${qe.name}`);
  if (qe.client) contextLines.push(`Klant: ${qe.client}`);

  const mats = (qe.materials || []).filter(m => m.enabled !== 0 && m.name?.trim());
  if (mats.length) {
    contextLines.push(`Materialen: ${mats.map(m => `${m.name} (${m.quantity ?? 1} ${m.unit || 'st'})`).join(', ')}`);
  }
  const svcs = (qe.services || []).filter(s => s.enabled !== 0 && s.name?.trim());
  if (svcs.length) {
    contextLines.push(`Diensten: ${svcs.map(s => `${s.name} (${s.quantity ?? 1} ${s.unit || 'uur'})`).join(', ')}`);
  }
  const context = contextLines.join('\n');

  let imageBlock = null;
  const m = (qe.image_data || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (m) imageBlock = { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };

  const prompt = `Je schrijft een professionele toelichting voor een offerte van een bouw- of verbouwbedrijf.
Schrijf op basis van de steekwoorden${imageBlock ? ', de bijgevoegde projectfoto' : ''}${context ? ' en de offertegegevens' : ''} hieronder een vloeiende, beknopte alinea van 2-4 zinnen die past als projectomschrijving in een offerte.
Gebruik zakelijke maar toegankelijke taal. Schrijf in het Nederlands. Verzin geen materialen, diensten of details die niet genoemd zijn of niet op de foto te zien zijn.

Steekwoorden: ${keywords}
${context ? `\nOffertegegevens:\n${context}` : ''}

Geef alleen de toelichting zelf, zonder aanhalingstekens of extra uitleg.`;

  const content = imageBlock ? [imageBlock, { type: 'text', text: prompt }] : prompt;

  return {
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{ role: 'user', content }],
  };
}

async function _sendClaudeRequest(token, requestBody) {
  if (window.__WEB_MODE__) {
    // In browser/Pi mode: route through server proxy to avoid CORS
    const r = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, body: requestBody }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data.content?.[0]?.text?.trim() || '';
  } else {
    // In Electron mode: call Claude API directly via IPC
    const result = await api.apiFetch({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      body: requestBody,
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
      },
    });
    if (result.status >= 400) {
      throw new Error(result.data?.error?.message || `Claude API ${result.status}: ${JSON.stringify(result.data)}`);
    }
    return result.data?.content?.[0]?.text?.trim() || '';
  }
}

async function _moneybirdRaw(method, url, token, body) {
  console.log('[Moneybird]', method, url);
  if (window.__WEB_MODE__) {
    const r = await fetch('/api/moneybird', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, url, token, body: body ?? null }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Moneybird ${r.status} ${url}: ${text}`);
    try { return JSON.parse(text); } catch (_) { return text; }
  } else {
    const result = await api.apiFetch({
      method, url, body: body ?? null,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (result.status >= 400) {
      throw new Error(`Moneybird ${result.status} ${url}: ${JSON.stringify(result.data)}`);
    }
    return result.data;
  }
}

let _moneybirdAdminId = null;

async function getMoneybirdAdminId() {
  if (_moneybirdAdminId) return _moneybirdAdminId;
  const token = state.config?.moneybirdToken;
  if (!token) throw new Error('Geen Moneybird API-token ingesteld. Ga naar Instellingen.');
  const admins = await _moneybirdRaw('GET', 'https://moneybird.com/api/v2/administrations.json', token, null);
  if (!Array.isArray(admins) || admins.length === 0) throw new Error('Geen Moneybird-administratie gevonden voor dit token');
  _moneybirdAdminId = admins[0].id;
  return _moneybirdAdminId;
}

async function moneybirdFetch(method, path, body) {
  const token = state.config?.moneybirdToken;
  if (!token) throw new Error('Geen Moneybird API-token ingesteld. Ga naar Instellingen.');
  const adminId = await getMoneybirdAdminId();
  const url = `https://moneybird.com/api/v2/${adminId}/${path}`;
  return _moneybirdRaw(method, url, token, body);
}

/* ─── Bedrijfsanalyse / Business Coach ─────────────────────────────────────────
   Alle berekeningen hieronder (snapshot, waarschuwingen, score) zijn pure,
   lokale functies zonder Claude-aanroep — gratis en instant. Alleen de
   AI-Inzichten/Advies-generatie en de chat kosten een Anthropic API-call. */

// Drempelwaarden — heuristieken, vrij aan te passen zonder de rest te raken.
const BIZ_THRESHOLDS = {
  minOrderportefeuilleMonths: 1,    // < 1 maand dekking aan geaccepteerd werk = waarschuwing
  maxOutstandingVsAvgRevenue: 0.5,  // openstaand > 50% van gemiddelde maandomzet = waarschuwing
  longRunningProjectDays: 60,       // actief project ouder dan 60 dagen = "langlopend"
  minNewQuotesPer30Days: 2,         // minder dan 2 nieuwe offertes/maand = waarschuwing
  idealActiveProjectsMin: 2,        // projectbelasting-score is 10 binnen dit bereik
  idealActiveProjectsMax: 6,
  laterReminderDays: 60,            // "later"-offerte ouder dan 2 maanden -> follow-up-herinnering
  sentReminderDays: 14,             // verzonden offerte zonder reactie na 2 weken -> follow-up-herinnering
};

const MB_OUTSTANDING_STATES = ['open', 'late', 'reminded', 'pending_payment'];
const MB_EXCLUDED_REVENUE_STATES = ['draft', 'uncollectible'];

// Haalt álle verkoopfacturen op (all-time) — voor een 6 maanden oud bedrijf is
// dit een handvol pagina's, dus simpeler en betrouwbaarder dan filteren op
// Moneybird's period/filter-syntax en daarna alsnog moeten samenvoegen.
async function fetchAllMoneybirdInvoices() {
  let all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await moneybirdFetch('GET', `sales_invoices.json?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Inkoopfacturen (kosten van leveranciers) — nodig om kosten per Moneybird-Project
// (de native Project-koppeling die op factuurregels wordt gezet) te kunnen optellen.
async function fetchAllMoneybirdPurchaseInvoices() {
  let all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await moneybirdFetch('GET', `documents/purchase_invoices.json?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Bonnetjes (receipts) zijn een apart Moneybird-documenttype naast leveranciers-
// facturen — ze worden op dezelfde manier aan een project gekoppeld maar staan
// onder een andere endpoint. Combineer ze met purchase invoices voor kosten per project.
async function fetchAllMoneybirdReceipts() {
  let all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await moneybirdFetch('GET', `documents/receipts.json?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Alle Moneybird-Projecten (state:all, dus ook gearchiveerde — anders mist een
// gearchiveerd project zijn kosten in het overzicht zodra het project klaar is).
async function fetchAllMoneybirdProjects() {
  let all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await moneybirdFetch('GET', `projects.json?filter=state:all&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
  }
  return all;
}

function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function monthLabel(d) { return d.toLocaleDateString('nl-NL', { month: 'short', year: '2-digit' }); }

async function computeBusinessSnapshot() {
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth    = new Date(startOfThisMonth.getTime() - 1);
  const yearStart         = new Date(now.getFullYear(), 0, 1);
  const dayOfYear         = Math.ceil((now - yearStart) / 86400000);
  const ANNUAL_HOURS      = 2 * 40 * 46; // 3680 uur/jaar (2 man × 40u × 46 weken)
  const hoursYTD          = ANNUAL_HOURS * (dayOfYear / 365);

  // Haal projecten altijd opnieuw op. De Moneybird-koppeling kan net zijn aangepast
  // (ook vanaf een andere computer); state.projects is dan nog de oude kopie.
  // Zonder deze verse bron worden actuele Moneybird-bedragen met een verouderde
  // projectkoppeling gecombineerd.
  const [quotes, invoices, rawPurchaseInvoices, receipts, mbProjects, quoteItemsAll, projects] = await Promise.all([
    remoteQuery({ action: 'select', table: 'quotes', columns: ['id', 'name', 'client', 'quote_date', 'total_price', 'status', 'created_at', 'project_name', 'variant_group', 'later_since', 'later_snoozed_until', 'sent_since', 'sent_snoozed_until', 'margin', 'extras_json'] }),
    fetchAllMoneybirdInvoices().catch(e => { console.warn('Moneybird snapshot fout:', e); return null; }),
    fetchAllMoneybirdPurchaseInvoices().catch(e => { console.warn('Moneybird kosten-snapshot fout:', e); return null; }),
    fetchAllMoneybirdReceipts().catch(e => { console.warn('Moneybird bonnetjes-snapshot fout:', e); return null; }),
    fetchAllMoneybirdProjects().catch(e => { console.warn('Moneybird projecten-snapshot fout:', e); return null; }),
    remoteQuery({ action: 'select', table: 'quote_items' }),
    remoteQuery({ action: 'select', table: 'projects' }),
  ]);
  // Combineer leveranciersfacturen en bonnetjes — beide hebben dezelfde structuur
  // (details[].project_id, total_price_excl_tax). Alleen null als BEIDE falen (→ costsError).
  const purchaseInvoices = (rawPurchaseInvoices === null && receipts === null)
    ? null
    : [...(rawPurchaseInvoices || []), ...(receipts || [])];
  state.projects = projects;
  const stages    = state.stages?.length    ? state.stages    : await remoteQuery({ action: 'select', table: 'project_stages' });
  const stageSlots = state.stageSlots?.length ? state.stageSlots : await remoteQuery({ action: 'select', table: 'stage_slots' });

  // ── Lokale data: offertes & projecten ──
  const rawOpenQuotes  = quotes.filter(q => q.status === 'draft' || q.status === 'sent');
  // A variant group represents several alternatives for one enquiry. For pipeline
  // value, retain the highest-priced open quote in every group; ungrouped quotes
  // remain independent.
  const openQuotesByEnquiry = new Map();
  rawOpenQuotes.forEach(q => {
    const key = q.variant_group ? `group:${q.variant_group}` : `quote:${q.id}`;
    const current = openQuotesByEnquiry.get(key);
    if (!current || Number(q.total_price || 0) > Number(current.total_price || 0)) {
      openQuotesByEnquiry.set(key, q);
    }
  });

  const openQuotes = [...openQuotesByEnquiry.values()];
  const openQuoteVariantsIgnored = rawOpenQuotes.length - openQuotes.length;
  // "later"-offertes (nog niet relevant, bv. seizoensgebonden) horen niet bij de actieve
  // pijplijn — ze tellen niet mee in openQuotesValue/orderportefeuille, maar worden wel
  // los getoond zodat ze niet uit het zicht verdwijnen.
  const laterQuotes    = quotes.filter(q => q.status === 'later');
  // Follow-up-herinnering: een "later"-offerte die al >= 2 maanden zo staat (en niet
  // gesnoozed is) moet weer onder de aandacht komen. later_since is leeg voor offertes
  // die al "later" waren vóór deze feature bestond — val dan terug op created_at/quote_date.
  const staleLaterQuotes = laterQuotes.filter(q => {
    const since = q.later_since ? new Date(q.later_since) : new Date(q.created_at || q.quote_date);
    const ageDays = (now - since) / 86400000;
    if (ageDays < BIZ_THRESHOLDS.laterReminderDays) return false;
    if (q.later_snoozed_until && new Date(q.later_snoozed_until) > now) return false;
    return true;
  });
  // Follow-up-herinnering voor verzonden offertes zonder reactie: zelfde mechanisme als
  // "later", maar met een drempel van 2 weken — sent_since is leeg voor offertes die al
  // verzonden waren vóór deze feature bestond, val dan terug op created_at/quote_date.
  const sentQuotes = quotes.filter(q => q.status === 'sent');
  const staleSentQuotes = sentQuotes.filter(q => {
    const since = q.sent_since ? new Date(q.sent_since) : new Date(q.created_at || q.quote_date);
    const ageDays = (now - since) / 86400000;
    if (ageDays < BIZ_THRESHOLDS.sentReminderDays) return false;
    if (q.sent_snoozed_until && new Date(q.sent_snoozed_until) > now) return false;
    return true;
  });
  // Algemene/interne projecten (bv. "Algemeen") horen niet bij de actieve pijplijn —
  // ze blijven gewoon 'active' (zichtbaar in Gantt/kalender), maar tellen hier niet mee.
  const activeProjects = projects.filter(p => p.status === 'active' && !p.exclude_from_analysis);

  // Projectbelasting moet de Gantt-planning meewegen: een project dat pas over 2
  // maanden ingepland staat, drukt nu nog niet op de capaciteit. We pakken de
  // vroegste ingeplande startdatum (via stage_slots, met fallback op de oudere
  // project_stages.start_date en als laatste op het project zelf) — pas als die
  // datum in het verleden of heden ligt (of er is geen planning bekend) telt het
  // project mee als "actief belastend".
  const projectEarliestStart = proj => {
    const stageIds = new Set(stages.filter(s => s.project_id === proj.id).map(s => s.id));
    const dates = [];
    stageSlots.forEach(sl => { if (stageIds.has(sl.stage_id) && sl.start_date) dates.push(new Date(sl.start_date)); });
    stages.forEach(s => { if (s.project_id === proj.id && s.start_date) dates.push(new Date(s.start_date)); });
    if (dates.length) return new Date(Math.min(...dates.map(d => d.getTime())));
    return proj.start_date ? new Date(proj.start_date) : null;
  };
  const isProjectStarted = proj => {
    const es = projectEarliestStart(proj);
    return !es || es <= now;
  };
  const currentlyActiveProjects = activeProjects.filter(isProjectStarted);
  const upcomingProjects        = activeProjects.filter(p => !isProjectStarted(p));
  // Echt nog niet ingepland = geen enkele planning bekend (geen stage_slot,
  // geen stage-startdatum, geen project-startdatum). Zodra je het inplant,
  // krijgt het een startdatum en valt het hier weg — de teller dáált dan.
  const unplannedProjects       = activeProjects.filter(p => projectEarliestStart(p) === null);

  // Een geaccepteerde offerte waarvan het gekoppelde project al "Afgerond" is, is al
  // geleverd (en vrijwel zeker al gefactureerd) — die hoort niet meer in de orderport-
  // efeuille (toekomstige, nog te factureren omzet). Koppeling via project_name/naam,
  // zelfde matching als createProjectFromQuote elders in dit bestand.
  const findLinkedProject = q => {
    const linkName = (q.project_name || q.name || '').trim().toLowerCase();
    if (!linkName) return null;
    return projects.find(p => p.name.trim().toLowerCase() === linkName) || null;
  };
  const allAcceptedQuotes = quotes.filter(q => q.status === 'accepted');
  const acceptedQuotes = [];       // nog te factureren -> telt mee in orderportefeuille
  const fulfilledQuotes = [];      // project al afgerond -> al geleverd, niet meetellen
  allAcceptedQuotes.forEach(q => {
    const proj = findLinkedProject(q);
    (proj && proj.status === 'done' ? fulfilledQuotes : acceptedQuotes).push(q);
  });

  // Kosten per project, via Moneybird's eigen Project-koppeling op inkoopfactuur-
  // regels (purchase_invoice.details[].project_id) — matcht op projectnaam met onze
  // eigen projects-tabel, zelfde aanpak als findLinkedProject hierboven voor offertes.
  // Moneybird-projecten zonder match (bv. naam wijkt af) worden apart getoond i.p.v.
  // stilletjes genegeerd, zodat een naamsverschil opvalt in plaats van data te verliezen.
  const costsError = purchaseInvoices === null || mbProjects === null;
  const mbProjectNameById = new Map((mbProjects || []).map(p => [p.id, p.name]));
  const costByMbProjectId = new Map(); // mbProjectId -> { name, cost }
  (purchaseInvoices || []).forEach(inv => {
    (inv.details || []).forEach(d => {
      if (!d.project_id) return;
      const projName = mbProjectNameById.get(d.project_id);
      if (!projName) return;
      const amount = Number(d.total_price_excl_tax_with_discount) || 0;
      const entry = costByMbProjectId.get(d.project_id) || { name: projName, cost: 0 };
      entry.cost += amount;
      costByMbProjectId.set(d.project_id, entry);
    });
  });
  const costsByProject = [];
  const unmatchedProjectCosts = [];
  costByMbProjectId.forEach((entry, mbId) => {
    // Eerst de handmatige koppeling (moneybird_project_id) checken — die wint altijd
    // over naam-matching, zodat een eerder gelegde koppeling niet weer "verdwijnt"
    // zodra iemand de naam in Moneybird of deze app wijzigt.
    const linked = projects.find(p => mbIdsOf(p).includes(String(mbId)));
    const localMatch = linked || projects.find(p => p.name.trim().toLowerCase() === entry.name.trim().toLowerCase());
    // Verzamelprojecten (bv. "Algemeen") zijn met exclude_from_analysis bewust uit de
    // analyse gehouden — die mogen niet via de kostenkant alsnog binnensluipen.
    if (localMatch && localMatch.exclude_from_analysis) return;
    if (localMatch) costsByProject.push({ name: localMatch.name, cost: entry.cost });
    else unmatchedProjectCosts.push({ name: entry.name, cost: entry.cost, mbProjectId: mbId });
  });
  costsByProject.sort((a, b) => b.cost - a.cost);
  unmatchedProjectCosts.sort((a, b) => b.cost - a.cost);

  let costsYTD = null;
  if (Array.isArray(purchaseInvoices)) {
    costsYTD = purchaseInvoices.reduce((s, inv) => {
      if (!inv.date || new Date(inv.date) < yearStart) return s;
      return s + (Number(inv.total_price_excl_tax) || 0);
    }, 0);
  }

  // Overzicht van de handmatig gelegde Moneybird-koppelingen (voor het ontkoppelen).
  const explicitMbLinks = [];
  projects.forEach(p => {
    mbIdsOf(p).forEach(mbId => {
      explicitMbLinks.push({
        projectId: p.id, projectName: p.name, mbId: String(mbId),
        mbName: mbProjectNameById.get(mbId) || mbProjectNameById.get(String(mbId)) || `Moneybird-project ${mbId}`,
      });
    });
  });

  // Omzet per project, via dezelfde Moneybird-Project-koppeling maar dan op verkoop-
  // factuurregels (sales_invoice.details[].project_id). Moneybird's eigen "netto
  // resultaat per project" (Omzet/Kosten per project-rapport) is gebaseerd op wat er
  // daadwerkelijk geboekt/gefactureerd én aan het project getagd is — niet op het
  // (mogelijk afwijkende) offertebedrag. Daarom hier apart bijhouden i.p.v. te
  // vertrouwen op quotes.total_price, anders wijkt onze "werkelijke winst" af van
  // wat in Moneybird zelf te zien is.
  const revenueByMbProjectId = new Map(); // mbProjectId -> omzet
  (invoices || []).forEach(inv => {
    if (MB_EXCLUDED_REVENUE_STATES.includes(inv.state)) return;
    (inv.details || []).forEach(d => {
      if (!d.project_id) return;
      const amount = Number(d.total_price_excl_tax_with_discount) || 0;
      revenueByMbProjectId.set(d.project_id, (revenueByMbProjectId.get(d.project_id) || 0) + amount);
    });
  });
  const actualRevenueByProjectName = new Map(); // lowercased lokale naam -> omzet
  revenueByMbProjectId.forEach((amount, mbId) => {
    const linked = projects.find(p => mbIdsOf(p).includes(String(mbId)));
    const mbName = mbProjectNameById.get(mbId);
    const localMatch = linked || (mbName && projects.find(p => p.name.trim().toLowerCase() === mbName.trim().toLowerCase()));
    if (!localMatch || localMatch.exclude_from_analysis) return;
    const key = localMatch.name.trim().toLowerCase();
    actualRevenueByProjectName.set(key, (actualRevenueByProjectName.get(key) || 0) + amount);
  });

  // Marge per project: vergelijk de geoffreerde "eigen verdiensten" (de winst die
  // bij het maken van de offerte was ingecalculeerd — dus ná aftrek van de cost-
  // passthrough van materiaal/uitbesteed werk, niet het volledige offertebedrag)
  // met de daadwerkelijke winst. Voor die laatste gebruiken we, zodra beschikbaar,
  // de omzet die in Moneybird zelf aan het project getagd is (zelfde basis als
  // Moneybird's eigen netto-resultaat-rapport); zolang er nog niets is gefactureerd/
  // getagd vallen we terug op de offertewaarde als voorlopige inschatting.
  const quoteItemsByQuoteId = new Map();
  (quoteItemsAll || []).forEach(it => {
    const arr = quoteItemsByQuoteId.get(it.quote_id) || [];
    arr.push(it);
    quoteItemsByQuoteId.set(it.quote_id, arr);
  });
  const quoteValueByProjectName = new Map(); // lowercased naam -> { name, quoteValue, quoteCount, estimatedProfit }
  allAcceptedQuotes.forEach(q => {
    const linkName = (q.project_name || q.name || '').trim();
    if (!linkName) return;
    const linkedProj = findLinkedProject(q);
    if (linkedProj && linkedProj.exclude_from_analysis) return;
    const key = linkName.toLowerCase();
    const entry = quoteValueByProjectName.get(key) || { name: linkName, quoteValue: 0, quoteCount: 0, estimatedProfit: 0 };
    entry.quoteValue += Number(q.total_price) || 0;
    entry.quoteCount += 1;
    entry.estimatedProfit += computeQuoteProfit(q, quoteItemsByQuoteId.get(q.id) || []);
    quoteValueByProjectName.set(key, entry);
  });
  // Eén lokaal project kan aan meerdere Moneybird-projecten gekoppeld zijn. Tel
  // daarom alle kostenregels met dezelfde lokale projectnaam op; Map([...]) zou
  // anders de vorige waarde overschrijven (bijv. €258,59 door €69,00).
  const costByProjectName = new Map();
  costsByProject.forEach(c => {
    const key = c.name.toLowerCase();
    costByProjectName.set(key, (costByProjectName.get(key) || 0) + c.cost);
  });
  const marginProjectKeys = new Set([...quoteValueByProjectName.keys(), ...costByProjectName.keys(), ...actualRevenueByProjectName.keys()]);
  const projectMargins = [];
  const activeProjectMargins = [];
  marginProjectKeys.forEach(key => {
    const localProj = projects.find(p => p.name.trim().toLowerCase() === key);
    const q = quoteValueByProjectName.get(key);
    const cost = costByProjectName.get(key) || 0;
    const quoteValue = q ? q.quoteValue : 0;
    const estimatedProfit = q ? q.estimatedProfit : null;
    const name = q ? q.name
      : costsByProject.find(c => c.name.toLowerCase() === key)?.name
      || localProj?.name || key;
    const taggedRevenue = actualRevenueByProjectName.get(key) || 0;
    const revenueIsActual = taggedRevenue > 0;
    const actualRevenue = revenueIsActual ? taggedRevenue : quoteValue;
    const actualProfit = actualRevenue - cost;
    const profitRatioPct = (estimatedProfit != null && estimatedProfit > 0) ? (actualProfit / estimatedProfit) * 100 : null;
    const startDate = localProj?.start_date || '';
    const base = { name, quoteValue, cost, estimatedProfit, actualRevenue, actualProfit, profitRatioPct, revenueIsActual, hasQuote: !!q, hasCost: costByProjectName.has(key), startDate, projectId: localProj?.id || null, analysisAcknowledged: !!localProj?.analysis_acknowledged, analysisNote: localProj?.analysis_note || '' };
    if (!localProj || localProj.status === 'done') {
      projectMargins.push(base);
    } else if (!localProj.exclude_from_analysis && q) {
      // Lopend project met offerte: toon als prognose onder apart kopje
      activeProjectMargins.push(base);
    }
  });
  // Sterkste presteerders eerst; zonder ratio onderaan.
  const sortProjectMargins = arr => arr.sort((a, b) => {
    if (a.profitRatioPct === null && b.profitRatioPct === null) return b.cost - a.cost;
    if (a.profitRatioPct === null) return 1;
    if (b.profitRatioPct === null) return -1;
    return b.profitRatioPct - a.profitRatioPct;
  });
  sortProjectMargins(projectMargins);
  sortProjectMargins(activeProjectMargins);

  const sumPrice = list => list.reduce((s, q) => s + (Number(q.total_price) || 0), 0);
  const openQuotesValue     = sumPrice(openQuotes);
  const orderportefeuille   = sumPrice(acceptedQuotes);
  const laterQuotesValue    = sumPrice(laterQuotes);
  const fulfilledQuotesValue = sumPrice(fulfilledQuotes);

  const daysAgo = n => new Date(now.getTime() - n * 86400000);
  const quoteCreated = q => new Date(q.created_at || q.quote_date);
  const newQuotes30d   = quotes.filter(q => quoteCreated(q) >= daysAgo(30)).length;
  const newQuotesPrev30d = quotes.filter(q => quoteCreated(q) >= daysAgo(60) && quoteCreated(q) < daysAgo(30)).length;

  const longRunningProjects = activeProjects.filter(p => {
    if (!p.start_date) return false;
    return (now - new Date(p.start_date)) / 86400000 > BIZ_THRESHOLDS.longRunningProjectDays;
  });

  // ── Moneybird data: omzet, trend, openstaande facturen ──
  let thisMonthRevenue = null, lastMonthRevenue = null, revenueTrend6mo = [], revenueYTD = null, hourlyRateTrend6mo = [];
  let outstanding = { count: 0, sum: 0 }, outstandingLastMonth = { count: 0, sum: 0 };
  let overdueCount = 0;
  let moneybirdError = invoices === null;

  if (Array.isArray(invoices)) {
    const counted = invoices.filter(inv => !MB_EXCLUDED_REVENUE_STATES.includes(inv.state));
    const revenueOf = inv => Number(inv.total_price_excl_tax) || 0;

    thisMonthRevenue = sumWhere(counted, inv => inv.invoice_date && new Date(inv.invoice_date) >= startOfThisMonth, revenueOf);
    lastMonthRevenue = sumWhere(counted, inv => inv.invoice_date && new Date(inv.invoice_date) >= startOfLastMonth && new Date(inv.invoice_date) <= endOfLastMonth, revenueOf);

    // 6-maands trend, inclusief lopende maand
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    revenueTrend6mo = months.map(m => {
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      const total = sumWhere(counted, inv => inv.invoice_date && new Date(inv.invoice_date) >= m && new Date(inv.invoice_date) < next, revenueOf);
      return { label: monthLabel(m), total };
    });

    revenueYTD = sumWhere(counted, inv => inv.invoice_date && new Date(inv.invoice_date) >= yearStart, revenueOf);

    // Uurloon-trend: winst per maand (omzet - kosten) ÷ maandelijkse uren-capaciteit
    if (Array.isArray(purchaseInvoices)) {
      const MONTHLY_HOURS = ANNUAL_HOURS / 12;
      const trendMonths = [];
      for (let i = 5; i >= 0; i--) trendMonths.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
      const raw = trendMonths.map(m => {
        const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
        const rev  = sumWhere(counted, inv => inv.invoice_date && new Date(inv.invoice_date) >= m && new Date(inv.invoice_date) < next, revenueOf);
        const cost = purchaseInvoices.reduce((s, inv) => {
          if (!inv.date) return s;
          const d = new Date(inv.date);
          return (d >= m && d < next) ? s + (Number(inv.total_price_excl_tax) || 0) : s;
        }, 0);
        return { label: monthLabel(m), rate: (rev - cost) / MONTHLY_HOURS };
      });
      // 3-maands voortschrijdend gemiddelde
      hourlyRateTrend6mo = raw.map((m, i, arr) => {
        const window = arr.slice(Math.max(0, i - 2), i + 1);
        const avg3mo = window.reduce((s, x) => s + x.rate, 0) / window.length;
        return { ...m, avg3mo };
      });
    }

    // Moneybirds "Te ontvangen": incl. BTW, en houdt rekening met al ontvangen
    // deelbetalingen — vandaar total_unpaid (restbedrag) i.p.v. het volledige
    // factuurbedrag excl. BTW (dat is revenueOf, alleen voor omzet-cijfers).
    const unpaidOf = inv => Number(inv.total_unpaid) || 0;

    const outstandingInvoices = invoices.filter(inv => MB_OUTSTANDING_STATES.includes(inv.state));
    outstanding = { count: outstandingInvoices.length, sum: sumWhere(outstandingInvoices, () => true, unpaidOf) };
    // Eigen definitie: openstaand én factuur ouder dan 30 dagen (niet Moneybird's vervaldatum)
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    overdueCount = invoices.filter(inv =>
      MB_OUTSTANDING_STATES.includes(inv.state) &&
      inv.invoice_date && new Date(inv.invoice_date) < thirtyDaysAgo
    ).length;

    // Benadering van "openstaand op het einde van vorige maand": gefactureerd
    // vóór die datum, en op dat moment nog niet (volledig) betaald.
    const outstandingAsOfLastMonth = invoices.filter(inv => {
      if (!inv.invoice_date || MB_EXCLUDED_REVENUE_STATES.includes(inv.state)) return false;
      if (new Date(inv.invoice_date) > endOfLastMonth) return false;
      const paidAt = inv.paid_at ? new Date(inv.paid_at) : null;
      return !paidAt || paidAt > endOfLastMonth;
    });
    outstandingLastMonth = { count: outstandingAsOfLastMonth.length, sum: sumWhere(outstandingAsOfLastMonth, () => true, unpaidOf) };
  }

  const avgMonthlyRevenue3mo = revenueTrend6mo.length
    ? revenueTrend6mo.slice(-3).reduce((s, m) => s + m.total, 0) / 3
    : null;

  const profitYTD = (revenueYTD !== null && costsYTD !== null) ? revenueYTD - costsYTD : null;
  const effectiveHourlyRate = profitYTD !== null ? profitYTD / hoursYTD : null;
  const acknowledgedProjectLessons = projects
    .filter(p => p.analysis_acknowledged && String(p.analysis_note || '').trim())
    .map(p => ({ name: p.name, note: String(p.analysis_note).trim() }));

  return {
    generatedAt: now.toISOString(),
    moneybirdError,
    thisMonthRevenue, lastMonthRevenue, revenueTrend6mo, avgMonthlyRevenue3mo,
    revenueYTD, costsYTD, profitYTD, effectiveHourlyRate, hoursYTD,
    hourlyRateTrend6mo,
    outstanding, outstandingLastMonth, overdueCount,
    costsError, costsByProject, unmatchedProjectCosts, projectMargins, activeProjectMargins, acknowledgedProjectLessons,
    activeProjects, longRunningProjects,
    currentlyActiveProjects, upcomingProjects, unplannedProjects, explicitMbLinks,
    openQuotes, openQuotesValue,
    openQuoteVariantsIgnored,
    acceptedQuotes, orderportefeuille,
    fulfilledQuotes, fulfilledQuotesValue,
    laterQuotes, laterQuotesValue, staleLaterQuotes,
    staleSentQuotes,
    newQuotes30d, newQuotesPrev30d,
    clientCount: state.clients?.length || 0,
  };
}

function sumWhere(list, predicate, valueFn) {
  return list.filter(predicate).reduce((s, item) => s + valueFn(item), 0);
}

function pctChange(curr, prev) {
  if (prev == null || curr == null || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function computeWarnings(snap) {
  const warnings = [];
  const coverageMonths = snap.avgMonthlyRevenue3mo > 0 ? snap.orderportefeuille / snap.avgMonthlyRevenue3mo : null;

  if (coverageMonths != null && coverageMonths < BIZ_THRESHOLDS.minOrderportefeuilleMonths) {
    warnings.push({ icon: '⚠️', text: `Lage orderportefeuille — nog maar ${coverageMonths.toFixed(1)} maand omzet aan geaccepteerd werk in de pijplijn.` });
  }
  if (!snap.moneybirdError && snap.avgMonthlyRevenue3mo > 0 &&
      snap.outstanding.sum > snap.avgMonthlyRevenue3mo * BIZ_THRESHOLDS.maxOutstandingVsAvgRevenue) {
    warnings.push({ icon: '⚠️', text: `Veel openstaande facturen — ${fmtEur(snap.outstanding.sum)} nog te ontvangen (${snap.outstanding.count} facturen).` });
  }
  if (!snap.moneybirdError && snap.overdueCount > 0) {
    warnings.push({ icon: '⚠️', text: `${snap.overdueCount} factu${snap.overdueCount === 1 ? 'ur' : 'ren'} te laat — actie ondernemen om betaling binnen te krijgen.` });
  }
  if (snap.longRunningProjects.length > 0) {
    warnings.push({ icon: '⚠️', text: `${snap.longRunningProjects.length} langlopend(e) project(en): ${snap.longRunningProjects.map(p => p.name).join(', ')}.` });
  }
  if (snap.newQuotes30d < BIZ_THRESHOLDS.minNewQuotesPer30Days) {
    warnings.push({ icon: '⚠️', text: `Weinig nieuwe offertes — slechts ${snap.newQuotes30d} in de afgelopen 30 dagen.` });
  }
  return warnings;
}

function computeBusinessScore(snap) {
  // Orderportefeuille: dekking in maanden, 0 mnd = 0, 2+ mnd = 10
  const coverageMonths = snap.avgMonthlyRevenue3mo > 0 ? snap.orderportefeuille / snap.avgMonthlyRevenue3mo : null;
  const orderScore = coverageMonths == null ? 5 : Math.max(0, Math.min(10, (coverageMonths / 2) * 10));

  // Cashflow: 1× maandomzet openstaand = 7 (normaal), minder = hoger, meer = lager
  const outstandingRatio = (!snap.moneybirdError && snap.avgMonthlyRevenue3mo > 0)
    ? snap.outstanding.sum / snap.avgMonthlyRevenue3mo : null;
  const cashflowScore = outstandingRatio == null ? 5 : Math.max(0, 10 - outstandingRatio * 3);

  // Facturen: 1,5 punt aftrek per factuur ouder dan 30 dagen nog onbetaald
  const facturenScore = snap.moneybirdError ? 5 : Math.max(0, 10 - snap.overdueCount * 1.5);

  const total = (orderScore + cashflowScore + facturenScore) / 3;
  return {
    total: Math.round(total * 10) / 10,
    breakdown: {
      orderportefeuille: Math.round(orderScore * 10) / 10,
      cashflow:          Math.round(cashflowScore * 10) / 10,
      facturen:          Math.round(facturenScore * 10) / 10,
    },
  };
}

const BIZ_SCORE_LABELS = {
  orderportefeuille: 'Orderportefeuille',
  cashflow:          'Cashflow',
  facturen:          'Facturen',
};

const BIZ_QUICK_QUESTIONS = [
  'Hoe gaat het met mijn bedrijf?',
  'Waar liggen de grootste groeikansen?',
  'Kunnen we iemand aannemen?',
  'Welke projecten verdienen aandacht?',
];

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ' ' +
         d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// Vaste rol/regels voor de AI — gedeeld door de Inzichten/Advies-generatie én de chat.
function buildCoachSystemPrompt() {
  return `Je bent een vaste bedrijfscoach en CFO voor Studio Vonk & Vorm, een jong technisch projectbedrijf van nog geen 6 maanden oud dat wil groeien.

Gedraag je als een ervaren ondernemer die helpt bij het nemen van strategische beslissingen. Vertaal cijfers naar concrete acties — beschrijf ze niet alleen.

Regels:
- Denk als ondernemer, niet als accountant.
- Focus op groei én continuïteit.
- Geef alleen inzichten die daadwerkelijk relevant zijn — geen opvulzinnen of open deuren.
- Onderbouw elke uitspraak met de beschikbare cijfers.
- Geef duidelijk aan wanneer er onvoldoende data is voor een harde conclusie.
- Vermijd algemene managementclichés.
- Projecten die in de context als "besproken historische les" zijn gemarkeerd, zijn bekende en verklaarde afwijkingen. Noem ze niet opnieuw als inzicht of hoofdadvies, tenzij de gebruiker er expliciet naar vraagt.
- Schrijf in het Nederlands, beknopt en concreet.`;
}

function buildSnapshotContextText(snap) {
  const lines = [];
  lines.push(`Datum: ${toDateStr(new Date(snap.generatedAt))}`);
  lines.push(`Aantal klanten: ${snap.clientCount}`);
  lines.push(`Lopende projecten: ${snap.activeProjects.length}${snap.longRunningProjects.length ? ` (waarvan ${snap.longRunningProjects.length} al langer dan ${BIZ_THRESHOLDS.longRunningProjectDays} dagen actief: ${snap.longRunningProjects.map(p => p.name).join(', ')})` : ''}`);
  if (snap.upcomingProjects.length) {
    lines.push(`Daarvan staat ${snap.upcomingProjects.length} pas in de toekomst ingepland in de Gantt-planning (telt nog niet als capaciteitsbelasting): ${snap.upcomingProjects.map(p => p.name).join(', ')}`);
  }
  lines.push(`Openstaande offertes: ${snap.openQuotes.length} stuks, totale waarde ${fmtEur(snap.openQuotesValue)}`);
  lines.push(`Orderportefeuille (geaccepteerde offertes, nog te factureren): ${fmtEur(snap.orderportefeuille)} (${snap.acceptedQuotes.length} offertes)`);
  if (snap.acknowledgedProjectLessons.length) {
    lines.push(`Besproken historische lessen — niet opnieuw als inzicht of hoofdadvies noemen: ${snap.acknowledgedProjectLessons.map(l => `${l.name}: ${l.note}`).join('; ')}`);
  }
  if (!snap.costsError && (snap.costsByProject.length || snap.unmatchedProjectCosts.length)) {
    lines.push(`Kosten per project (via Moneybird-Project-koppeling op inkoopfacturen, excl. BTW): ${snap.costsByProject.map(c => `${c.name}: ${fmtEur(c.cost)}`).join(', ')}`);
    if (snap.unmatchedProjectCosts.length) {
      lines.push(`Kosten op Moneybird-projecten zonder match in deze app (naam wijkt mogelijk af): ${snap.unmatchedProjectCosts.map(c => `${c.name}: ${fmtEur(c.cost)}`).join(', ')}`);
    }
  }
  if (snap.projectMargins.length) {
    const ackedNames = new Set(JSON.parse(localStorage.getItem('biz_acknowledged_projects') || '[]'));
    const withQuote = snap.projectMargins.filter(m => m.hasQuote);
    const normalWithQuote = withQuote.filter(m => !ackedNames.has(m.name));
    const ackedWithQuote  = withQuote.filter(m => ackedNames.has(m.name));
    if (normalWithQuote.length) {
      lines.push(`Eigen verdiensten per afgesloten project (alleen projecten met status "Afgerond" — bij lopende projecten is dit nog niet betrouwbaar) — prognose winst uit de offerte vs. daadwerkelijke winst (omzet die in Moneybird aan het project getagd is, of bij gebrek daaraan de offertewaarde, minus werkelijke Moneybird-kosten, excl. BTW), met de afwijking t.o.v. de prognose (+ = beter dan verwacht, - = slechter), gesorteerd sterkste presteerders eerst: ${normalWithQuote.map(m => `${m.name}: prognose ${fmtEur(m.estimatedProfit)}, daadwerkelijk ${fmtEur(m.actualProfit)}${m.profitRatioPct !== null ? ` (${fmtProfitDelta(m.profitRatioPct)})` : ''}${m.revenueIsActual ? '' : ' [nog gebaseerd op offertewaarde, nog geen omzet getagd in Moneybird]'}`).join('; ')}`);
    }
    if (ackedWithQuote.length) {
      lines.push(`Bekende margeafwijkingen (al beoordeeld en begrepen door de gebruiker — NIET als probleem of aandachtspunt beschouwen): ${ackedWithQuote.map(m => `${m.name}: ${fmtProfitDelta(m.profitRatioPct)}`).join(', ')}`);
    }
    const costOnly = snap.projectMargins.filter(m => !m.hasQuote);
    if (costOnly.length) {
      lines.push(`Projecten met Moneybird-kosten maar zonder bekende geaccepteerde offertewaarde (winst niet te vergelijken): ${costOnly.map(m => `${m.name}: ${fmtEur(m.cost)}`).join(', ')}`);
    }
  }
  if (snap.fulfilledQuotes.length) {
    lines.push(`Afgerond en al geleverd (project afgerond, bewust niet meegeteld in orderportefeuille): ${snap.fulfilledQuotes.length} offertes, ${fmtEur(snap.fulfilledQuotesValue)}`);
  }
  if (snap.laterQuotes.length) {
    lines.push(`Uitgesteld/later (bewust niet meegeteld in de actieve pijplijn, bv. seizoensgebonden): ${snap.laterQuotes.length} offertes, ${fmtEur(snap.laterQuotesValue)} — ${snap.laterQuotes.map(q => q.name).join(', ')}`);
  }
  if (snap.staleLaterQuotes.length) {
    lines.push(`Wacht al >= ${BIZ_THRESHOLDS.laterReminderDays} dagen op follow-up: ${snap.staleLaterQuotes.map(q => q.name).join(', ')}`);
  }
  if (snap.staleSentQuotes.length) {
    lines.push(`Verzonden, maar >= ${BIZ_THRESHOLDS.sentReminderDays} dagen geen reactie van de klant: ${snap.staleSentQuotes.map(q => q.name).join(', ')}`);
  }
  lines.push(`Nieuwe offertes laatste 30 dagen: ${snap.newQuotes30d} (voorgaande 30 dagen: ${snap.newQuotesPrev30d})`);
  if (snap.moneybirdError) {
    lines.push(`Moneybird-factuurdata kon niet worden opgehaald — geen omzet-/factuurcijfers beschikbaar.`);
  } else {
    lines.push(`Omzet deze maand (gefactureerd, incl. nog niet betaald): ${fmtEur(snap.thisMonthRevenue)}`);
    lines.push(`Omzet vorige maand: ${fmtEur(snap.lastMonthRevenue)}`);
    lines.push(`Omzettrend laatste 6 maanden: ${snap.revenueTrend6mo.map(m => `${m.label} ${fmtEur(m.total)}`).join(', ')}`);
    lines.push(`Openstaande facturen: ${snap.outstanding.count} stuks, totaal ${fmtEur(snap.outstanding.sum)}, waarvan ${snap.overdueCount} te laat`);
  }
  return lines.join('\n');
}

const BIZ_INSIGHTS_CACHE_KEY = 'bizInsightsCache';

function loadCachedInsights() {
  try { return JSON.parse(localStorage.getItem(BIZ_INSIGHTS_CACHE_KEY)) || null; } catch (_) { return null; }
}
function saveCachedInsights(data) {
  localStorage.setItem(BIZ_INSIGHTS_CACHE_KEY, JSON.stringify(data));
}

async function generateBusinessInsights(existingSnapshot) {
  const token = state.config?.anthropicToken;
  if (!token) throw new Error('Geen Anthropic API-sleutel ingesteld. Ga naar Instellingen → AI-assistent.');
  const snap = existingSnapshot || await computeBusinessSnapshot();
  const context = buildSnapshotContextText(snap);
  const prompt = `Hier zijn de actuele bedrijfscijfers:

${context}

Geef 3 tot 5 korte, concrete inzichten — observaties die er daadwerkelijk toe doen, geen herhaling van de cijfers zelf — en daarna één concreet hoofdadvies voor de komende weken.

Antwoord ALLEEN met geldige JSON in exact dit formaat, zonder markdown-codeblok of extra tekst eromheen:
{"insights": ["...", "..."], "advice": "..."}`;

  const requestBody = {
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    system: buildCoachSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  };
  const text = await _sendClaudeRequest(token, requestBody);
  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    throw new Error('Kon AI-antwoord niet verwerken als JSON: ' + e.message);
  }
  const result = {
    generatedAt: new Date().toISOString(),
    insights: Array.isArray(parsed.insights) ? parsed.insights : [],
    advice: parsed.advice || '',
  };
  saveCachedInsights(result);
  return result;
}

const BIZ_CHAT_KEY = 'bizChatHistory';

function loadChatHistory() {
  try { return JSON.parse(localStorage.getItem(BIZ_CHAT_KEY)) || []; } catch (_) { return []; }
}
function saveChatHistory(history) {
  localStorage.setItem(BIZ_CHAT_KEY, JSON.stringify(history));
}
function clearChatHistory() {
  localStorage.removeItem(BIZ_CHAT_KEY);
}

async function sendBizChatMessage(userText, priorHistory) {
  const token = state.config?.anthropicToken;
  if (!token) throw new Error('Geen Anthropic API-sleutel ingesteld. Ga naar Instellingen → AI-assistent.');
  const snap = await computeBusinessSnapshot();
  const system = buildCoachSystemPrompt() +
    `\n\nActuele bedrijfscijfers:\n${buildSnapshotContextText(snap)}\n\n` +
    `Sluit je antwoord af met een losse regel die begint met "Mijn advies:" gevolgd door één concrete actie.`;
  const messages = [...priorHistory, { role: 'user', content: userText }]
    .map(m => ({ role: m.role, content: m.content }));
  const requestBody = { model: 'claude-opus-4-8', max_tokens: 2048, system, messages };
  return _sendClaudeRequest(token, requestBody);
}

async function getMoneybirdTaxRateId() {
  const rates = await moneybirdFetch('GET', 'tax_rates.json');
  if (!Array.isArray(rates)) throw new Error('Kon BTW-tarieven niet ophalen');
  // Prefer sales_invoice type at 21%
  const rate = rates.find(r => parseFloat(r.percentage) === 21 && r.tax_rate_type === 'sales_invoice')
            || rates.find(r => parseFloat(r.percentage) === 21);
  if (!rate) throw new Error('Geen 21% BTW-tarief gevonden in Moneybird');
  return rate.id;
}

async function findOrCreateMoneybirdContact() {
  const name = (qe.client || '').trim();
  if (!name) throw new Error('Vul eerst een klantnaam in');

  // Search existing contacts
  const results = await moneybirdFetch('GET', `contacts.json?query=${encodeURIComponent(name)}`);
  if (Array.isArray(results) && results.length > 0) return results[0].id;

  // Create new contact
  const parts = (qe.client_postcode || '').trim().split(/\s+/);
  const zipcode = parts[0] || '';
  const city    = parts.slice(1).join(' ');
  const nameParts = (qe.client_contact || '').trim().split(/\s+/);
  const newContact = await moneybirdFetch('POST', 'contacts.json', {
    contact: {
      company_name: name,
      firstname:    nameParts[0] || '',
      lastname:     nameParts.slice(1).join(' '),
      address1:     qe.client_address || '',
      zipcode,
      city,
      email:        qe.client_email   || '',
      phone:        qe.client_phone   || '',
    },
  });
  return newContact.id;
}

async function findOrCreateMoneybirdProject(name) {
  // Search in first 100 projects (enough for most administrations)
  const all = await moneybirdFetch('GET', 'projects.json?filter=state:all&per_page=100');
  if (Array.isArray(all)) {
    const found = all.find(p => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (found) return found.id;
  }
  const created = await moneybirdFetch('POST', 'projects.json', { project: { name } });
  return created.id;
}

async function exportToMoneybird(mode) { // mode: 'gespecificeerd' | 'totaal'
  if (!qe.id) { toast('Sla de offerte eerst op', 'warn'); return; }
  try {
    toast('Factuur aanmaken in Moneybird…', 'info', 8000);

    const taxRateId  = await getMoneybirdTaxRateId();
    const contactId  = await findOrCreateMoneybirdContact();
    const projectId  = await findOrCreateMoneybirdProject(quoteProjectName());
    const totals     = calcQETotals();
    const globalMgn  = parseFloat(qe.margin || 20);
    const outMgn     = parseFloat(qe.outsource_margin || 15);

    let details;
    if (mode === 'totaal') {
      details = [{
        description: qe.name,
        price:       totals.subtotal.toFixed(2),
        amount:      '1 stuks',
        tax_rate_id: taxRateId,
        project_id:  projectId,
      }];
    } else {
      // One line per enabled material + service
      const matLines = qe.materials.filter(m => m.enabled !== 0).map(m => {
        const pct = (m.margin != null && m.margin !== '') ? parseFloat(m.margin) : globalMgn;
        return {
          description: m.name,
          price:       (m.unit_price * (1 + pct / 100)).toFixed(2),
          amount:      `${m.quantity}${m.unit ? ' ' + m.unit : ''}`.trim() || '1',
          tax_rate_id: taxRateId,
          project_id:  projectId,
        };
      });
      const svcLines = qe.services.filter(s => s.enabled !== 0).map(s => {
        const price = s.is_outsourced
          ? s.unit_price * (1 + outMgn / 100)
          : s.unit_price;
        return {
          description: s.name,
          price:       price.toFixed(2),
          amount:      `${s.quantity} uur`,
          tax_rate_id: taxRateId,
          project_id:  projectId,
        };
      });
      details = [...matLines, ...svcLines];
    }

    const invoice = await moneybirdFetch('POST', 'sales_invoices.json', {
      sales_invoice: {
        contact_id:         contactId,
        reference:          qe.name,
        details_attributes: details,
      },
    });

    // Persist the Moneybird project ID on the local project so the analysis can match by ID.
    // Toevoegen aan de lijst (niet alleen als 'ie leeg is), zodat extra Moneybird-projecten
    // die bij dezelfde klus horen er ook bij komen.
    const localProj = state.projects.find(p => p.name.trim().toLowerCase() === quoteProjectName().toLowerCase());
    if (localProj) {
      const ids = mbIdsOf(localProj);
      if (!ids.includes(String(projectId))) {
        ids.push(String(projectId));
        const newVal = ids.join(',');
        await remoteQuery({ action: 'update', table: 'projects', data: { moneybird_project_id: newVal }, where: { id: localProj.id } });
        localProj.moneybird_project_id = newVal;
      }
    }

    toast('Factuur aangemaakt! Opening in Moneybird…', 'success', 4000);
    const mbUrl = `https://moneybird.com/${_moneybirdAdminId}/sales_invoices/${invoice.id}`;
    if (api.openUrl) api.openUrl(mbUrl); else window.open(mbUrl, '_blank');

  } catch (err) {
    toast('Factuur mislukt: ' + err.message, 'error', 6000);
    console.error('exportToMoneybird error:', err);
  }
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

const COMPANY = {
  name:    'Studio Vonk &amp; Vorm',
  address: 'Haarlemerstraatweg 79 · 1165MK Halfweg',
  email:   'info@vonkenvorm.com',
  kvk:     'KvK 99307294',
  btw:     'BTW NL868926176B01',
  iban:    'NL60 BUNQ 2180 4804 15',
  tel:     'George 06-11772820 · Maurits 06-15000229',
};

function buildQuoteNum(id, dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}-${String(id).padStart(2, '0')}`;
}

async function exportQuotePdf(mode = 'internal') {
  try {
  const isClient = mode === 'client';
  if (!qe.id) {
    await performSave();
    if (!qe.id) { toast('Sla de offerte eerst op', 'error'); return; }
  }

  const logoDataUrl = await api.getLogoDataUrl().catch(() => null);
  const t = calcQETotals();
  const quoteNum = buildQuoteNum(qe.id, qe.quote_date);
  const dateFmt = qe.quote_date
    ? new Date(qe.quote_date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const companyFooter = `
    <div style="font-weight:600;margin-bottom:3px">${COMPANY.name}</div>
    <div>${COMPANY.address}</div>
    <div>${COMPANY.email} · ${COMPANY.kvk} · ${COMPANY.btw}</div>
    <div>${COMPANY.iban} · ${COMPANY.tel}</div>`;

  // ── Internal PDF: full detail (only enabled items) ──
  const matRowsEnabled = qe.materials.filter(m => m.enabled !== 0);
  const svcRowsEnabled = qe.services.filter(s => s.enabled !== 0);

  const matRows = matRowsEnabled.map(m => {
    // In vaste-prijs-modus: toon inkoopprijs (geen marge opgeteld)
    const displayPrice = t.isFixedPrice
      ? m.unit_price
      : m.unit_price * (1 + ((m.margin != null && m.margin !== '') ? parseFloat(m.margin) : t.marginPct) / 100);
    const unit = escHtml(m.unit || 'st');
    return `
    <tr>
      <td>${escHtml(m.name)}</td>
      <td class="r">${m.quantity} ${unit}</td>
      <td class="r">${fmtEur(displayPrice)}</td>
      <td class="r">${fmtEur(m.quantity * displayPrice)}</td>
    </tr>`;
  }).join('');

  const svcRows = svcRowsEnabled.map(s => {
    const unit = escHtml(s.unit || 'uur');
    let displayPrice = s.unit_price;
    if (s.is_outsourced) {
      const pct = (s.margin != null && s.margin !== '') ? parseFloat(s.margin) : t.outsourceMarginPct;
      displayPrice = s.unit_price * (1 + pct / 100);
    } else if (s.margin != null && s.margin !== '') {
      displayPrice = s.unit_price * (1 + parseFloat(s.margin) / 100);
    }
    return `
    <tr>
      <td>${escHtml(s.name)}</td>
      <td class="r">${s.quantity} ${unit}</td>
      <td class="r">${fmtEur(displayPrice)}/${unit}</td>
      <td class="r">${fmtEur(s.quantity * displayPrice)}</td>
    </tr>`;
  }).join('');

  // Een samengevoegde offerte blijft intern per brononderdeel leesbaar. De
  // klantversie hieronder verandert bewust niet: die toont alleen de eindprijs.
  const groupedInternalBlocks = (qe.merged_sections || []).map(label => {
    const mats = matRowsEnabled.filter(m => m.section_label === label);
    const svcs = svcRowsEnabled.filter(s => s.section_label === label);
    const materialRows = mats.map(m => {
      const price = t.isFixedPrice ? m.unit_price : m.unit_price * (1 + ((m.margin != null && m.margin !== '') ? parseFloat(m.margin) : t.marginPct) / 100);
      const unit = escHtml(m.unit || 'st');
      return `<tr><td>${escHtml(m.name)}</td><td class="r">${m.quantity} ${unit}</td><td class="r">${fmtEur(price)}</td><td class="r">${fmtEur(m.quantity * price)}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="empty-pdf-row">Geen materialen</td></tr>';
    const serviceRows = svcs.map(s => {
      const unit = escHtml(s.unit || 'uur');
      const price = s.is_outsourced ? s.unit_price * (1 + ((s.margin != null && s.margin !== '') ? parseFloat(s.margin) : t.outsourceMarginPct) / 100) : (s.margin != null && s.margin !== '' ? s.unit_price * (1 + parseFloat(s.margin) / 100) : s.unit_price);
      return `<tr><td>${escHtml(s.name)}</td><td class="r">${s.quantity} ${unit}</td><td class="r">${fmtEur(price)}/${unit}</td><td class="r">${fmtEur(s.quantity * price)}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="empty-pdf-row">Geen diensten</td></tr>';
    return `<div class="internal-section"><h2>${escHtml(label)}</h2><h3>Materialen</h3><table class="content-table"><thead><tr><th style="width:52%">Omschrijving</th><th class="r" style="width:14%">Aantal</th><th class="r" style="width:17%">${t.isFixedPrice ? 'Inkoopprijs' : 'Stukprijs'}</th><th class="r" style="width:17%">Totaal</th></tr></thead><tbody>${materialRows}</tbody></table>${!t.isFixedPrice ? `<h3>Diensten</h3><table class="content-table"><thead><tr><th style="width:52%">Dienst</th><th class="r" style="width:14%">Aantal</th><th class="r" style="width:17%">Tarief</th><th class="r" style="width:17%">Totaal</th></tr></thead><tbody>${serviceRows}</tbody></table>` : ''}</div>`;
  }).join('');

  // ── Client PDF: items listed, no individual prices (only enabled items) ──
  const clientItemsList = [
    ...matRowsEnabled.map(m => escHtml(m.name)),
    ...svcRowsEnabled.map(s => escHtml(s.name)),
  ].map(n => `<li>${n}</li>`).join('');

  const opts = qe.pdf_opts || {
    show_title_page: true, show_project_image: true, show_extra_images: true,
    show_exclusions: true, show_notes: true, show_validity: true, show_client_address: true,
  };
  const accent  = '#13ABBD';
  const accentD = '#0D8B9B';
  const bgTint  = '#f0f9fb';
  const thBg    = '#e2f4f7';

  const clientAddr = [qe.client_contact, qe.client_address, qe.client_postcode, qe.client_email, qe.client_phone]
    .filter(Boolean).map(l => escHtml(l)).join('<br/>');

  // Extra images page HTML
  const extraImages = qe.extra_images || [];
  const extraImagesPage = (opts.show_extra_images && extraImages.length > 0) ? `
    <div class="extras-page">
      <h3 style="margin-bottom:6mm;color:${accent}">Bijlagen — Afbeeldingen</h3>
      <div class="extras-grid">
        ${extraImages.map((img, i) => `<div class="extras-img"><img src="${img}" alt="Bijlage ${i+1}" /></div>`).join('')}
      </div>
    </div>` : '';

  const headerHtml = `<div class="hf-header">
    ${logoDataUrl ? `<img src="${logoDataUrl}" alt="Logo" />` : ''}
    <div class="hf-right">${quoteNum}<br/>${dateFmt}</div>
  </div>`;
  const footerHtml = `${COMPANY.name} &nbsp;·&nbsp; ${COMPANY.address} &nbsp;·&nbsp; ${COMPANY.email} &nbsp;·&nbsp; ${COMPANY.kvk} &nbsp;·&nbsp; ${COMPANY.btw}`;

  const html = `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8">
<style>
  @page { size: A4; margin: 18mm 18mm 18mm 18mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* ── Table-based repeating header & footer ── */
  .page-wrap { width: 100%; border-collapse: collapse; }
  .page-wrap > thead { display: table-header-group; }
  .page-wrap > tfoot { display: table-footer-group; }
  .page-wrap > tbody { display: table-row-group; }
  .page-wrap > thead td,
  .page-wrap > tfoot td,
  .page-wrap > tbody td { padding: 0; border: none; vertical-align: top; }

  .hf-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 8px; margin-bottom: 4mm;
    border-bottom: 1px solid #eee;
  }
  .hf-header img { max-height: 44px; max-width: 160px; }
  .hf-right { font-size: 8px; color: #bbb; text-align: right; line-height: 1.4; }
  /* ── Fixed footer (always at bottom of every page) ── */
  .fixed-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    border-top: 1px solid #eee;
    padding-top: 6px;
    font-size: 7.5px; color: #bbb; line-height: 1.7; text-align: center;
  }

  /* ── Pagina 1: Titelblad ── */
  .title-page {
    width: 100%; height: 100vh;
    background: #ffffff;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    position: relative;
    break-after: page; page-break-after: always;
  }
  .title-bottom-footer {
    position: absolute; bottom: 0; left: 0; right: 0;
    text-align: center;
    font-size: 7.5px; line-height: 1.8;
    color: #ccc;
    border-top: 1px solid #eee;
    padding-top: 8px;
  }
  .title-content {
    display: flex; flex-direction: column; align-items: center;
  }
  .title-logo-wrap {
    display: flex; flex-direction: column; align-items: center;
    margin-bottom: 28px;
  }
  .title-logo-wrap img { max-width: 300px; max-height: 160px; object-fit: contain; }
  .title-wordmark { font-size: 32px; font-weight: 300; letter-spacing: 8px; color: #1c1917; text-transform: uppercase; }
  .title-divider { width: 40px; height: 2px; background: ${accent}; margin: 12px auto; }
  .title-quote-label { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #bbb; }
  .title-client-block { margin-top: 0; text-align: center; }
  .title-client-block .for { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #ccc; margin-bottom: 6px; }
  .title-client-block .cname { font-size: 22px; font-weight: 300; color: #1c1917; margin-bottom: 4px; }
  .title-client-block .pname { font-size: 13px; color: #999; }
  .title-project-img {
    margin-top: 24px;
    width: 150mm;
    display: flex; align-items: center; justify-content: center;
  }
  .title-project-img img { max-width: 100%; max-height: 72mm; object-fit: contain; border-radius: 6px; }

  /* ── Offertepagina's ── */
  .quote-page { background: #fff; }
  .qp-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; }
  .qp-meta { text-align: right; }
  .qp-meta .title { font-size: 22px; font-weight: 700; color: #1c1917; letter-spacing: .5px; }
  .qp-meta .num { font-size: 11px; color: ${accent}; font-weight: 600; margin-top: 2px; }
  .qp-meta .date { font-size: 10px; color: #999; margin-top: 2px; }
  .client-block {
    background: ${bgTint}; border-left: 3px solid ${accent};
    padding: 8px 14px; margin-bottom: 6mm; border-radius: 0 4px 4px 0;
    break-inside: avoid; page-break-inside: avoid;
  }
  .client-block .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .8px; color: #aaa; margin-bottom: 3px; }
  .client-block .val { font-size: 15px; font-weight: 600; color: #1c1917; }
  .client-block .proj { font-size: 11px; color: #555; margin-top: 3px; }
  .client-block .client-addr { font-size: 9px; color: #999; line-height: 1.5; margin-top: 4px; }
  h3 { font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; color: ${accentD}; margin: 6mm 0 2mm; break-after: avoid; page-break-after: avoid; }
  .content-table { width: 100%; border-collapse: collapse; font-size: 11px; break-inside: avoid; page-break-inside: avoid; }
  .content-table tr { break-inside: avoid; page-break-inside: avoid; }
  .content-table th { background: ${thBg}; padding: 6px 8px; text-align: left; font-size: 9px; color: #4a8f9a; text-transform: uppercase; letter-spacing: .4px; }
  .content-table th.r { text-align: right; }
  .content-table td { padding: 6px 8px; border-bottom: 1px solid #eaf5f7; color: #2a2520; }
  .content-table td.r { text-align: right; }
  .subtotals td { border: none; padding: 2px 8px; font-size: 10px; color: #888; }
  .subtotals tr.bold td { color: #1c1917; font-weight: 600; }
  .totals-box { margin-top: 6mm; border: 1.5px solid ${accent}; border-radius: 6px; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
  .totals-box th { background: ${accent}; color: #fff; padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .4px; }
  .totals-box td { padding: 6px 12px; border-bottom: 1px solid #eaf5f7; color: #2a2520; }
  .totals-box td.r { text-align: right; }
  .totals-box .row-final td { font-size: 14px; font-weight: 700; background: ${bgTint}; }
  .totals-box .row-btw td { color: #888; font-size: 10px; }
  .totals-box .row-incl td { color: #888; font-size: 10px; border-bottom: none; }
  .excl-block { margin-top: 6mm; padding: 8px 14px; background: ${bgTint}; border-left: 3px solid ${accent}; border-radius: 0 4px 4px 0; break-inside: avoid; page-break-inside: avoid; }
  .excl-block .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .8px; color: #aaa; margin-bottom: 4px; }
  .excl-pdf-list { margin: 0; padding: 0 0 0 5mm; font-size: 10px; color: #666; line-height: 1.8; }
  .excl-pdf-list li { padding-left: 2px; }
  .client-addr { font-size: 10px; color: #666; line-height: 1.6; margin-top: 4px; }
  .notes-block { margin-top: 4mm; margin-bottom: 6mm; padding: 8px 14px; background: ${bgTint}; border-left: 3px solid ${accent}; border-radius: 0 4px 4px 0; font-size: 10px; color: #666; line-height: 1.6; break-inside: avoid; page-break-inside: avoid; }
  .notes-block .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .8px; color: #aaa; margin-bottom: 4px; }
  .internal-section { margin-top: 6mm; break-inside: avoid; page-break-inside: avoid; }
  .internal-section h2 { font-size: 13px; color: ${accentD}; margin: 0 0 3mm; }
  .empty-pdf-row { color: #888; font-style: italic; text-align: center; }

  /* ── Extra images page ── */
  .extras-page {
    background: #fff;
    break-before: page; page-break-before: always;
  }
  .extras-grid {
    display: flex; flex-wrap: wrap; gap: 6mm; justify-content: center;
  }
  .extras-img {
    width: 80mm; height: 60mm; overflow: hidden; border-radius: 4px; border: 1px solid #eee;
    display: flex; align-items: center; justify-content: center;
  }
  .extras-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .quote-end-footer {
    margin-top: 8mm;
    padding: 4mm 0 0;
    border-top: 1px solid #d8eff3;
    break-inside: avoid; page-break-inside: avoid;
  }
  .quote-end-footer .validity {
    font-size: 9px; color: #888; text-align: center; line-height: 1.6;
    font-style: italic;
  }
</style>
</head><body>

${opts.show_title_page ? `
<!-- ── Pagina 1: Titelblad (geen header/footer) ── -->
<div class="title-page">
  <div class="title-content">
    <div class="title-logo-wrap">
      ${logoDataUrl
        ? `<img src="${logoDataUrl}" alt="Studio Vonk &amp; Vorm" />`
        : `<div class="title-wordmark">Vonk &amp; Vorm</div>`}
    </div>
    <div class="title-divider"></div>
    <div class="title-quote-label">Offerte</div>
    <div style="height:16px"></div>
    <div class="title-client-block">
      <div class="for">Opgesteld voor</div>
      <div class="cname">${escHtml(qe.client || '—')}</div>
      <div class="pname">${escHtml(qe.name)}</div>
    </div>
    ${(opts.show_project_image && qe.image_data) ? `<div class="title-project-img"><img src="${qe.image_data}" alt="Projectafbeelding" /></div>` : ''}
  </div>
</div>
` : ''}

<!-- ── Fixed footer op elke pagina ── -->
<div class="fixed-footer">${footerHtml}</div>

<!-- ── Offerte content met herhalende header ── -->
<table class="page-wrap"><thead><tr><td>${headerHtml}</td></tr></thead>
<tbody><tr><td>

<!-- ── Offertepagina ── -->
<div class="quote-page">
  <div class="quote-body">
    <div class="qp-header">
      <div class="qp-meta" style="width:100%">
        <div class="title">OFFERTE</div>
        <div class="num">${quoteNum}</div>
        <div class="date">${dateFmt}</div>
      </div>
    </div>

    <div class="client-block">
      <div class="lbl">Klant &amp; Project</div>
      <div class="val">${escHtml(qe.client || '—')}</div>
      <div class="proj">${escHtml(qe.name)}</div>
      ${(opts.show_client_address && clientAddr) ? `<div class="client-addr">${clientAddr}</div>` : ''}
    </div>

    ${(opts.show_notes && qe.notes) ? `<div class="notes-block"><div class="lbl">Toelichting</div>${escHtml(qe.notes).replace(/\n/g, '<br/>')}</div>` : ''}

    ${isClient ? `
    <!-- Client PDF: single total price only -->
    <div class="totals-box" style="margin-top:8mm">
      <table class="content-table">
        <thead><tr><th colspan="2">Prijsoverzicht</th></tr></thead>
        <tbody>
          <tr class="row-final"><td>TOTAAL excl. BTW</td><td class="r">${fmtEur(t.subtotal)}</td></tr>
          <tr class="row-btw"><td>BTW (21%)</td><td class="r">+ ${fmtEur(t.btw)}</td></tr>
          <tr class="row-incl"><td>Incl. BTW</td><td class="r">${fmtEur(t.grandTotal)}</td></tr>
        </tbody>
      </table>
    </div>
    ` : `
    <!-- Internal PDF: full detail (disabled items excluded) -->
    ${groupedInternalBlocks || (matRowsEnabled.length > 0 ? `
    <h3>Materialen</h3>
    <table class="content-table">
      <thead><tr><th style="width:52%">Omschrijving</th><th class="r" style="width:14%">Aantal</th><th class="r" style="width:17%">${t.isFixedPrice ? 'Inkoopprijs' : 'Stukprijs'}</th><th class="r" style="width:17%">Totaal</th></tr></thead>
      <tbody>${matRows}</tbody>
    </table>
    ` : '')}

    ${groupedInternalBlocks ? '' : (!t.isFixedPrice && svcRowsEnabled.length > 0 ? `
    <h3>Diensten</h3>
    <table class="content-table">
      <thead><tr><th style="width:52%">Dienst</th><th class="r" style="width:14%">Aantal</th><th class="r" style="width:17%">Tarief</th><th class="r" style="width:17%">Totaal</th></tr></thead>
      <tbody>${svcRows}</tbody>
    </table>` : '')}

    ${t.isFixedPrice && t.fixedItems?.length > 0 ? `
    <h3>Vaste stuksprijs</h3>
    <table class="content-table">
      <thead><tr><th style="width:52%">Omschrijving</th><th class="r" style="width:14%">Aantal</th><th class="r" style="width:17%">Stuksprijs</th><th class="r" style="width:17%">Totaal</th></tr></thead>
      <tbody>${t.fixedItems.map(it => `
      <tr>
        <td>${escHtml(it.name || '—')}</td>
        <td class="r">${it.quantity ?? 1}</td>
        <td class="r">${fmtEur(it.unit_price)}</td>
        <td class="r">${fmtEur((it.quantity ?? 1) * (it.unit_price ?? 0))}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}

    <div class="totals-box">
      <table class="content-table">
        <thead><tr><th colspan="2">Totaaloverzicht</th></tr></thead>
        <tbody>
          ${t.isFixedPrice ? `
            ${matRowsEnabled.length > 0 ? `<tr><td>Inkoop materialen</td><td class="r">${fmtEur(t.matEx)}</td></tr>` : ''}
            <tr><td>Totaal verkoopprijs</td><td class="r">${fmtEur(t.fixedRevenue)}</td></tr>
            <tr><td><em>Eigen verdiensten</em></td><td class="r"><em>${fmtEur(t.profit)}</em></td></tr>
          ` : `
            ${matRowsEnabled.length > 0 ? `<tr><td>Totaal materialen</td><td class="r">${fmtEur(t.matTotal)}</td></tr>` : ''}
            ${svcRowsEnabled.length > 0  ? `<tr><td>Totaal diensten</td><td class="r">${fmtEur(t.svcTotal)}</td></tr>` : ''}
          `}
          <tr class="row-final"><td>TOTAAL excl. BTW</td><td class="r">${fmtEur(t.subtotal)}</td></tr>
          <tr class="row-btw"><td>BTW (21%)</td><td class="r">+ ${fmtEur(t.btw)}</td></tr>
          <tr class="row-incl"><td>Incl. BTW</td><td class="r">${fmtEur(t.grandTotal)}</td></tr>
        </tbody>
      </table>
    </div>
    `}

    ${(opts.show_exclusions && qe.exclusions.length > 0) ? `
    <div class="excl-block">
      <div class="lbl">Exclusief</div>
      <ul class="excl-pdf-list">
        ${qe.exclusions.map(ex => `<li>${escHtml(ex)}</li>`).join('')}
      </ul>
    </div>` : ''}
  </div>

  ${opts.show_validity ? `
  <div class="quote-end-footer">
    <div class="validity">
      Deze offerte is 30 dagen geldig. &nbsp;·&nbsp; Bij opdracht vragen we een aanbetaling van 50%. &nbsp;·&nbsp; Levertijd in overleg.
    </div>
  </div>` : ''}
</div>

${extraImagesPage}

</td></tr></tbody></table>
</body></html>`;

  const suffix = isClient ? '' : '_intern';
  const clientName = (qe.client || '').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const pdfFilename = `${quoteNum}_${clientName || 'offerte'}${suffix}.pdf`;

  if (state.config?.mode === 'api') {
    // ── API mode: generate PDF bytes and save directly on server ──
    const pdfBase64 = await api.generatePdf(html);
    if (!pdfBase64) { toast('PDF genereren mislukt', 'error'); return; }

    const projectName = quoteProjectName();
    if (!projectName) { toast('Geen projectnaam — sla de offerte eerst op', 'error'); return; }

    const r = await api.apiFetch({
      method: 'POST',
      url:    `${state.config.apiUrl}/api/save-quote-pdf`,
      body:   { project_name: projectName, filename: pdfFilename, pdf_base64: pdfBase64 },
    });
    if (r.data?.ok) {
      toast(`📄 PDF opgeslagen in Offertes map van "${projectName}"`);
    } else if (r.data?.no_folder) {
      toast(`Projectmap "${projectName}" niet gevonden op server`, 'warn', 5000);
    } else {
      toast(`PDF opslaan mislukt: ${r.data?.error || 'onbekende fout'}`, 'error', 4000);
    }
  } else {
    // ── File mode: local save dialog ──
    await api.exportPdf(html, pdfFilename);
  }

  } catch (err) {
    toast('PDF exporteren mislukt: ' + (err.message || err), 'error', 4000);
    console.error('exportQuotePdf error:', err);
  }
}

// ─── Quote helpers ────────────────────────────────────────────────────────────

function fmtEur(n) {
  return '€\u00a0' + Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Toont profitRatioPct (% van de geoffreerde winst dat gerealiseerd is) als een
// duidelijker afwijking t.o.v. de prognose: 100% (precies op prognose) -> "+0%",
// 129% -> "+29%", 82% -> "-18%".
function fmtProfitDelta(profitRatioPct) {
  if (profitRatioPct === null) return '—';
  const delta = profitRatioPct - 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`;
}

function fmtQuoteStatus(s) {
  return { draft: 'Concept', sent: 'Verzonden', accepted: 'Geaccepteerd', rejected: 'Afgewezen', later: 'Later' }[s] || s;
}

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'later'];

function quoteStatusOptionsHtml(selected) {
  return QUOTE_STATUSES.map(s => `<option value="${s}" ${s === selected ? 'selected' : ''}>${fmtQuoteStatus(s)}</option>`).join('');
}

/* ─── Team Members ───────────────────────────────────────────────────────────── */

const MEMBER_COLORS = ['#4f8ef7','#7c5cbf','#3ecf74','#f76060','#f7c948','#f79040','#40c8f7'];

function wireTeam() {
  document.getElementById('team-btn').onclick = () => openTeamModal();
  document.getElementById('team-close').onclick = () =>
    document.getElementById('team-modal').classList.add('hidden');
  document.getElementById('team-modal').addEventListener('mousedown', e => {
    if (e.target === document.getElementById('team-modal'))
      document.getElementById('team-modal').classList.add('hidden');
  });
  document.getElementById('add-member-btn').onclick = addMember;
  document.getElementById('new-member-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') addMember();
  });
}

async function openTeamModal() {
  await renderTeamList();
  document.getElementById('team-modal').classList.remove('hidden');
  document.getElementById('new-member-name').focus();
}

async function renderTeamList() {
  const members = await remoteQuery({ action: 'select', table: 'team_members' });
  const el = document.getElementById('team-list');

  if (members.length === 0) {
    el.innerHTML = `<div style="color:var(--text2);font-size:13px;padding:12px 0">Nog geen teamleden. Voeg er een toe hieronder.</div>`;
  } else {
    el.innerHTML = members.map(m => {
      const initials = m.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      return `<div class="team-member-row">
        <div class="team-avatar" style="background:${m.color || MEMBER_COLORS[0]}">${initials}</div>
        <div class="team-member-info">
          <div class="team-member-name">${escHtml(m.name)}</div>
          ${m.email ? `<div class="team-member-email">${escHtml(m.email)}</div>` : ''}
        </div>
        <button class="team-member-delete" data-id="${m.id}" title="Verwijder">✕</button>
      </div>`;
    }).join('');

    el.querySelectorAll('.team-member-delete').forEach(btn => {
      btn.onclick = async () => {
        await remoteQuery({ action: 'delete', table: 'team_members', where: { id: btn.dataset.id } });
        await renderTeamList();
        await refreshTeamDatalist();
      };
    });
  }
  await refreshTeamDatalist();
}

async function addMember() {
  const nameEl  = document.getElementById('new-member-name');
  const emailEl = document.getElementById('new-member-email');
  const name = nameEl.value.trim();
  if (!name) { shake(nameEl); return; }

  const members = await remoteQuery({ action: 'select', table: 'team_members' });
  const color = MEMBER_COLORS[members.length % MEMBER_COLORS.length];

  await remoteQuery({ action: 'insert', table: 'team_members', data: {
    name, email: emailEl.value.trim(), color,
  }});

  nameEl.value  = '';
  emailEl.value = '';
  await renderTeamList();
  toast(`${name} toegevoegd aan team`);
}

async function refreshTeamDatalist() {
  // Autocomplete now uses the custom wireAssignedAutoComplete dropdown — no-op
}

/* ─── CalDAV UI ──────────────────────────────────────────────────────────────── */


// ── Sync status pill (sidebar) ────────────────────────────────────────────────

function updateSyncPill(text, type) {
  const pill = document.getElementById('sync-status-pill');
  if (!pill) return;
  pill.textContent = text;
  pill.className = type;
  pill.classList.remove('hidden');
}

function initListeners() {
  api.onDbChanged(async () => {
    await loadAll();
    renderView();
  });

  api.onUpdateAvailable(({ latest, url }) => {
    const XATTR_CMD = 'xattr -cr /Applications/Project\\ Manager.app';
    // Auto-copy xattr command as soon as update banner appears
    navigator.clipboard.writeText(XATTR_CMD).catch(() => {});

    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px">
        <span>Nieuwe versie <strong>v${latest}</strong> beschikbaar</span>
        <span style="font-size:11px;color:var(--green)">✓ Terminal-opdracht gekopieerd naar klembord</span>
      </div>
      <button class="btn btn-primary" style="padding:4px 12px;font-size:12px;flex-shrink:0" id="update-download-btn">Download</button>
      <button class="btn btn-ghost" style="padding:4px 8px;font-size:12px;flex-shrink:0" id="update-dismiss-btn">✕</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('update-download-btn').onclick = () => {
      const btn = document.getElementById('update-download-btn');
      btn.textContent = 'Downloaden…';
      btn.disabled = true;
      api.downloadUrl(url);

      // Listen for download completion
      if (api.onDownloadComplete) {
        api.onDownloadComplete((filePath) => {
          toast('Download voltooid: ' + filePath.split('/').pop());
        });
      }

      // Replace banner with install instructions
      banner.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;flex:1">
          <span style="font-weight:600">📥 Installatie-instructies v${latest}</span>
          <ol style="margin:0;padding-left:18px;font-size:12px;color:var(--text);line-height:1.7">
            <li>Wacht tot de download klaar is (zie je Downloads map)</li>
            <li>Open het gedownloade <strong>.dmg</strong> bestand</li>
            <li>Sleep <strong>Project Manager</strong> naar je <strong>Applications</strong> map</li>
            <li>Open <strong>Terminal</strong> en plak de gekopieerde opdracht: <code style="background:var(--bg3);padding:1px 6px;border-radius:3px;user-select:all">${XATTR_CMD}</code></li>
            <li>Druk op <strong>Enter</strong>, open daarna de app</li>
          </ol>
          <span style="font-size:11px;color:var(--green)">✓ Opdracht staat al op je klembord</span>
          <div style="margin-top:6px;display:flex;gap:8px">
            <button class="btn btn-primary" style="padding:5px 14px;font-size:12px" id="update-quit-btn">Afsluiten & installeren</button>
            <button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" id="update-dismiss-btn">Later</button>
          </div>
        </div>
      `;
      document.getElementById('update-quit-btn').onclick = () => {
        if (api.quitApp) api.quitApp();
      };
      document.getElementById('update-dismiss-btn').onclick = () => banner.remove();
    };
    document.getElementById('update-dismiss-btn').onclick = () => banner.remove();
  });
}

/* ─── Boot ─────────────────────────────────────────────────────────────────── */
init().catch(console.error);
