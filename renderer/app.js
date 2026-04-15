'use strict';

/* ─── Constants ────────────────────────────────────────────────────────────── */
const COLORS = [
  '#4f8ef7','#7c5cbf','#3ecf74','#f76060','#f7c948',
  '#f79040','#40c8f7','#f740c0','#80f740','#a0522d',
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
  today: new Date(),
  cursor: new Date(),        // tracks month/week/day
  tasks: [],
  projects: [],
  stages: [],
  todoLists: [],
  todoItems: {},             // { listId: [...items] }
  editingTask: null,
  editingList: null,
  editingProject: null,
  editingStage: null,
  activeProject: null,
  expandedProjects: new Set(),
  ganttMode: 'week',   // 'week' | 'day'
  ganttHideInactive: true,
  projectsHideInactive: true,
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
    e.preventDefault();
    const entry = undoStack.pop();
    if (entry) { await entry.fn(); toast(`↩ ${entry.label}`); }
  }
});

/* ─── Startup ──────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

async function init() {
  buildColorSwatches();
  wireWizard();
  wireTaskModal();
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

      const [tasks, projects, stages, todoLists] = await Promise.all([
        remoteQuery({ action: 'select', table: 'tasks' }),
        remoteQuery({ action: 'select', table: 'projects' }),
        remoteQuery({ action: 'select', table: 'project_stages' }),
        remoteQuery({ action: 'select', table: 'todo_lists' }),
      ]);

      if (!Array.isArray(tasks) || !Array.isArray(projects)) return; // bad response

      const changed =
        JSON.stringify(tasks)     !== JSON.stringify(state.tasks)    ||
        JSON.stringify(projects)  !== JSON.stringify(state.projects)  ||
        JSON.stringify(stages)    !== JSON.stringify(state.stages)    ||
        JSON.stringify(todoLists) !== JSON.stringify(state.todoLists);

      if (!changed) return;

      state.tasks     = tasks;
      state.projects  = projects;
      state.stages    = stages;
      state.todoLists = todoLists;
      for (const list of state.todoLists) {
        state.todoItems[list.id] = await remoteQuery({
          action: 'select', table: 'todo_items', where: { list_id: list.id },
        });
      }
      renderView();
    } catch (_) {
      // silently ignore network errors during background poll
    }
  }, 5000);
}

/* ─── Data Loading ─────────────────────────────────────────────────────────── */
async function loadAll() {
  await Promise.all([loadTasks(), loadTodoLists(), loadProjects(), loadStages()]);
}

async function loadProjects() {
  state.projects = await remoteQuery({ action: 'select', table: 'projects' });
}

async function loadStages() {
  state.stages = await remoteQuery({ action: 'select', table: 'project_stages' });
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

function setView(view) {
  state.view = view;
  state.activeProject = null;
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => {
    const isActive = b.dataset.view === view || (b.dataset.view === 'calendar' && CAL_VIEWS.has(view));
    b.classList.toggle('active', isActive);
  });
  const titles = { monthly:'', weekly:'', daily:'', yearly:'Kalender', mytasks:'Mijn Taken', todo:'Takenlijsten', quotes:'Offertes', gantt:'Gantt', projects:'Projecten' };
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
        html += `<div class="month-sbar" data-stage-id="${s.id}"
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
      <span id="cal-month-label" style="display:none"></span>
      <button class="btn-icon" id="cal-next">›</button>
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
  content.querySelectorAll('.month-page')[RANGE].scrollIntoView({ behavior: 'instant' });

  // Track visible month → update label + cursor
  const scroll = document.getElementById('monthly-scroll');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const y = parseInt(e.target.dataset.year), m = parseInt(e.target.dataset.month);
        state.cursor = new Date(y, m, 1);
        const titleEl = document.getElementById('toolbar-title');
        if (titleEl) titleEl.innerHTML = `<span class="cal-period-label">${MONTHS[m]}</span><span class="cal-period-year">${y}</span>`;
      }
    });
  }, { threshold: 0.5, root: scroll });
  content.querySelectorAll('.month-page').forEach(p => observer.observe(p));

  document.getElementById('cal-prev').onclick = () => scroll.scrollBy({ top: -scroll.clientHeight, behavior: 'smooth' });
  document.getElementById('cal-next').onclick = () => scroll.scrollBy({ top: scroll.clientHeight, behavior: 'smooth' });
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
  const f = state.calFilter.stages;
  if (f === 'none') return [];
  if (f === 'active') {
    const activeIds = new Set(state.projects.filter(p => p.status === 'active').map(p => p.id));
    return state.stages.filter(s => activeIds.has(s.project_id));
  }
  return state.stages;
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
  const dow = new Date(dateStr).getDay(); // 0=Sun,6=Sat
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
    const d = new Date(dateStr);
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

  // Find Monday of the week
  const d = new Date(state.cursor);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));

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
      ${calViewToggleHTML('weekly')}
    </div>`;
  wireCalViewToggle();
  renderCalFilterBar();

  document.getElementById('wk-prev').onclick = () => {
    state.cursor = new Date(monday); state.cursor.setDate(monday.getDate() - 7); renderWeekly();
  };
  document.getElementById('wk-next').onclick = () => {
    state.cursor = new Date(monday); state.cursor.setDate(monday.getDate() + 7); renderWeekly();
  };

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
      return `<div class="week-task-card cal-chip-stage cal-chip-stage-${s.stageEvent}" data-stage-id="${s.id}"
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
    html += `<div class="daily-stage-row" data-stage-id="${s.id}" style="border-left:4px solid ${s.color || '#3ecf74'}">
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
    </div>`;
  wireCalViewToggle();
  document.getElementById('gnt-prev').onclick = prevFn;
  document.getElementById('gnt-next').onclick = nextFn;
  document.getElementById('gmt-week').onclick = () => { state.ganttMode = 'week'; renderGantt(); };
  document.getElementById('gmt-day').onclick  = () => { state.ganttMode = 'day';  renderGantt(); };
  document.getElementById('gnt-filter-btn').onclick = () => { state.ganttHideInactive = !state.ganttHideInactive; renderGantt(); };
  renderCalFilterBar();
}

/* ─── Gantt Week View (Projects, multi-week overview) ──────────────────────── */
function renderGanttWeek() {
  const N_WEEKS  = 12;   // columns visible at once
  const NAV_STEP = 4;    // weeks to jump per prev/next click
  const content  = document.getElementById('content');

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
    .filter(p => !state.ganttHideInactive || p.status === 'active')
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
      .sort((a, b) => {
        if (!a.start_date && !b.start_date) return 0;
        if (!a.start_date) return 1;
        if (!b.start_date) return -1;
        return a.start_date.localeCompare(b.start_date);
      });

    // Stage rows (only when expanded) — grouped by name
    const stageRows = isExpanded ? _ganttGroupedStageRows(projStages, p, bgCells, todayLine, rangeStart, rangeEnd, totalDays) : '';

    const addStageRow = isExpanded ? `<div class="gnt-row gnt-add-stage-row" data-proj-id="${p.id}" style="cursor:pointer">
      <div class="gnt-lbl gnt-stage-lbl" style="border-left:3px solid transparent;opacity:.5">
        <div class="gnt-lbl-text"><span class="gnt-stage-name">+ Fase</span></div>
      </div>
      <div class="gnt-timeline">${bgCells}</div>
    </div>` : '';

    return `<div class="gnt-row gnt-proj-row" data-proj-id="${p.id}" style="border-left:4px solid ${p.color||'#4f8ef7'}">
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
function _ganttGroupedStageRows(projStages, p, bgCells, todayLine, rangeStart, rangeEnd, totalDays) {
  // Pre-compute task counts per stage to avoid O(n*m) filtering in the loop
  const tasksByStage = {};
  state.tasks.forEach(t => {
    if (t.stage_id == null) return;
    if (!tasksByStage[t.stage_id]) tasksByStage[t.stage_id] = { total: 0, open: 0 };
    tasksByStage[t.stage_id].total++;
    if (t.status !== 'done') tasksByStage[t.stage_id].open++;
  });

  // Group by name, preserving first-occurrence order
  const groups = {}, groupOrder = [];
  projStages.forEach(s => {
    if (!groups[s.name]) { groups[s.name] = []; groupOrder.push(s.name); }
    groups[s.name].push(s);
  });
  return groupOrder.map(name => {
    const stages = groups[name];
    const color = stages[0].color || p.color || '#4f8ef7';
    const bars = stages.map(s => {
      const hasBar = s.start_date && s.end_date && s.start_date <= rangeEnd && s.end_date >= rangeStart;
      if (!hasBar) return '';
      const sCs = s.start_date < rangeStart ? rangeStart : s.start_date;
      const sCe = s.end_date   > rangeEnd   ? rangeEnd   : s.end_date;
      const sLeft  = (_dayOffset(rangeStart, sCs) / totalDays * 100).toFixed(2);
      const sWidth = ((_dayOffset(rangeStart, sCe) - _dayOffset(rangeStart, sCs) + 1) / totalDays * 100).toFixed(2);
      const counts = tasksByStage[s.id] || { total: 0, open: 0 };
      const taskCount = counts.total;
      const openCount = counts.open;
      const titleParts = [escHtml(s.name)];
      if (s.notes) titleParts.push(escHtml(s.notes));
      if (taskCount > 0) titleParts.push(`${openCount}/${taskCount} taken`);
      const title = titleParts.join(' — ');
      return `<div class="gnt-bar gnt-stage-bar"
        data-stage-id="${s.id}" data-proj-id="${p.id}"
        data-start="${s.start_date}" data-end="${s.end_date}"
        style="left:${sLeft}%;width:${sWidth}%;background:${color}"
        title="${title}">
        <div class="gnt-bar-hl"></div>
        ${taskCount > 0 ? `<span class="gnt-bar-task-count">${openCount}/${taskCount}</span>` : (s.notes ? `<span class="gnt-bar-notes-dot">●</span>` : '')}
        <div class="gnt-bar-hr"></div>
      </div>`;
    }).join('');
    return `<div class="gnt-row gnt-stage-row"
      data-stage-id="${stages[0].id}"
      data-proj-id="${p.id}"
      style="cursor:pointer">
      <div class="gnt-lbl gnt-stage-lbl" style="border-left:3px solid ${color}">
        <div class="gnt-stage-dot" style="background:${color}"></div>
        <div class="gnt-lbl-text">
          <span class="gnt-stage-name">${escHtml(name)}</span>
        </div>
      </div>
      <div class="gnt-timeline">${bgCells}${todayLine}${bars}</div>
    </div>`;
  }).join('');
}

function _ganttDateFromClick(e, rangeStart, totalDays) {
  const timeline = e.target.closest('.gnt-timeline');
  if (!timeline) return null;
  const rect = timeline.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
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
    ganttDraw.endDate = _ganttAddDays(rangeStart, endDayOffset);
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

  let newStart = origStart, newEnd = origEnd;
  if (type === 'move') {
    newStart = _ganttAddDays(origStart, rawDelta);
    newEnd   = _ganttAddDays(origEnd,   rawDelta);
  } else if (type === 'resize-l') {
    newStart = _ganttAddDays(origStart, rawDelta);
    if (newStart >= origEnd) newStart = _ganttAddDays(origEnd, -1);
  } else if (type === 'resize-r') {
    newEnd = _ganttAddDays(origEnd, rawDelta);
    if (newEnd <= origStart) newEnd = _ganttAddDays(origStart, 1);
  }

  // Live-update bar position in DOM (no DB write yet)
  const rangeStartMs = new Date(rangeStart + 'T00:00:00').getTime();
  const startOff = Math.round((new Date(newStart + 'T00:00:00') - rangeStartMs) / 86400000);
  const endOff   = Math.round((new Date(newEnd   + 'T00:00:00') - rangeStartMs) / 86400000);
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
    if (d.startDate !== d.endDate || d.endDate) {
      ganttJustDragged = true;
      setTimeout(() => { ganttJustDragged = false; }, 300);
      // Find existing stage with same name that has no dates yet, or update the referenced stage
      const refStage = state.stages.find(s => s.id == d.stageId);
      const sameNameEmpty = state.stages.find(s =>
        s.project_id == d.projId && s.name === d.stageName && (!s.start_date || !s.end_date)
      );
      const target = sameNameEmpty || refStage;
      if (target) {
        // Update existing stage dates
        await remoteQuery({ action: 'update', table: 'project_stages', data: {
          start_date: d.startDate,
          end_date:   d.endDate || d.startDate,
        }, where: { id: target.id } });
      } else {
        // No empty slot — create a new time slot for this stage name
        const existing = state.stages.filter(s => s.project_id == d.projId);
        await remoteQuery({ action: 'insert', table: 'project_stages', data: {
          project_id: d.projId,
          name:       d.stageName,
          color:      d.stageColor,
          sort_order: existing.length,
          start_date: d.startDate,
          end_date:   d.endDate || d.startDate,
          notes:      '',
        }});
      }
      await loadStages();
      renderGantt();
      toast(`'${d.stageName}' toegevoegd`);
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

  if (d.stageId) {
    await remoteQuery({ action: 'update', table: 'project_stages',
      data: { start_date: d.pendingStart, end_date: d.pendingEnd }, where: { id: d.stageId } });
    const s = state.stages.find(x => x.id == d.stageId);
    if (s) { s.start_date = d.pendingStart; s.end_date = d.pendingEnd; }
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
        const startDate = _ganttAddDays(rangeStart, startDayOffset);
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

  const days = Array.from({ length: N_DAYS }, (_, i) => {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() + i);
    return d;
  });

  const rangeStart = toDateStr(days[0]);
  const rangeEnd   = toDateStr(days[N_DAYS - 1]);
  const totalDays  = N_DAYS;

  const fmt = d => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  const rangeLabel = `${fmt(days[0])} – ${fmt(days[N_DAYS - 1])} ${days[N_DAYS - 1].getFullYear()}`;

  ganttToolbarNav(
    rangeLabel,
    () => { state.cursor = new Date(anchor); state.cursor.setDate(anchor.getDate() - NAV_STEP); renderGantt(); },
    () => { state.cursor = new Date(anchor); state.cursor.setDate(anchor.getDate() + NAV_STEP); renderGantt(); }
  );

  const NL_DAYS_SHORT = ['zo','ma','di','wo','do','vr','za'];

  // Day column headers
  const headerCells = days.map(d => {
    const ds = toDateStr(d);
    const isToday = ds === todayStr;
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    return `<div class="gnt-day-h${isToday?' today-h':''}${isWeekend?' weekend-h':''}">
      <span class="gnt-dh-dow">${NL_DAYS_SHORT[dow]}</span>
      <span class="gnt-dh-num">${d.getDate()}</span>
    </div>`;
  }).join('');

  // Background cells
  const bgCells = days.map(d => {
    const ds = toDateStr(d);
    const isToday = ds === todayStr;
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    return `<div class="gnt-day-cell${isWeekend?' weekend-cell':''}${isToday?' today-cell':''}"></div>`;
  }).join('');

  // Today line
  const todayOffDays = _dayOffset(rangeStart, todayStr);
  const todayLine = (todayOffDays >= 0 && todayOffDays < totalDays)
    ? `<div class="gnt-today-line" style="left:${((todayOffDays + 0.5) / totalDays * 100).toFixed(2)}%"></div>`
    : '';

  // Visible projects (any overlap with range)
  const visibleProjects = state.projects
    .filter(p => (!state.ganttHideInactive || p.status === 'active') && p.start_date && p.end_date && p.start_date <= rangeEnd && p.end_date >= rangeStart);

  if (visibleProjects.length === 0) {
    content.innerHTML = `<div id="gantt-wrap"><div class="empty"><div class="empty-icon">📁</div><p>Geen projecten in dit bereik. Maak een project aan via <strong>Projecten</strong> en stel start/einddatum in.</p></div></div>`;
    wireGanttInteractions(rangeStart, totalDays);
    return;
  }

  const rowsHtml = visibleProjects.map(p => {
    const clampStart = p.start_date < rangeStart ? rangeStart : p.start_date;
    const clampEnd   = p.end_date   > rangeEnd   ? rangeEnd   : p.end_date;
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
      .sort((a, b) => {
        if (!a.start_date && !b.start_date) return 0;
        if (!a.start_date) return 1;
        if (!b.start_date) return -1;
        return a.start_date.localeCompare(b.start_date);
      });

    // Stage rows (only when expanded) — grouped by name
    const stageRows = isExpanded ? _ganttGroupedStageRows(projStages, p, bgCells, todayLine, rangeStart, rangeEnd, totalDays) : '';

    return `<div class="gnt-row gnt-proj-row" data-proj-id="${p.id}" style="border-left:4px solid ${p.color||'#4f8ef7'}">
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
    </div>${stageRows}`;
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

  wireGanttInteractions(rangeStart, totalDays);
}

/* ─── Projects View ────────────────────────────────────────────────────────── */
function renderProjectsView() {
  const content = document.getElementById('content');
  const ctrl    = document.getElementById('toolbar-controls');

  ctrl.innerHTML = `
    <button class="btn btn-primary btn-sm" id="new-proj-btn">+ Nieuw project</button>
    <button class="btn btn-sm${state.projectsHideInactive?' btn-primary':' btn-ghost'}" id="proj-filter-btn">
      ${state.projectsHideInactive ? 'Toon alles' : 'Alleen actief'}
    </button>`;
  document.getElementById('new-proj-btn').onclick = () => openProjectModal(null);
  document.getElementById('proj-filter-btn').onclick = () => { state.projectsHideInactive = !state.projectsHideInactive; renderProjectsView(); };

  const visibleProjects = state.projectsHideInactive
    ? state.projects.filter(p => p.status === 'active')
    : state.projects;

  if (visibleProjects.length === 0) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">📁</div><p>Nog geen projecten. Maak een project aan om te beginnen.</p></div>`;
    return;
  }

  const html = `<div class="proj-grid">` +
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
          <div class="proj-card-meta">${doneCount}/${taskCount} taken afgerond</div>
        </div>
      </div>`;
    }).join('') + `</div>`;

  content.innerHTML = html;
  content.querySelectorAll('.proj-card').forEach(card => {
    card.onclick = () => {
      const proj = state.projects.find(p => p.id == card.dataset.projId);
      if (proj) renderProjectDetail(proj);
    };
  });
}

/* ─── Project Detail Page ──────────────────────────────────────────────────── */
function renderProjectDetail(proj) {
  state.activeProject = proj;
  const content = document.getElementById('content');
  const ctrl    = document.getElementById('toolbar-controls');

  // Toolbar: back | edit | add task
  ctrl.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="proj-back-btn">← Projecten</button>
    <button class="btn btn-ghost btn-sm" id="proj-edit-btn">✏ Bewerken</button>
    <button class="btn btn-primary btn-sm" id="proj-add-task-btn">+ Taak</button>`;
  document.getElementById('proj-back-btn').onclick = () => setView('projects');
  document.getElementById('proj-edit-btn').onclick = () => openProjectModal(proj);
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
  const projStages = state.stages.filter(s => s.project_id == proj.id);
  const nameCounts = {};
  projStages.forEach(s => { nameCounts[s.name] = (nameCounts[s.name] || 0) + 1; });
  const presetBtns = DEFAULT_STAGES.map(ds => {
    const count = nameCounts[ds.name] || 0;
    const badge = count > 0 ? ` <span class="phase-preset-count">×${count}</span>` : '';
    return `<button class="phase-preset-btn${count>0?' used':''}" data-name="${escHtml(ds.name)}" data-color="${ds.color}"
      style="border-left-color:${ds.color}">${escHtml(ds.name)}${badge}</button>`;
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
    // Deduplicate stages by name — show each name once, merge tasks from all instances
    const seenNames = new Set();
    const deduped = projStages.filter(s => {
      if (seenNames.has(s.name)) return false;
      seenNames.add(s.name);
      return true;
    });
    html += deduped.map(s => {
      const c = s.color || proj.color || '#4f8ef7';
      const label = escHtml(s.name);
      // Collect all stage IDs with this name for task matching
      const allIds = projStages.filter(ps => ps.name === s.name).map(ps => ps.id);
      const stageTasks = state.tasks.filter(t => allIds.includes(t.stage_id));
      // Merge date range from all instances
      const allDates = projStages.filter(ps => ps.name === s.name && ps.start_date && ps.end_date);
      const mergedStart = allDates.length ? allDates.reduce((min, ps) => ps.start_date < min ? ps.start_date : min, allDates[0].start_date) : '';
      const mergedEnd = allDates.length ? allDates.reduce((max, ps) => ps.end_date > max ? ps.end_date : max, allDates[0].end_date) : '';
      const openCount = stageTasks.filter(t => t.status !== 'done').length;
      const taskBadge = stageTasks.length > 0 ? ` <span class="stage-task-badge">${openCount}/${stageTasks.length}</span>` : '';
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
            <div class="proj-stage-name">${label}${taskBadge}</div>
            <div class="proj-stage-dates">${(mergedStart && mergedEnd) ? `${mergedStart} → ${mergedEnd}` : '<span style="opacity:.5">Geen datums</span>'}</div>
          </div>
          <span class="stage-expand-arrow" data-stage-id="${s.id}">▸</span>
          <button class="btn btn-sm btn-ghost dup-stage-btn" data-stage-id="${s.id}" title="Dupliceer fase">⊕</button>
          <button class="btn btn-sm btn-ghost del-stage-btn" data-stage-name="${escHtml(s.name)}" data-proj-id="${proj.id}" title="Verwijder fase">🗑</button>
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
      const existing = state.stages.filter(s => s.project_id == proj.id);
      await remoteQuery({ action: 'insert', table: 'project_stages', data: {
        project_id: proj.id,
        name:       btn.dataset.name,
        color:      btn.dataset.color,
        sort_order: existing.length,
        start_date: '',
        end_date:   '',
      }});
      await loadStages();
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
      toast(`'${btn.dataset.name}' toegevoegd`);
    };
  });
  // Stage row click → toggle task drawer
  content.querySelectorAll('.proj-stage-row').forEach(row => {
    row.onclick = e => {
      if (e.target.closest('.dup-stage-btn')) return;
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
      if (e.target.closest('.dup-stage-btn') || e.target.closest('.del-stage-btn')) return;
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
      if (!confirm('Fase verwijderen?')) return;
      // Delete all stage instances with this name for this project
      const name = btn.dataset.stageName;
      const projId = Number(btn.dataset.projId);
      const toDelete = state.stages.filter(s => s.project_id == projId && s.name === name);
      for (const s of toDelete) {
        await remoteQuery({ action: 'delete', table: 'project_stages', where: { id: s.id } });
      }
      await loadStages();
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
      toast('Fase verwijderd');
    };
  });

  content.querySelectorAll('.dup-stage-btn').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const stage = state.stages.find(s => s.id == btn.dataset.stageId);
      if (!stage) return;
      const existing = state.stages.filter(s => s.project_id == proj.id);
      await remoteQuery({ action: 'insert', table: 'project_stages', data: {
        project_id: proj.id,
        name:       stage.name,
        color:      stage.color,
        sort_order: existing.length,
        start_date: '',
        end_date:   '',
      }});
      await loadStages();
      renderProjectDetail(state.projects.find(p => p.id === proj.id) || proj);
      toast(`'${stage.name}' gedupliceerd`);
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
  document.getElementById('proj-desc').value   = proj?.description || '';
  document.getElementById('proj-start').value  = proj?.start_date  || '';
  document.getElementById('proj-end').value    = proj?.end_date    || '';
  document.getElementById('proj-status').value = proj?.status      || 'active';
  document.getElementById('proj-delete').classList.toggle('hidden', !isEdit);
  // Auto-pick an unused color for new projects
  let defaultColor = COLORS[0];
  if (!isEdit) {
    const usedColors = new Set(state.projects.map(p => p.color));
    defaultColor = COLORS.find(c => !usedColors.has(c)) || COLORS[state.projects.length % COLORS.length];
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

  document.getElementById('project-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('project-modal')) closeProjectModal();
  });

  document.getElementById('proj-save').onclick = async () => {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) { shake(document.getElementById('proj-name')); return; }
    const selectedSwatch = document.querySelector('#proj-color-swatches .color-swatch.selected');
    const data = {
      name,
      description: document.getElementById('proj-desc').value.trim(),
      start_date:  document.getElementById('proj-start').value || '',
      end_date:    document.getElementById('proj-end').value   || '',
      status:      document.getElementById('proj-status').value,
      color:       selectedSwatch?.dataset.color || COLORS[0],
      created_by:  state.config?.name || '',
    };
    if (state.editingProject) {
      await remoteQuery({ action: 'update', table: 'projects', data, where: { id: state.editingProject.id } });
    } else {
      await remoteQuery({ action: 'insert', table: 'projects', data });
    }
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
  document.getElementById('stage-name').value  = stage?.name       || '';
  document.getElementById('stage-start').value = stage?.start_date || suggestedDate || '';
  document.getElementById('stage-end').value   = stage?.end_date   || suggestedDate || '';
  document.getElementById('stage-notes').value = stage?.notes      || '';
  document.getElementById('stage-delete').classList.toggle('hidden', !isEdit);
  buildStageColorSwatches(stage?.color || COLORS[0]);
  // Stage tasks section (only for saved stages)
  const tasksSection = document.getElementById('stage-tasks-section');
  tasksSection.classList.toggle('hidden', !isEdit);
  if (isEdit) {
    remoteQuery({ action: 'select', table: 'team_members' }).then(members => {
      const sel = document.getElementById('stage-task-assignee');
      sel.innerHTML = `<option value="">— Niemand —</option>` +
        members.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
    });
    renderStageTasks(stage.id);
  }
  document.getElementById('stage-modal').classList.remove('hidden');
  document.getElementById('stage-name').focus();
}

function renderStageTasks(stageId) {
  const list = document.getElementById('stage-task-list');
  if (!list) return;
  // Find all stage IDs with the same name (deduplication support)
  const refStage = state.stages.find(s => s.id == stageId);
  const allIds = refStage
    ? state.stages.filter(s => s.project_id == refStage.project_id && s.name === refStage.name).map(s => Number(s.id))
    : [Number(stageId)];
  const tasks = stageId ? state.tasks.filter(t => allIds.includes(Number(t.stage_id))) : [];
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
  document.getElementById('stage-modal').addEventListener('click', e => {
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

  document.getElementById('stage-start').addEventListener('input', () => {
    const end = document.getElementById('stage-end');
    if (!end.value) end.value = document.getElementById('stage-start').value;
  });
  document.getElementById('stage-end').addEventListener('input', () => {
    const start = document.getElementById('stage-start');
    if (!start.value) start.value = document.getElementById('stage-end').value;
  });

  document.getElementById('stage-save').onclick = async () => {
    const name = document.getElementById('stage-name').value.trim();
    if (!name) { shake(document.getElementById('stage-name')); return; }
    const selectedSwatch = document.querySelector('#stage-color-swatches .color-swatch.selected');
    const data = {
      name,
      start_date: document.getElementById('stage-start').value || '',
      end_date:   document.getElementById('stage-end').value   || '',
      color:      selectedSwatch?.dataset.color || COLORS[0],
      notes:      document.getElementById('stage-notes').value.trim(),
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
    if (!confirm('Fase verwijderen?')) return;
    await remoteQuery({ action: 'delete', table: 'project_stages', where: { id: state.editingStage.id } });
    await loadStages();
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

  // Color swatch selection
  const selectedColor = task?.color || COLORS[0];
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === selectedColor);
  });

  // Populate project dropdown
  const projSel = document.getElementById('task-project');
  const preselProject = task?.project_id ?? defaultProjectId ?? null;
  projSel.innerHTML = '<option value="">— Geen project —</option>' +
    state.projects.map(p =>
      `<option value="${p.id}" ${preselProject == p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`
    ).join('');

  // Populate stage dropdown based on selected project (deduplicated by name)
  function populateStageDropdown(projectId, selectedStageId) {
    const stageSel = document.getElementById('task-stage');
    const projStages = projectId ? state.stages.filter(s => s.project_id == projectId) : [];
    // Deduplicate: keep first occurrence per name
    const seen = new Set();
    const unique = projStages.filter(s => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
    // If selected stage isn't in unique list (it's a duplicate), find by name
    if (selectedStageId) {
      const selStage = projStages.find(s => s.id == selectedStageId);
      if (selStage) {
        const match = unique.find(s => s.name === selStage.name);
        if (match) selectedStageId = match.id;
      }
    }
    stageSel.innerHTML = '<option value="">— Geen fase —</option>' +
      unique.map(s =>
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
    const taskDate = document.getElementById('task-date').value || toDateStr(state.today);
    const proj = state.projects.find(p => p.id == projectId);
    const existing = state.stages.filter(s => s.project_id == projectId);
    const color = DEFAULT_STAGES.find(ds => ds.name.toLowerCase() === name.toLowerCase())?.color || proj?.color || COLORS[0];
    const result = await remoteQuery({ action: 'insert', table: 'project_stages', data: {
      project_id: parseInt(projectId),
      name,
      start_date: taskDate,
      end_date: taskDate,
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
  document.getElementById('task-modal').addEventListener('click', e => {
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

  document.getElementById('list-modal').addEventListener('click', e => {
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
    const theme = cfg.theme || 'light';
    document.querySelector(`input[name=theme][value=${theme}]`).checked = true;
    updateThemeCards(theme);
    document.getElementById('settings-modal').classList.remove('hidden');
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
    const newConfig = {
      name: document.getElementById('cfg-name').value.trim() || state.config?.name || '',
      mode: 'api',
      apiUrl: document.getElementById('cfg-api-url').value.trim(),
      theme,
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

  document.getElementById('settings-modal').addEventListener('click', e => {
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

// ─── Quote State ──────────────────────────────────────────────────────────────

// qe = quoteEditor live state (in-memory while editing)
let qe = null;

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
    client:     quote?.client     ?? '',
    client_contact: stored.client_contact ?? '',
    client_address: stored.client_address ?? '',
    client_postcode: stored.client_postcode ?? '',
    client_email: stored.client_email ?? '',
    client_phone: stored.client_phone ?? '',
    quote_date: quote?.quote_date ?? toDateStr(new Date()),
    margin:     quote?.margin     ?? 20,
    outsource_margin: stored.outsource_margin ?? 15,
    status:     quote?.status     ?? 'draft',
    notes:      quote?.notes      ?? '',
    image_data:     quote?.image_data || (quote?.id ? localStorage.getItem('qimg_' + quote.id) : '') || '',
    extra_images:   stored.extra_images ?? [],
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

async function renderQuoteList() {
  const ctrl = document.getElementById('toolbar-controls');
  const content = document.getElementById('content');
  ctrl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-quote-btn">+ Nieuwe offerte</button>`;
  document.getElementById('new-quote-btn').onclick = () => openQuoteWizard();
  content.innerHTML = '';

  const quotes = await remoteQuery({ action: 'select', table: 'quotes' });

  if (!Array.isArray(quotes) || quotes.length === 0) {
    document.getElementById('content').innerHTML =
      `<div class="empty"><div class="empty-icon">💶</div><p>Nog geen offertes. Klik op "+ Nieuwe offerte" om te beginnen.</p></div>`;
    return;
  }

  // Calculate total for each quote (load items)
  const rows = await Promise.all(quotes.map(async q => {
    const items = await remoteQuery({ action: 'select', table: 'quote_items', where: { quote_id: q.id } });
    const t = calcQuoteTotals(items, q.margin);
    return { q, total: t.grandTotal };
  }));

  let html = `<table class="quotes-table">
    <thead><tr>
      <th>Project</th><th>Klant</th><th>Datum</th>
      <th style="text-align:right">Totaal incl. BTW</th><th>Status</th><th></th>
    </tr></thead><tbody>`;

  rows.forEach(({ q, total }) => {
    html += `<tr class="quote-row" data-id="${q.id}">
      <td><strong>${escHtml(q.name)}</strong></td>
      <td>${escHtml(q.client)}</td>
      <td>${q.quote_date || '—'}</td>
      <td class="amount">${fmtEur(total)}</td>
      <td><span class="badge badge-${q.status}">${fmtQuoteStatus(q.status)}</span></td>
      <td><button class="quote-delete-btn" data-id="${q.id}" title="Verwijder">✕</button></td>
    </tr>`;
  });
  html += `</tbody></table>`;
  document.getElementById('content').innerHTML = html;

  document.querySelectorAll('.quote-row').forEach(row => {
    row.onclick = async () => {
      const quote = quotes.find(q => q.id == row.dataset.id);
      if (quote) openQuoteEditor(quote);
    };
  });

  document.querySelectorAll('.quote-delete-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const quote = quotes.find(q => q.id == btn.dataset.id);
      if (!quote) return;
      if (!confirm(`Verwijder offerte "${quote.name}"?`)) return;
      await remoteQuery({ action: 'delete', table: 'quotes', where: { id: quote.id } });
      toast(`Offerte "${quote.name}" verwijderd`);
      renderQuoteList();
    };
  });
}

// ─── Quote Wizard ─────────────────────────────────────────────────────────────

let qwImageData = '';

function openQuoteWizard() {
  qwImageData = '';
  document.getElementById('qw-client').value = '';
  document.getElementById('qw-name').value = '';
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

  // Load existing items if editing
  if (qe.id) {
    const items = await remoteQuery({ action: 'select', table: 'quote_items', where: { quote_id: qe.id } });
    qe.materials  = items.filter(i => i.type === 'material').map(i => ({ ...i }));
    qe.services   = items.filter(i => i.type === 'service').map(i => ({ ...i }));
    qe.exclusions = items.filter(i => i.type === 'exclusion').map(i => i.name);
  }

  renderQuoteEditorView();
}

function renderQuoteEditorView() {
  const ctrl = document.getElementById('toolbar-controls');
  ctrl.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="qe-back">← Offertes</button>
    <button class="btn btn-secondary btn-sm" id="qe-delete-btn" ${!qe.id ? 'style="display:none"' : ''}>Verwijder</button>
    <button class="btn btn-primary btn-sm" id="qe-save-btn">Opslaan</button>
    <div class="pdf-dropdown" id="pdf-dropdown">
      <button class="btn btn-secondary btn-sm" id="qe-pdf-btn">📄 PDF ▾</button>
      <div class="pdf-dropdown-menu hidden" id="pdf-dropdown-menu">
        <button class="pdf-dropdown-item" id="pdf-internal">📋 Interne offerte (volledig)</button>
        <button class="pdf-dropdown-item" id="pdf-client">📄 Klantofferte (eindprijs)</button>
      </div>
    </div>`;

  document.getElementById('toolbar-title').textContent = qe.name || 'Nieuwe offerte';
  document.getElementById('qe-back').onclick = () => { qe = null; setView('quotes'); };
  document.getElementById('qe-save-btn').onclick = saveQuote;
  document.getElementById('qe-pdf-btn').onclick = () => {
    document.getElementById('pdf-dropdown-menu').classList.toggle('hidden');
  };
  document.getElementById('pdf-internal').onclick = () => { document.getElementById('pdf-dropdown-menu').classList.add('hidden'); exportQuotePdf('internal'); };
  document.getElementById('pdf-client').onclick = () => { document.getElementById('pdf-dropdown-menu').classList.add('hidden'); exportQuotePdf('client'); };
  document.addEventListener('click', e => { if (!e.target.closest('#pdf-dropdown')) document.getElementById('pdf-dropdown-menu')?.classList.add('hidden'); });
  document.getElementById('qe-delete-btn')?.addEventListener('click', deleteQuote);

  const content = document.getElementById('content');
  content.innerHTML = `
    <!-- Top fields -->
    <div class="qe-topbar">
      <div class="qe-fields">
        <input class="qi-input qe-name"   id="qe-name"   value="${escHtml(qe.name)}"       placeholder="Projectnaam *" />
        <input class="qi-input qe-date"   id="qe-date"   type="date" value="${qe.quote_date}" />
        <select class="qi-input qe-status" id="qe-status">
          <option value="draft"    ${qe.status==='draft'    ?'selected':''}>Concept</option>
          <option value="sent"     ${qe.status==='sent'     ?'selected':''}>Verzonden</option>
          <option value="accepted" ${qe.status==='accepted' ?'selected':''}>Geaccepteerd</option>
          <option value="rejected" ${qe.status==='rejected' ?'selected':''}>Afgewezen</option>
        </select>
      </div>
    </div>

    <!-- Client details (collapsible) -->
    <details class="qe-details" open>
      <summary class="qe-details-title">Klantgegevens</summary>
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

    <textarea class="qe-notes" id="qe-notes" placeholder="Toelichting — omschrijf het project, de aanpak of bijzondere afspraken…">${escHtml(qe.notes)}</textarea>

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
          <th style="width:37%">Omschrijving</th>
          <th style="width:10%">Aantal</th>
          <th class="num" style="width:8%" title="Marge per item (leeg = globale marge)">%</th>
          <th class="num" style="width:16%">Stukprijs</th>
          <th class="num" style="width:22%">Totaal</th>
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
          <th style="width:36%">Dienst</th>
          <th style="width:9%" title="Vink aan als deze dienst wordt uitbesteed">Uitb.</th>
          <th style="width:13%">Uren</th>
          <th class="num" style="width:17%">Tarief/uur</th>
          <th class="num" style="width:18%">Totaal</th>
          <th style="width:4%"></th>
        </tr></thead>
        <tbody id="svc-tbody"></tbody>
      </table>
      <div class="qe-mat-subtotals" id="svc-subtotals"></div>
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
  document.getElementById('qe-name').addEventListener('input',   e => { qe.name = e.target.value; document.getElementById('toolbar-title').textContent = qe.name || 'Nieuwe offerte'; });
  document.getElementById('qe-client').addEventListener('input',  e => qe.client = e.target.value);
  document.getElementById('qe-client-contact').addEventListener('input', e => qe.client_contact = e.target.value);
  document.getElementById('qe-client-address').addEventListener('input', e => qe.client_address = e.target.value);
  document.getElementById('qe-client-postcode').addEventListener('input', e => qe.client_postcode = e.target.value);
  document.getElementById('qe-client-email').addEventListener('input', e => qe.client_email = e.target.value);
  document.getElementById('qe-client-phone').addEventListener('input', e => qe.client_phone = e.target.value);
  document.getElementById('qe-date').addEventListener('change',   e => qe.quote_date = e.target.value);
  document.getElementById('qe-status').addEventListener('change', e => qe.status = e.target.value);
  document.getElementById('qe-notes').addEventListener('input',   e => qe.notes = e.target.value);
  document.getElementById('qe-margin').addEventListener('focus',  e => e.target.select());
  document.getElementById('qe-margin').addEventListener('input',  e => {
    qe.margin = parseFloat(e.target.value) || 0;
    document.querySelectorAll('.qi-margin').forEach(inp => { inp.placeholder = qe.margin; });
    updateTotals();
  });
  const outMarginEl = document.getElementById('qe-out-margin');
  if (outMarginEl) {
    outMarginEl.addEventListener('focus', e => e.target.select());
    outMarginEl.addEventListener('input', e => {
      qe.outsource_margin = parseFloat(e.target.value) || 0;
      updateSvcSubtotals();
      updateTotals();
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
  wireExclusions();
  updateTotals();
  updateChecklistBadge();
}

// ─── Render sub-tables ────────────────────────────────────────────────────────

function renderMatTable() {
  const tbody = document.getElementById('mat-tbody');
  if (!tbody) return;

  tbody.innerHTML = qe.materials.map((m, i) => `
    <tr draggable="true" data-idx="${i}">
      <td class="drag-handle" title="Versleep">⠿</td>
      <td><input class="qi-input" data-t="mat" data-i="${i}" data-f="name"       value="${escHtml(m.name)}"       placeholder="Omschrijving" /></td>
      <td><input class="qi-input num" data-t="mat" data-i="${i}" data-f="quantity"  value="${m.quantity}"  type="number" min="0" step="any" /></td>
      <td><input class="qi-input num qi-margin" data-t="mat" data-i="${i}" data-f="margin" value="${m.margin ?? ''}" type="number" min="0" max="500" step="1" placeholder="${qe.margin}" title="Marge % (leeg = globaal ${qe.margin}%)" /></td>
      <td><input class="qi-input num" data-t="mat" data-i="${i}" data-f="unit_price" value="${m.unit_price}" type="number" min="0" step="any" /></td>
      <td class="num" id="mat-row-total-${i}">${fmtEur(m.quantity * m.unit_price)}</td>
      <td><button class="qi-del" data-t="mat" data-i="${i}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="7" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik een materiaal hierboven om toe te voegen</td></tr>`;

  wireTableInputs('mat');
  wireDragDrop('mat');
  updateMatSubtotals();
}

function renderSvcTable() {
  const tbody = document.getElementById('svc-tbody');
  if (!tbody) return;

  tbody.innerHTML = qe.services.map((s, i) => `
    <tr draggable="true" data-idx="${i}" class="${s.is_outsourced ? 'svc-row-outsourced' : ''}">
      <td class="drag-handle" title="Versleep">⠿</td>
      <td><input class="qi-input" data-t="svc" data-i="${i}" data-f="name"       value="${escHtml(s.name)}"      placeholder="Dienst" /></td>
      <td style="text-align:center"><input type="checkbox" class="qi-check" data-t="svc" data-i="${i}" data-f="is_outsourced" ${s.is_outsourced ? 'checked' : ''} title="Uitbesteed werk" /></td>
      <td><input class="qi-input num" data-t="svc" data-i="${i}" data-f="quantity"  value="${s.quantity}" type="number" min="0" step="0.5" /></td>
      <td class="num"><input class="qi-input num" data-t="svc" data-i="${i}" data-f="unit_price" value="${s.unit_price}" type="number" min="0" step="any" /></td>
      <td class="num" id="svc-row-total-${i}">${fmtEur(s.quantity * s.unit_price)}</td>
      <td><button class="qi-del" data-t="svc" data-i="${i}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="7" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik een dienst hierboven om toe te voegen</td></tr>`;

  wireTableInputs('svc');
  wireDragDrop('svc');
  updateSvcSubtotals();
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
    });
  });

  tbody.querySelectorAll('.qi-check').forEach(chk => {
    chk.addEventListener('change', () => {
      const i = parseInt(chk.dataset.i);
      const field = chk.dataset.f;
      const arr = type === 'mat' ? qe.materials : qe.services;
      if (!arr[i]) return;
      arr[i][field] = chk.checked ? 1 : 0;
      // Toggle the outsourced styling on the row
      const row = chk.closest('tr');
      if (row) row.classList.toggle('svc-row-outsourced', !!chk.checked);
      if (type === 'svc') updateSvcSubtotals();
      updateTotals();
    });
  });

  tbody.querySelectorAll('.qi-del').forEach(btn => {
    btn.onclick = () => {
      const i = parseInt(btn.dataset.i);
      if (type === 'mat') { qe.materials.splice(i, 1); renderMatTable(); }
      else                { qe.services.splice(i, 1);  renderSvcTable(); }
      updateTotals();
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
    });
  });
}

// ─── Preset Dropdown Menus ────────────────────────────────────────────────────

function wirePresetMenus() {
  _wirePresetMenu('mat', PRESET_MATERIALS,
    p    => { qe.materials.push({ name: p.name, quantity: 1, unit: p.unit, unit_price: p.price, margin: null }); renderMatTable(); updateTotals(); },
    name => { qe.materials.push({ name: name || '', quantity: 1, unit: 'st', unit_price: 0, margin: null }); renderMatTable(); updateTotals(); }
  );
  _wirePresetMenu('svc', PRESET_SERVICES,
    p    => { qe.services.push({ name: p.name, quantity: 1, unit: 'uur', unit_price: p.rate }); renderSvcTable(); updateTotals(); },
    name => { qe.services.push({ name: name || '', quantity: 1, unit: 'uur', unit_price: 0 }); renderSvcTable(); updateTotals(); }
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
            <span class="preset-item-meta">${p.rate != null ? `€${p.rate}/u` : p.unit}</span>
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
  };

  addBtn.addEventListener('click', addExcl);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addExcl(); } });
  renderExclusions();
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function calcQuoteTotals(items, globalMargin, outsourceMargin) {
  const matItems = items.filter(i => i.type === 'material');
  const svcItems = items.filter(i => i.type === 'service');
  const globalMarginPct = parseFloat(globalMargin) || 20;
  const outsourceMarginPct = parseFloat(outsourceMargin) || 0;

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
  const svcSelfTotal = svcSelfItems.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const svcOutCost   = svcOutItems.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const svcOutTotal  = svcOutCost * (1 + outsourceMarginPct / 100);
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

function calcQETotals() {
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
  el.innerHTML = `
    <div class="row"><span>Subtotaal materialen</span><span>${fmtEur(t.matEx)}</span></div>
    <div class="row"><span>${margeLabel(t.marginPct)}</span><span>+ ${fmtEur(t.matMargin)}</span></div>
    <div class="row bold"><span>Totaal materialen</span><span>${fmtEur(t.matTotal)}</span></div>`;
}

function updateSvcSubtotals() {
  const el = document.getElementById('svc-subtotals');
  if (!el || !qe) return;
  const t = calcQETotals();
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
    <div class="qt-row subtotal"><span class="qt-label">Subtotaal excl. BTW</span><span class="qt-val">${fmtEur(t.subtotal)}</span></div>
    <div class="qt-row"><span class="qt-label">BTW (21%)</span><span class="qt-val">+ ${fmtEur(t.btw)}</span></div>
    <div class="qt-divider"></div>
    <div class="qt-row final"><span class="qt-label">TOTAAL incl. BTW</span><span class="qt-val">${fmtEur(t.grandTotal)}</span></div>
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
    performSave();
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

async function performSave() {
  const extrasJson = JSON.stringify({
    client_contact: qe.client_contact,
    client_address: qe.client_address,
    client_postcode: qe.client_postcode,
    client_email: qe.client_email,
    client_phone: qe.client_phone,
    extra_images: qe.extra_images,
    pdf_opts: qe.pdf_opts,
    outsource_margin: qe.outsource_margin,
  });
  const quoteData = {
    name: qe.name.trim(), client: qe.client.trim(), quote_date: qe.quote_date,
    margin: qe.margin, status: qe.status, notes: qe.notes.trim(),
    created_by: state.config?.name || '',
    image_data: qe.image_data || '',
    extras_json: extrasJson,
  };

  try {
    let quoteId = qe.id;
    if (quoteId) {
      await remoteQuery({ action: 'update', table: 'quotes', data: quoteData, where: { id: quoteId } });
      await remoteQuery({ action: 'delete', table: 'quote_items', where: { quote_id: quoteId } });
    } else {
      const res = await remoteQuery({ action: 'insert', table: 'quotes', data: quoteData });
      quoteId = res.id;
      qe.id = quoteId;
    }
    // Cleanup legacy localStorage entries (now stored in DB)
    if (quoteId) {
      localStorage.removeItem('qimg_' + quoteId);
      localStorage.removeItem('qextra_' + quoteId);
    }

    const allItems = [
      ...qe.materials.map((m, i) => ({ quote_id: quoteId, type: 'material', name: m.name, quantity: m.quantity, unit: m.unit || '', unit_price: m.unit_price, sort_order: i, margin: (m.margin == null || m.margin === '') ? null : parseFloat(m.margin), is_outsourced: 0 })),
      ...qe.services.map((s, i)  => ({ quote_id: quoteId, type: 'service',  name: s.name, quantity: s.quantity, unit: 'uur', unit_price: s.unit_price, sort_order: i, margin: null, is_outsourced: s.is_outsourced ? 1 : 0 })),
      ...qe.exclusions.map((ex, i) => ({ quote_id: quoteId, type: 'exclusion', name: ex, quantity: 0, unit: '', unit_price: 0, sort_order: i, margin: null, is_outsourced: 0 })),
    ];
    for (const item of allItems) {
      await remoteQuery({ action: 'insert', table: 'quote_items', data: item });
    }

    const delBtn = document.getElementById('qe-delete-btn');
    if (delBtn) delBtn.style.display = '';

    toast('Offerte opgeslagen');
  } catch (err) {
    toast('Opslaan mislukt: ' + (err.message || err), 'error', 4000);
    console.error('saveQuote error:', err);
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

  // ── Internal PDF: full detail ──
  const matRows = qe.materials.map(m => {
    const effectivePct = (m.margin != null && m.margin !== '') ? parseFloat(m.margin) : t.marginPct;
    const displayPrice = m.unit_price * (1 + effectivePct / 100);
    return `
    <tr>
      <td>${escHtml(m.name)}</td>
      <td class="r">${m.quantity}</td>
      <td class="r">${fmtEur(displayPrice)}</td>
      <td class="r">${fmtEur(m.quantity * displayPrice)}</td>
    </tr>`;
  }).join('');

  const svcRows = qe.services.map(s => `
    <tr>
      <td>${escHtml(s.name)}</td>
      <td class="r">${s.quantity} u</td>
      <td class="r">${fmtEur(s.unit_price)}/u</td>
      <td class="r">${fmtEur(s.quantity * s.unit_price)}</td>
    </tr>`).join('');

  // ── Client PDF: items listed, no individual prices ──
  const clientItemsList = [
    ...qe.materials.map(m => escHtml(m.name)),
    ...qe.services.map(s => escHtml(s.name)),
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
  .totals-box .row-final td { font-size: 13px; font-weight: 700; background: ${bgTint}; border-bottom: none; }
  .totals-box .row-btw td { color: #888; font-size: 10px; }
  .excl-block { margin-top: 6mm; padding: 8px 14px; background: ${bgTint}; border-left: 3px solid ${accent}; border-radius: 0 4px 4px 0; break-inside: avoid; page-break-inside: avoid; }
  .excl-block .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .8px; color: #aaa; margin-bottom: 4px; }
  .excl-pdf-list { margin: 0; padding: 0 0 0 5mm; font-size: 10px; color: #666; line-height: 1.8; }
  .excl-pdf-list li { padding-left: 2px; }
  .client-addr { font-size: 10px; color: #666; line-height: 1.6; margin-top: 4px; }
  .notes-block { margin-top: 4mm; margin-bottom: 6mm; padding: 8px 14px; background: ${bgTint}; border-left: 3px solid ${accent}; border-radius: 0 4px 4px 0; font-size: 10px; color: #666; line-height: 1.6; break-inside: avoid; page-break-inside: avoid; }
  .notes-block .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .8px; color: #aaa; margin-bottom: 4px; }

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
          <tr><td>Subtotaal excl. BTW</td><td class="r">${fmtEur(t.subtotal)}</td></tr>
          <tr class="row-btw"><td>BTW (21%)</td><td class="r">+ ${fmtEur(t.btw)}</td></tr>
          <tr class="row-final"><td>TOTAAL incl. BTW</td><td class="r">${fmtEur(t.grandTotal)}</td></tr>
        </tbody>
      </table>
    </div>
    ` : `
    <!-- Internal PDF: full detail -->
    ${qe.materials.length > 0 ? `
    <h3>Materialen</h3>
    <table class="content-table">
      <thead><tr><th style="width:52%">Omschrijving</th><th class="r" style="width:14%">Aantal</th><th class="r" style="width:17%">Stukprijs</th><th class="r" style="width:17%">Totaal</th></tr></thead>
      <tbody>${matRows}</tbody>
    </table>
    ` : ''}

    ${qe.services.length > 0 ? `
    <h3>Diensten</h3>
    <table class="content-table">
      <thead><tr><th style="width:52%">Dienst</th><th class="r" style="width:14%">Uren</th><th class="r" style="width:17%">Tarief/u</th><th class="r" style="width:17%">Totaal</th></tr></thead>
      <tbody>${svcRows}</tbody>
    </table>` : ''}

    <div class="totals-box">
      <table class="content-table">
        <thead><tr><th colspan="2">Totaaloverzicht</th></tr></thead>
        <tbody>
          ${qe.materials.length > 0 ? `<tr><td>Totaal materialen</td><td class="r">${fmtEur(t.matTotal)}</td></tr>` : ''}
          ${qe.services.length > 0  ? `<tr><td>Totaal diensten</td><td class="r">${fmtEur(t.svcTotal)}</td></tr>` : ''}
          <tr><td>Subtotaal excl. BTW</td><td class="r">${fmtEur(t.subtotal)}</td></tr>
          <tr class="row-btw"><td>BTW (21%)</td><td class="r">+ ${fmtEur(t.btw)}</td></tr>
          <tr class="row-final"><td>TOTAAL incl. BTW</td><td class="r">${fmtEur(t.grandTotal)}</td></tr>
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
      Deze offerte is 30 dagen geldig na dagtekening. &nbsp;·&nbsp; Levertijd in overleg.
    </div>
  </div>` : ''}
</div>

${extraImagesPage}

</td></tr></tbody></table>
</body></html>`;

  const suffix = isClient ? '' : '_intern';
  const clientName = (qe.client || '').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  await api.exportPdf(html, `${quoteNum}_${clientName || 'offerte'}${suffix}.pdf`);
  } catch (err) {
    toast('PDF exporteren mislukt: ' + (err.message || err), 'error', 4000);
    console.error('exportQuotePdf error:', err);
  }
}

// ─── Quote helpers ────────────────────────────────────────────────────────────

function fmtEur(n) {
  return '€\u00a0' + Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQuoteStatus(s) {
  return { draft: 'Concept', sent: 'Verzonden', accepted: 'Geaccepteerd', rejected: 'Afgewezen' }[s] || s;
}

/* ─── Team Members ───────────────────────────────────────────────────────────── */

const MEMBER_COLORS = ['#4f8ef7','#7c5cbf','#3ecf74','#f76060','#f7c948','#f79040','#40c8f7'];

function wireTeam() {
  document.getElementById('team-btn').onclick = () => openTeamModal();
  document.getElementById('team-close').onclick = () =>
    document.getElementById('team-modal').classList.add('hidden');
  document.getElementById('team-modal').addEventListener('click', e => {
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
