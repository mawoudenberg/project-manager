'use strict';

/* ─── Constants ────────────────────────────────────────────────────────────── */
const COLORS = [
  '#4f8ef7','#7c5cbf','#3ecf74','#f76060','#f7c948',
  '#f79040','#40c8f7','#f740c0','#80f740','#a0522d',
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
  todoLists: [],
  todoItems: {},             // { listId: [...items] }
  editingTask: null,
  editingList: null,
  editingProject: null,
  activeProject: null,
};

/* ─── Startup ──────────────────────────────────────────────────────────────── */
async function init() {
  buildColorSwatches();
  wireWizard();
  wireTaskModal();
  wireListModal();
  wireSettings();
  wireNav();
  wireTeam();
  wireProjectModal();
  initCalDavListeners();

  const config = await api.configGet();
  if (!config || !config.name) {
    showWizard();
  } else {
    state.config = config;
    showApp();
    await loadAll();
    renderView();
    wireCalDavSettings();
    refreshTeamDatalist();
  }
}

/* ─── Data Loading ─────────────────────────────────────────────────────────── */
async function loadAll() {
  await Promise.all([loadTasks(), loadTodoLists(), loadProjects()]);
}

async function loadProjects() {
  state.projects = await api.dbQuery({ action: 'select', table: 'projects' });
}

async function loadTasks() {
  if (state.config.mode === 'file') {
    state.tasks = await api.dbQuery({ action: 'select', table: 'tasks' });
  } else {
    const r = await api.apiFetch({ method: 'GET', url: `${state.config.apiUrl}/api/tasks` });
    state.tasks = r.data || [];
  }
}

async function loadTodoLists() {
  if (state.config.mode === 'file') {
    state.todoLists = await api.dbQuery({ action: 'select', table: 'todo_lists' });
    for (const list of state.todoLists) {
      state.todoItems[list.id] = await api.dbQuery({
        action: 'select', table: 'todo_items', where: { list_id: list.id },
      });
    }
  } else {
    const r = await api.apiFetch({ method: 'GET', url: `${state.config.apiUrl}/api/lists` });
    state.todoLists = r.data || [];
    for (const list of state.todoLists) {
      const ri = await api.apiFetch({ method: 'GET', url: `${state.config.apiUrl}/api/lists/${list.id}/items` });
      state.todoItems[list.id] = ri.data || [];
    }
  }
}

/* ─── View routing ─────────────────────────────────────────────────────────── */
function renderView() {
  const views = {
    monthly:  renderMonthly,
    weekly:   renderWeekly,
    daily:    renderDaily,
    todo:     renderTodo,
    quotes:   renderQuoteList,
    gantt:    renderGantt,
    projects: renderProjectsView,
  };
  (views[state.view] || renderMonthly)();
}

function setView(view) {
  state.view = view;
  state.activeProject = null;
  document.querySelectorAll('.nav-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view)
  );
  const titles = { monthly:'Monthly View', weekly:'Weekly View', daily:'Daily View', todo:'Todo Lists', quotes:'Offertes', gantt:'Gantt Chart', projects:'Projecten' };
  document.getElementById('toolbar-title').textContent = titles[view] || '';
  renderView();
}

/* ─── Monthly View ─────────────────────────────────────────────────────────── */
function renderMonthly() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');
  const d = state.cursor;
  const year = d.getFullYear(), month = d.getMonth();

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="cal-prev">‹</button>
      <span>${MONTHS[month]} ${year}</span>
      <button class="btn-icon" id="cal-next">›</button>
      <button class="btn btn-primary btn-sm" id="cal-add">+ Add Task</button>
    </div>`;

  document.getElementById('cal-prev').onclick = () => { state.cursor = new Date(year, month-1, 1); renderMonthly(); };
  document.getElementById('cal-next').onclick = () => { state.cursor = new Date(year, month+1, 1); renderMonthly(); };
  document.getElementById('cal-add').onclick = () => openTaskModal(null, toDateStr(state.cursor));

  // Build grid
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const todayStr = toDateStr(state.today);

  let html = '<div id="monthly-grid">';
  DAYS.forEach(d => { html += `<div class="cal-header-cell">${d}</div>`; });

  // Prev month padding
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayNum = daysInPrev - i;
    const dateStr = toDateStr(new Date(year, month-1, dayNum));
    html += calCell(dayNum, dateStr, true, todayStr);
  }
  // Current month
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = toDateStr(new Date(year, month, day));
    html += calCell(day, dateStr, false, todayStr);
  }
  // Next month padding
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let day = 1; day <= remaining; day++) {
    const dateStr = toDateStr(new Date(year, month+1, day));
    html += calCell(day, dateStr, true, todayStr);
  }
  html += '</div>';

  content.innerHTML = html;

  // Attach click handlers
  content.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.cal-chip')) return;
      openTaskModal(null, cell.dataset.date);
    });
    cell.querySelectorAll('.cal-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const task = state.tasks.find(t => t.id == chip.dataset.id);
        if (task) openTaskModal(task);
      });
    });
  });
}

function calCell(dayNum, dateStr, otherMonth, todayStr) {
  const dayTasks = state.tasks.filter(t => t.date === dateStr);
  const isToday = dateStr === todayStr;
  const classes = ['cal-cell', otherMonth && 'other-month', isToday && 'today']
    .filter(Boolean).join(' ');

  let chips = dayTasks.slice(0, 3).map(t =>
    `<div class="cal-chip ${t.status==='done'?'done':''}" data-id="${t.id}"
         style="background:${taskColor(t)}"
         title="${escHtml(t.title)}">${escHtml(t.title)}</div>`
  ).join('');

  if (dayTasks.length > 3) {
    chips += `<div class="cal-more">+${dayTasks.length - 3} more</div>`;
  }

  return `<div class="${classes}" data-date="${dateStr}">
    <div class="cal-day-num">${dayNum}</div>
    <div class="cal-chips">${chips}</div>
  </div>`;
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
  const weekLabel = `${MONTHS[monday.getMonth()].slice(0,3)} ${monday.getDate()} – ${MONTHS[weekDates[6].getMonth()].slice(0,3)} ${weekDates[6].getDate()}, ${weekDates[6].getFullYear()}`;

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="wk-prev">‹</button>
      <span>${weekLabel}</span>
      <button class="btn-icon" id="wk-next">›</button>
    </div>`;

  document.getElementById('wk-prev').onclick = () => {
    state.cursor = new Date(monday); state.cursor.setDate(monday.getDate() - 7); renderWeekly();
  };
  document.getElementById('wk-next').onclick = () => {
    state.cursor = new Date(monday); state.cursor.setDate(monday.getDate() + 7); renderWeekly();
  };

  let html = '<div id="weekly-grid">';
  weekDates.forEach(date => {
    const dateStr = toDateStr(date);
    const isToday = dateStr === todayStr;
    const dayTasks = state.tasks.filter(t => t.date === dateStr);
    const cards = dayTasks.map(t => `
      <div class="week-task-card ${t.status==='done'?'done':''}" data-id="${t.id}"
           style="background:${taskColor(t)}">
        <div class="wt-title">${escHtml(t.title)}</div>
        ${t.assigned_to ? `<div class="wt-who">→ ${escHtml(t.assigned_to)}</div>` : ''}
      </div>`).join('');

    html += `<div class="week-col">
      <div class="week-col-header ${isToday?'today-col':''}">
        <span class="wd">${DAYS[(date.getDay())]}</span>
        <span class="dd">${date.getDate()}</span>
      </div>
      <div class="week-tasks" data-date="${dateStr}">${cards}</div>
      <button class="week-add-btn" data-date="${dateStr}">+ Add</button>
    </div>`;
  });
  html += '</div>';
  content.innerHTML = html;

  content.querySelectorAll('.week-task-card').forEach(card => {
    card.onclick = () => {
      const task = state.tasks.find(t => t.id == card.dataset.id);
      if (task) openTaskModal(task);
    };
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

  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="day-prev">‹</button>
      <span>${formatDateLong(state.cursor)}</span>
      <button class="btn-icon" id="day-next">›</button>
      <button class="btn btn-primary btn-sm" id="day-add">+ Add Task</button>
    </div>`;

  document.getElementById('day-prev').onclick = () => {
    state.cursor = new Date(state.cursor); state.cursor.setDate(state.cursor.getDate()-1); renderDaily();
  };
  document.getElementById('day-next').onclick = () => {
    state.cursor = new Date(state.cursor); state.cursor.setDate(state.cursor.getDate()+1); renderDaily();
  };
  document.getElementById('day-add').onclick = () => openTaskModal(null, dateStr);

  const dayTasks = state.tasks.filter(t => t.date === dateStr);

  let html = '<div id="daily-list">';
  if (dayTasks.length === 0) {
    html += `<div class="empty"><div class="empty-icon">🗓️</div><p>No tasks for this day. Click + Add Task to get started.</p></div>`;
  } else {
    dayTasks.forEach(t => {
      const done = t.status === 'done';
      html += `<div class="daily-task-row" data-id="${t.id}">
        <div class="priority-dot priority-${t.priority||'medium'}"></div>
        <input type="checkbox" class="status-cb" data-id="${t.id}" ${done?'checked':''} title="Toggle done" />
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
  renderGanttWeek();
}

function ganttToolbarNav(label, prevFn, nextFn) {
  const ctrl = document.getElementById('toolbar-controls');
  ctrl.innerHTML = `
    <div class="cal-nav">
      <button class="btn-icon" id="gnt-prev">‹</button>
      <span>${label}</span>
      <button class="btn-icon" id="gnt-next">›</button>
    </div>`;
  document.getElementById('gnt-prev').onclick = prevFn;
  document.getElementById('gnt-next').onclick = nextFn;
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

  // Compute effective dates for each project (explicit or derived from tasks)
  function projectEffectiveDates(p) {
    let start = p.start_date;
    let end   = p.end_date;
    if (!start || !end) {
      const pt = state.tasks.filter(t => t.project_id == p.id && t.date);
      if (pt.length === 0 && (!start && !end)) return null;
      if (!start) start = pt.reduce((m, t) => t.date < m ? t.date : m, pt[0]?.date || '');
      if (!end)   end   = pt.reduce((m, t) => { const te = t.end_date || t.date; return te > m ? te : m; }, pt[0]?.end_date || pt[0]?.date || '');
    }
    if (!start || !end) return null;
    if (start > rangeEnd || end < rangeStart) return null;
    return { effectiveStart: start, effectiveEnd: end };
  }

  const visibleProjects = state.projects
    .map(p => { const dates = projectEffectiveDates(p); return dates ? { ...p, ...dates } : null; })
    .filter(Boolean);

  if (visibleProjects.length === 0) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">📁</div><p>Geen projecten in dit bereik. Maak een project aan via <strong>Projecten</strong> en stel start/einddatum in.</p></div>`;
    return;
  }

  function dayOffset(fromStr, toStr) {
    return Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
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
  const todayOffDays = dayOffset(rangeStart, todayStr);
  const todayLine = (todayOffDays >= 0 && todayOffDays < totalDays)
    ? `<div class="gnt-today-line" style="left:${((todayOffDays + 0.5) / totalDays * 100).toFixed(2)}%"></div>`
    : '';

  const rowsHtml = visibleProjects.map(p => {
    const clampStart = p.effectiveStart < rangeStart ? rangeStart : p.effectiveStart;
    const clampEnd   = p.effectiveEnd   > rangeEnd   ? rangeEnd   : p.effectiveEnd;
    const startOff   = dayOffset(rangeStart, clampStart);
    const endOff     = dayOffset(rangeStart, clampEnd);
    const leftPct    = (startOff / totalDays * 100).toFixed(2);
    const widthPct   = ((endOff - startOff + 1) / totalDays * 100).toFixed(2);
    const done       = p.status === 'done';
    const taskCount  = state.tasks.filter(t => t.project_id == p.id).length;
    const doneCount  = state.tasks.filter(t => t.project_id == p.id && t.status === 'done').length;
    const pct        = taskCount ? Math.round(doneCount / taskCount * 100) : 0;

    return `<div class="gnt-row" data-proj-id="${p.id}">
      <div class="gnt-lbl">
        <div class="gnt-task-name${done?' done':''}">${escHtml(p.name)}</div>
        <div class="gnt-task-who">${doneCount}/${taskCount} taken · ${pct}%</div>
      </div>
      <div class="gnt-timeline">
        ${bgCells}
        ${todayLine}
        <div class="gnt-bar${done?' done':''}" data-proj-id="${p.id}"
             style="left:${leftPct}%;width:${widthPct}%;background:${p.color||'#4f8ef7'}"
             title="${escHtml(p.name)}">${escHtml(p.name)}</div>
      </div>
    </div>`;
  }).join('');

  content.innerHTML = `
    <div id="gantt-wrap">
      <div class="gnt-head">
        <div class="gnt-lbl-h"></div>
        <div class="gnt-timeline-h">${headerCells}</div>
      </div>
      ${rowsHtml}
    </div>`;

  content.querySelectorAll('.gnt-bar[data-proj-id], .gnt-row[data-proj-id]').forEach(el => {
    el.addEventListener('click', e => {
      if (el.classList.contains('gnt-bar')) e.stopPropagation();
      const proj = state.projects.find(p => p.id == el.dataset.projId);
      if (proj) openProjectModal(proj);
    });
  });
}

/* ─── Projects View ────────────────────────────────────────────────────────── */
function renderProjectsView() {
  const content = document.getElementById('content');
  const ctrl    = document.getElementById('toolbar-controls');

  ctrl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-proj-btn">+ Nieuw project</button>`;
  document.getElementById('new-proj-btn').onclick = () => openProjectModal(null);

  if (state.projects.length === 0) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">📁</div><p>Nog geen projecten. Maak een project aan om te beginnen.</p></div>`;
    return;
  }

  const html = `<div class="proj-grid">` +
    state.projects.map(p => {
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
      <input type="checkbox" class="status-cb" data-id="${t.id}" ${isDone ? 'checked' : ''} title="Toggle done" />
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
  buildProjColorSwatches(proj?.color || COLORS[0]);
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
      await api.dbQuery({ action: 'update', table: 'projects', data, where: { id: state.editingProject.id } });
    } else {
      await api.dbQuery({ action: 'insert', table: 'projects', data });
    }
    await loadProjects();
    closeProjectModal();
    renderView();
    toast('Project opgeslagen');
  };

  document.getElementById('proj-delete').onclick = async () => {
    if (!state.editingProject) return;
    if (!confirm(`Project "${state.editingProject.name}" verwijderen?`)) return;
    await api.dbQuery({ action: 'delete', table: 'projects', where: { id: state.editingProject.id } });
    // Unlink tasks from this project
    const linked = state.tasks.filter(t => t.project_id == state.editingProject.id);
    for (const t of linked) {
      await api.dbQuery({ action: 'update', table: 'tasks', data: { project_id: null }, where: { id: t.id } });
    }
    await Promise.all([loadProjects(), loadTasks()]);
    closeProjectModal();
    renderView();
    toast('Project verwijderd');
  };
}

function fmtProjStatus(s) {
  return { active: 'Actief', done: 'Afgerond', on_hold: 'On hold' }[s] || s;
}

/* ─── Todo Lists View ──────────────────────────────────────────────────────── */
function renderTodo() {
  const content = document.getElementById('content');
  const ctrl = document.getElementById('toolbar-controls');

  ctrl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-list-btn">+ New List</button>`;
  document.getElementById('new-list-btn').onclick = () => openListModal(null);

  if (state.todoLists.length === 0) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">✅</div><p>No lists yet. Create one to get started!</p></div>`;
    return;
  }

  let html = '<div id="todo-grid">';
  state.todoLists.forEach(list => {
    const items = state.todoItems[list.id] || [];
    const done = items.filter(i => i.completed).length;
    const pct = items.length ? Math.round((done/items.length)*100) : 0;

    const itemsHtml = items.map(item => `
      <div class="todo-item-row" data-item-id="${item.id}" data-list-id="${list.id}">
        <input type="checkbox" ${item.completed?'checked':''} class="todo-cb" data-item-id="${item.id}" data-list-id="${list.id}" />
        <span class="todo-item-text ${item.completed?'done':''}">${escHtml(item.text)}</span>
        <button class="todo-item-delete" data-item-id="${item.id}" data-list-id="${list.id}" title="Delete">✕</button>
      </div>`).join('');

    html += `<div class="todo-card" data-list-id="${list.id}">
      <div class="todo-card-header">
        <div class="todo-card-title">${escHtml(list.name)}</div>
        ${list.description ? `<div class="todo-card-desc">${escHtml(list.description)}</div>` : ''}
        <div class="todo-progress">
          <div class="todo-progress-bar" style="width:${pct}%"></div>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px">${done}/${items.length} done</div>
      </div>
      <div class="todo-items">${itemsHtml}</div>
      <form class="todo-add-item-form" data-list-id="${list.id}">
        <input type="text" placeholder="Add item…" class="add-item-input" autocomplete="off" />
        <button type="submit" class="btn btn-primary btn-sm">Add</button>
      </form>
      <div class="todo-card-actions">
        <button class="btn btn-ghost btn-sm edit-list-btn" data-list-id="${list.id}">Edit</button>
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
}

/* ─── Todo Operations ──────────────────────────────────────────────────────── */
async function addTodoItem(listId, text) {
  const data = { list_id: listId, text, created_by: state.config.name || '' };
  await api.dbQuery({ action: 'insert', table: 'todo_items', data });
  await loadTodoLists();
  renderTodo();
}

async function toggleTodoItem(listId, itemId, completed) {
  await api.dbQuery({ action: 'update', table: 'todo_items', data: { completed: completed ? 1 : 0 }, where: { id: itemId } });
  await loadTodoLists();
  renderTodo();
}

async function deleteTodoItem(listId, itemId) {
  await api.dbQuery({ action: 'delete', table: 'todo_items', where: { id: itemId } });
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

  const members = await api.dbQuery({ action: 'select', table: 'team_members' });
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

  document.getElementById('task-modal-title').textContent = isEdit ? 'Edit Task' : 'Add Task';
  document.getElementById('task-title').value    = task?.title || '';
  document.getElementById('task-desc').value     = task?.description || '';
  document.getElementById('task-date').value     = task?.date || defaultDate || toDateStr(state.cursor);
  document.getElementById('task-end-date').value = task?.end_date || '';
  openAssigneePicker(task?.assigned_to ?? state.config.name ?? '');
  document.getElementById('task-status').value = task?.status || 'pending';
  document.getElementById('task-priority').value = task?.priority || 'medium';
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

  document.getElementById('task-modal').classList.remove('hidden');
  document.getElementById('task-title').focus();
  maybeShowCalDavCheckbox(task);
}

function closeTaskModal() {
  document.getElementById('task-modal').classList.add('hidden');
  state.editingTask = null;
}

async function saveTask(taskData) {
  if (state.config.mode === 'file') {
    if (taskData.id) {
      const { id, created_at, ...data } = taskData;
      await api.dbQuery({ action: 'update', table: 'tasks', data, where: { id: taskData.id } });
    } else {
      await api.dbQuery({ action: 'insert', table: 'tasks', data: taskData });
    }
  } else {
    if (taskData.id) {
      await api.apiFetch({ method: 'PUT', url: `${state.config.apiUrl}/api/tasks/${taskData.id}`, body: taskData });
    } else {
      await api.apiFetch({ method: 'POST', url: `${state.config.apiUrl}/api/tasks`, body: taskData });
    }
  }
}

function wireTaskModal() {
  document.getElementById('task-cancel').onclick = closeTaskModal;
  // Show/hide calendar checkbox when date changes
  document.getElementById('task-date').addEventListener('change', () => maybeShowCalDavCheckbox(state.editingTask));

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
      assigned_to: pickerAssignees.join(', '),
      project_id:  projVal ? parseInt(projVal) : null,
      status:      document.getElementById('task-status').value,
      priority:    document.getElementById('task-priority').value,
      color,
      created_by:  state.config.name || '',
      ...(state.editingTask ? { id: state.editingTask.id, created_at: state.editingTask.created_at } : {}),
    };

    await saveTask(taskData);
    // Reload to get the persisted ID (needed for CalDAV push)
    await loadTasks();
    // Find saved task (by title + date — good enough after just saving)
    const saved = state.tasks.find(t =>
      t.title === taskData.title && t.date === taskData.date &&
      (taskData.id ? t.id === taskData.id : true)
    );
    closeTaskModal();
    if (state.activeProject) {
      renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
    } else {
      renderView();
    }
    toast('Task saved');
    if (saved) await maybePushTaskToCalDav(saved);
  };

  document.getElementById('task-delete').onclick = async () => {
    if (!state.editingTask) return;
    if (!confirm('Delete this task?')) return;
    await api.dbQuery({ action: 'delete', table: 'tasks', where: { id: state.editingTask.id } });
    await loadTasks();
    closeTaskModal();
    if (state.activeProject) {
      renderProjectDetail(state.projects.find(p => p.id === state.activeProject.id) || state.activeProject);
    } else {
      renderView();
    }
    toast('Task deleted');
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
  document.getElementById('list-modal-title').textContent = isEdit ? 'Edit List' : 'New List';
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
      await api.dbQuery({ action: 'update', table: 'todo_lists', data, where: { id: state.editingList.id } });
    } else {
      await api.dbQuery({ action: 'insert', table: 'todo_lists', data });
    }
    await loadTodoLists();
    closeListModal();
    renderTodo();
    toast('List saved');
  };

  document.getElementById('list-delete').onclick = async () => {
    if (!state.editingList) return;
    if (!confirm('Delete this list and all its items?')) return;
    await api.dbQuery({ action: 'delete', table: 'todo_lists', where: { id: state.editingList.id } });
    await loadTodoLists();
    closeListModal();
    renderTodo();
    toast('List deleted');
  };

  document.getElementById('list-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('list-modal')) closeListModal();
  });
}

/* ─── Settings Modal ───────────────────────────────────────────────────────── */
function wireSettings() {
  let tempFilePath = null;

  document.getElementById('settings-btn').onclick = async () => {
    const cfg = state.config || {};
    document.getElementById('cfg-name').value = cfg.name || '';
    document.getElementById('cfg-api-url').value = cfg.apiUrl || 'http://raspberrypi.local:5000';
    const mode = cfg.mode || 'file';
    document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
    tempFilePath = cfg.filePath || null;
    updateCfgPathDisplay(tempFilePath);
    toggleModeFields(mode);
    updateRadioCards(mode);
    document.getElementById('settings-modal').classList.remove('hidden');
  };

  document.getElementById('settings-cancel').onclick = () =>
    document.getElementById('settings-modal').classList.add('hidden');

  document.getElementById('cfg-pick-folder').onclick = async () => {
    const folder = await api.openFolder();
    if (folder) {
      tempFilePath = folder + '/project-manager.db';
      updateCfgPathDisplay(tempFilePath);
    }
  };

  document.querySelectorAll('input[name=mode]').forEach(radio => {
    radio.addEventListener('change', () => {
      toggleModeFields(radio.value);
      updateRadioCards(radio.value);
    });
  });

  document.getElementById('settings-save').onclick = async () => {
    const mode = document.querySelector('input[name=mode]:checked').value;
    const newConfig = {
      name: document.getElementById('cfg-name').value.trim() || state.config?.name || '',
      mode,
      filePath: tempFilePath || state.config?.filePath || '',
      apiUrl: document.getElementById('cfg-api-url').value.trim(),
    };
    await api.configSet(newConfig);
    state.config = newConfig;
    document.getElementById('sidebar-user').textContent = newConfig.name;
    document.getElementById('settings-modal').classList.add('hidden');
    await loadAll();
    renderView();
    toast('Settings saved');
  };

  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-modal'))
      document.getElementById('settings-modal').classList.add('hidden');
  });

  function updateCfgPathDisplay(p) {
    document.getElementById('cfg-path-display').textContent = p || 'Not set';
  }

  function toggleModeFields(mode) {
    document.getElementById('cfg-file-section').classList.toggle('hidden', mode !== 'file');
    document.getElementById('cfg-api-section').classList.toggle('hidden', mode !== 'api');
  }

  function updateRadioCards(mode) {
    document.getElementById('radio-file').classList.toggle('selected', mode === 'file');
    document.getElementById('radio-api').classList.toggle('selected', mode === 'api');
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
    if (!wizardFilePath) { toast('Please select a folder first'); return; }
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
      setView(btn.dataset.view);
    });
  });

  document.getElementById('refresh-btn').onclick = async () => {
    await api.refresh();
    await loadAll();
    renderView();
    toast('Refreshed');
  };
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
function taskColor(task) {
  if (task.project_id) {
    const proj = state.projects.find(p => p.id == task.project_id);
    if (proj?.color) return proj.color;
  }
  return task.color || '#4f8ef7';
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtStatus(s) {
  return { pending: 'Pending', in_progress: 'In Progress', done: 'Done' }[s] || s;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function toast(msg, ms = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

function shake(el) {
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.borderColor = 'var(--red)';
  setTimeout(() => { el.style.borderColor = ''; }, 1000);
}

/* ─── Quote Presets ─────────────────────────────────────────────────────────── */
const PRESET_MATERIALS = [
  { name: 'Polyurea',     unit: 'm²',  price: 0 },
  { name: 'Spuiten',      unit: 'm²',  price: 0 },
  { name: 'Grafisch',     unit: 'm²',  price: 0 },
  { name: 'Stickeren',    unit: 'm²',  price: 0 },
  { name: 'Underlayment', unit: 'vel', price: 60 },
  { name: 'Hout',         unit: 'm²',  price: 0 },
  { name: 'Staal',        unit: 'kg',  price: 0 },
  { name: 'Filament',     unit: 'g',   price: 0 },
  { name: 'Epoxy',        unit: 'kg',  price: 0 },
  { name: 'Transport',    unit: 'rit', price: 0 },
  { name: 'Overig',       unit: 'st',  price: 0 },
];

const PRESET_SERVICES = [
  { name: 'Tekenen',     rate: 70 },
  { name: '3D frezen',   rate: 120 },
  { name: 'CNC frezen',  rate: 120 },
  { name: 'Werkplaats',  rate: 70 },
  { name: 'Coördinatie', rate: 70 },
  { name: 'Handling',    rate: 55 },
];

// ─── Quote State ──────────────────────────────────────────────────────────────

// qe = quoteEditor live state (in-memory while editing)
let qe = null;

function freshQE(quote) {
  return {
    id:         quote?.id         ?? null,
    name:       quote?.name       ?? '',
    client:     quote?.client     ?? '',
    quote_date: quote?.quote_date ?? toDateStr(new Date()),
    margin:     quote?.margin     ?? 20,
    status:     quote?.status     ?? 'draft',
    notes:      quote?.notes      ?? '',
    materials:  [],
    services:   [],
  };
}

// ─── Quote List View ──────────────────────────────────────────────────────────

async function renderQuoteList() {
  const ctrl = document.getElementById('toolbar-controls');
  ctrl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-quote-btn">+ Nieuwe offerte</button>`;
  document.getElementById('new-quote-btn').onclick = () => openQuoteEditor(null);

  const quotes = await api.dbQuery({ action: 'select', table: 'quotes' });

  if (quotes.length === 0) {
    document.getElementById('content').innerHTML =
      `<div class="empty"><div class="empty-icon">💶</div><p>Nog geen offertes. Klik op "+ Nieuwe offerte" om te beginnen.</p></div>`;
    return;
  }

  // Calculate total for each quote (load items)
  const rows = await Promise.all(quotes.map(async q => {
    const items = await api.dbQuery({ action: 'select', table: 'quote_items', where: { quote_id: q.id } });
    const t = calcQuoteTotals(items, q.margin);
    return { q, total: t.grandTotal };
  }));

  let html = `<table class="quotes-table">
    <thead><tr>
      <th>Project</th><th>Klant</th><th>Datum</th>
      <th style="text-align:right">Totaal incl. BTW</th><th>Status</th>
    </tr></thead><tbody>`;

  rows.forEach(({ q, total }) => {
    html += `<tr class="quote-row" data-id="${q.id}">
      <td><strong>${escHtml(q.name)}</strong></td>
      <td>${escHtml(q.client)}</td>
      <td>${q.quote_date || '—'}</td>
      <td class="amount">${fmtEur(total)}</td>
      <td><span class="badge badge-${q.status}">${fmtQuoteStatus(q.status)}</span></td>
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
}

// ─── Quote Editor ─────────────────────────────────────────────────────────────

async function openQuoteEditor(quote) {
  qe = freshQE(quote);

  // Load existing items if editing
  if (qe.id) {
    const items = await api.dbQuery({ action: 'select', table: 'quote_items', where: { quote_id: qe.id } });
    qe.materials = items.filter(i => i.type === 'material').map(i => ({ ...i }));
    qe.services  = items.filter(i => i.type === 'service').map(i => ({ ...i }));
  }

  renderQuoteEditorView();
}

function renderQuoteEditorView() {
  const ctrl = document.getElementById('toolbar-controls');
  ctrl.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="qe-back">← Offertes</button>
    <button class="btn btn-secondary btn-sm" id="qe-delete-btn" ${!qe.id ? 'style="display:none"' : ''}>Verwijder</button>
    <button class="btn btn-primary btn-sm" id="qe-save-btn">Opslaan</button>
    <button class="btn btn-secondary btn-sm" id="qe-pdf-btn">📄 PDF exporteren</button>`;

  document.getElementById('toolbar-title').textContent = qe.name || 'Nieuwe offerte';
  document.getElementById('qe-back').onclick = () => { qe = null; setView('quotes'); };
  document.getElementById('qe-save-btn').onclick = saveQuote;
  document.getElementById('qe-pdf-btn').onclick = exportQuotePdf;
  document.getElementById('qe-delete-btn')?.addEventListener('click', deleteQuote);

  const content = document.getElementById('content');
  content.innerHTML = `
    <!-- Top fields -->
    <div class="qe-topbar">
      <div class="qe-fields">
        <input class="qi-input qe-name"   id="qe-name"   value="${escHtml(qe.name)}"       placeholder="Projectnaam *" />
        <input class="qi-input qe-client" id="qe-client" value="${escHtml(qe.client)}"     placeholder="Klantnaam" />
        <input class="qi-input qe-date"   id="qe-date"   type="date" value="${qe.quote_date}" />
        <select class="qi-input qe-status" id="qe-status">
          <option value="draft"    ${qe.status==='draft'    ?'selected':''}>Concept</option>
          <option value="sent"     ${qe.status==='sent'     ?'selected':''}>Verzonden</option>
          <option value="accepted" ${qe.status==='accepted' ?'selected':''}>Geaccepteerd</option>
          <option value="rejected" ${qe.status==='rejected' ?'selected':''}>Afgewezen</option>
        </select>
      </div>
    </div>
    <textarea class="qe-notes" id="qe-notes" placeholder="Notities / omschrijving…">${escHtml(qe.notes)}</textarea>

    <!-- Materials -->
    <div class="qe-section">
      <div class="qe-section-header">
        <span class="qe-section-title">Materialen</span>
        <div class="qe-margin-ctrl">
          Marge <input type="number" id="qe-margin" value="${qe.margin}" min="0" max="200" step="1" />%
        </div>
      </div>
      <div class="preset-btns" id="mat-presets"></div>
      <table class="qi-table">
        <thead><tr>
          <th style="width:36%">Omschrijving</th>
          <th style="width:10%">Aantal</th>
          <th style="width:10%">Eenheid</th>
          <th class="num" style="width:16%">Stukprijs</th>
          <th class="num" style="width:16%">Totaal</th>
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
      </div>
      <div class="preset-btns" id="svc-presets"></div>
      <table class="qi-table">
        <thead><tr>
          <th style="width:40%">Dienst</th>
          <th style="width:14%">Uren</th>
          <th class="num" style="width:18%">Tarief/uur</th>
          <th class="num" style="width:20%">Totaal</th>
          <th style="width:4%"></th>
        </tr></thead>
        <tbody id="svc-tbody"></tbody>
      </table>
      <div style="height:4px"></div>
    </div>

    <!-- Totals -->
    <div class="qe-totals-panel" id="qe-totals-panel"></div>
  `;

  // Build preset buttons
  const matPresets = document.getElementById('mat-presets');
  PRESET_MATERIALS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.innerHTML = `${escHtml(p.name)}${p.price ? ` <span class="rate">€${p.price}</span>` : ''}`;
    btn.onclick = () => { qe.materials.push({ name: p.name, quantity: 1, unit: p.unit, unit_price: p.price }); renderMatTable(); updateTotals(); };
    matPresets.appendChild(btn);
  });

  const svcPresets = document.getElementById('svc-presets');
  PRESET_SERVICES.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.innerHTML = `${escHtml(p.name)} <span class="rate">€${p.rate}/u</span>`;
    btn.onclick = () => { qe.services.push({ name: p.name, quantity: 1, unit: 'uur', unit_price: p.rate }); renderSvcTable(); updateTotals(); };
    svcPresets.appendChild(btn);
  });

  // Wire live-field changes (header fields)
  document.getElementById('qe-name').addEventListener('input',   e => { qe.name = e.target.value; document.getElementById('toolbar-title').textContent = qe.name || 'Nieuwe offerte'; });
  document.getElementById('qe-client').addEventListener('input',  e => qe.client = e.target.value);
  document.getElementById('qe-date').addEventListener('change',   e => qe.quote_date = e.target.value);
  document.getElementById('qe-status').addEventListener('change', e => qe.status = e.target.value);
  document.getElementById('qe-notes').addEventListener('input',   e => qe.notes = e.target.value);
  document.getElementById('qe-margin').addEventListener('input',  e => { qe.margin = parseFloat(e.target.value) || 0; updateTotals(); });

  renderMatTable();
  renderSvcTable();
  updateTotals();
}

// ─── Render sub-tables ────────────────────────────────────────────────────────

function renderMatTable() {
  const tbody = document.getElementById('mat-tbody');
  if (!tbody) return;

  tbody.innerHTML = qe.materials.map((m, i) => `
    <tr data-idx="${i}">
      <td><input class="qi-input" data-t="mat" data-i="${i}" data-f="name"       value="${escHtml(m.name)}"       placeholder="Omschrijving" /></td>
      <td><input class="qi-input num" data-t="mat" data-i="${i}" data-f="quantity"  value="${m.quantity}"  type="number" min="0" step="any" /></td>
      <td><input class="qi-input" data-t="mat" data-i="${i}" data-f="unit"       value="${escHtml(m.unit)}"  placeholder="m²" /></td>
      <td><input class="qi-input num" data-t="mat" data-i="${i}" data-f="unit_price" value="${m.unit_price}" type="number" min="0" step="any" /></td>
      <td class="num" id="mat-row-total-${i}">${fmtEur(m.quantity * m.unit_price)}</td>
      <td><button class="qi-del" data-t="mat" data-i="${i}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="6" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik een materiaal hierboven om toe te voegen</td></tr>`;

  wireTableInputs('mat');
  updateMatSubtotals();
}

function renderSvcTable() {
  const tbody = document.getElementById('svc-tbody');
  if (!tbody) return;

  tbody.innerHTML = qe.services.map((s, i) => `
    <tr data-idx="${i}">
      <td><input class="qi-input" data-t="svc" data-i="${i}" data-f="name"       value="${escHtml(s.name)}"      placeholder="Dienst" /></td>
      <td><input class="qi-input num" data-t="svc" data-i="${i}" data-f="quantity"  value="${s.quantity}" type="number" min="0" step="0.5" /></td>
      <td class="num"><input class="qi-input num" data-t="svc" data-i="${i}" data-f="unit_price" value="${s.unit_price}" type="number" min="0" step="any" /></td>
      <td class="num" id="svc-row-total-${i}">${fmtEur(s.quantity * s.unit_price)}</td>
      <td><button class="qi-del" data-t="svc" data-i="${i}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="5" style="padding:12px;text-align:center;color:var(--text2);font-size:12px">Klik een dienst hierboven om toe te voegen</td></tr>`;

  wireTableInputs('svc');
}

function wireTableInputs(type) {
  const tbody = document.getElementById(type === 'mat' ? 'mat-tbody' : 'svc-tbody');
  if (!tbody) return;

  tbody.querySelectorAll('.qi-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.i);
      const field = inp.dataset.f;
      const arr = type === 'mat' ? qe.materials : qe.services;
      if (!arr[i]) return;
      arr[i][field] = (field === 'name' || field === 'unit') ? inp.value : (parseFloat(inp.value) || 0);
      // Update just the row total cell
      const rowTotal = document.getElementById(`${type}-row-total-${i}`);
      if (rowTotal) rowTotal.textContent = fmtEur(arr[i].quantity * arr[i].unit_price);
      if (type === 'mat') updateMatSubtotals();
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

// ─── Calculations ─────────────────────────────────────────────────────────────

function calcQuoteTotals(items, margin) {
  const matItems = items.filter(i => i.type === 'material');
  const svcItems = items.filter(i => i.type === 'service');
  const marginPct = parseFloat(margin) || 20;

  const matEx      = matItems.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const matMargin  = matEx * (marginPct / 100);
  const matTotal   = matEx + matMargin;
  const svcTotal   = svcItems.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const subtotal   = matTotal + svcTotal;
  const btw        = subtotal * 0.21;
  const grandTotal = subtotal + btw;
  return { matEx, matMargin, matTotal, svcTotal, subtotal, btw, grandTotal, marginPct };
}

function calcQETotals() {
  const allItems = [
    ...qe.materials.map(i => ({ ...i, type: 'material' })),
    ...qe.services.map(i => ({ ...i, type: 'service' })),
  ];
  return calcQuoteTotals(allItems, qe.margin);
}

function updateMatSubtotals() {
  const el = document.getElementById('mat-subtotals');
  if (!el || !qe) return;
  const t = calcQETotals();
  el.innerHTML = `
    <div class="row"><span>Subtotaal materialen</span><span>${fmtEur(t.matEx)}</span></div>
    <div class="row"><span>Marge (${t.marginPct}%)</span><span>+ ${fmtEur(t.matMargin)}</span></div>
    <div class="row bold"><span>Totaal materialen</span><span>${fmtEur(t.matTotal)}</span></div>`;
}

function updateTotals() {
  updateMatSubtotals();
  const el = document.getElementById('qe-totals-panel');
  if (!el || !qe) return;
  const t = calcQETotals();
  el.innerHTML = `
    <div class="qt-row"><span class="qt-label">Materialen (excl. marge)</span><span class="qt-val">${fmtEur(t.matEx)}</span></div>
    <div class="qt-row"><span class="qt-label">Marge (${t.marginPct}%)</span><span class="qt-val">+ ${fmtEur(t.matMargin)}</span></div>
    <div class="qt-row"><span class="qt-label">Totaal materialen</span><span class="qt-val">${fmtEur(t.matTotal)}</span></div>
    <div class="qt-row"><span class="qt-label">Totaal diensten</span><span class="qt-val">${fmtEur(t.svcTotal)}</span></div>
    <div class="qt-divider"></div>
    <div class="qt-row subtotal"><span class="qt-label">Subtotaal excl. BTW</span><span class="qt-val">${fmtEur(t.subtotal)}</span></div>
    <div class="qt-row"><span class="qt-label">BTW (21%)</span><span class="qt-val">+ ${fmtEur(t.btw)}</span></div>
    <div class="qt-divider"></div>
    <div class="qt-row final"><span class="qt-label">TOTAAL incl. BTW</span><span class="qt-val">${fmtEur(t.grandTotal)}</span></div>`;
}

// ─── Save / Delete Quote ──────────────────────────────────────────────────────

async function saveQuote() {
  if (!qe.name.trim()) { shake(document.getElementById('qe-name')); toast('Vul een projectnaam in'); return; }

  const quoteData = {
    name: qe.name.trim(), client: qe.client.trim(), quote_date: qe.quote_date,
    margin: qe.margin, status: qe.status, notes: qe.notes.trim(),
    created_by: state.config?.name || '',
  };

  let quoteId = qe.id;
  if (quoteId) {
    await api.dbQuery({ action: 'update', table: 'quotes', data: quoteData, where: { id: quoteId } });
    await api.dbQuery({ action: 'delete', table: 'quote_items', where: { quote_id: quoteId } });
  } else {
    const res = await api.dbQuery({ action: 'insert', table: 'quotes', data: quoteData });
    quoteId = res.id;
    qe.id = quoteId;
  }

  const allItems = [
    ...qe.materials.map((m, i) => ({ quote_id: quoteId, type: 'material', name: m.name, quantity: m.quantity, unit: m.unit, unit_price: m.unit_price, sort_order: i })),
    ...qe.services.map((s, i)  => ({ quote_id: quoteId, type: 'service',  name: s.name, quantity: s.quantity, unit: 'uur', unit_price: s.unit_price,  sort_order: i })),
  ];
  for (const item of allItems) {
    await api.dbQuery({ action: 'insert', table: 'quote_items', data: item });
  }

  // Reload to get server-generated ids on items
  const saved = await api.dbQuery({ action: 'select', table: 'quotes', where: { id: quoteId } });
  if (saved[0]) { qe.id = saved[0].id; }

  // Show delete button now that it's saved
  const delBtn = document.getElementById('qe-delete-btn');
  if (delBtn) delBtn.style.display = '';

  toast('Offerte opgeslagen');
}

async function deleteQuote() {
  if (!qe.id) return;
  if (!confirm(`Offerte "${qe.name}" verwijderen?`)) return;
  await api.dbQuery({ action: 'delete', table: 'quotes', where: { id: qe.id } });
  qe = null;
  toast('Offerte verwijderd');
  setView('quotes');
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

async function exportQuotePdf() {
  if (!qe.id) {
    await saveQuote();
    if (!qe.id) return;
  }

  const logoDataUrl = await api.getLogoDataUrl();
  const t = calcQETotals();
  const quoteNum = `Q-${String(qe.id).padStart(4, '0')}`;
  const dateFmt = qe.quote_date
    ? new Date(qe.quote_date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const matRows = qe.materials.map(m => `
    <tr>
      <td>${escHtml(m.name)}</td>
      <td style="text-align:right">${m.quantity}</td>
      <td>${escHtml(m.unit)}</td>
      <td style="text-align:right">${fmtEur(m.unit_price)}</td>
      <td style="text-align:right">${fmtEur(m.quantity * m.unit_price)}</td>
    </tr>`).join('');

  const svcRows = qe.services.map(s => `
    <tr>
      <td>${escHtml(s.name)}</td>
      <td style="text-align:right">${s.quantity}</td>
      <td style="text-align:right">${fmtEur(s.unit_price)}/u</td>
      <td style="text-align:right">${fmtEur(s.quantity * s.unit_price)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a2e; font-size: 12px; padding: 48px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
  .logo-area img { max-height: 72px; max-width: 220px; }
  .logo-area .company-name { font-size: 22px; font-weight: 700; color: #4f8ef7; }
  .quote-meta { text-align: right; line-height: 1.8; }
  .quote-meta .title { font-size: 26px; font-weight: 700; color: #1a1a2e; letter-spacing: 1px; }
  .quote-meta .num { font-size: 14px; color: #4f8ef7; font-weight: 600; }
  .client-block { background: #f5f7ff; border-left: 4px solid #4f8ef7; padding: 12px 16px; margin-bottom: 32px; border-radius: 0 6px 6px 0; }
  .client-block .label { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: #888; }
  .client-block .val { font-size: 14px; font-weight: 600; margin-top: 2px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #4f8ef7; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f0f4ff; padding: 7px 10px; text-align: left; font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: .4px; }
  td { padding: 7px 10px; border-bottom: 1px solid #eee; }
  .subtotals { margin-top: 6px; }
  .subtotals tr td { border: none; padding: 3px 10px; color: #555; }
  .subtotals tr.bold td { font-weight: 600; color: #1a1a2e; }
  .totals-box { margin-top: 28px; border: 2px solid #4f8ef7; border-radius: 8px; overflow: hidden; }
  .totals-box table { margin: 0; }
  .totals-box th { background: #4f8ef7; color: #fff; letter-spacing: .5px; }
  .totals-box td { padding: 8px 14px; }
  .totals-box .row-final td { font-size: 15px; font-weight: 700; background: #f0f4ff; color: #1a1a2e; }
  .totals-box .row-btw td { color: #555; }
  .notes { margin-top: 32px; padding: 12px 14px; background: #fafafa; border: 1px solid #eee; border-radius: 6px; }
  .notes .label { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: #888; margin-bottom: 6px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; font-size: 10px; color: #aaa; text-align: center; }
</style>
</head><body>

<div class="header">
  <div class="logo-area">
    ${logoDataUrl ? `<img src="${logoDataUrl}" alt="Logo" />` : `<div class="company-name">Vonk &amp; Vorm</div>`}
  </div>
  <div class="quote-meta">
    <div class="title">OFFERTE</div>
    <div class="num">${quoteNum}</div>
    <div style="color:#888;margin-top:4px">${dateFmt}</div>
  </div>
</div>

<div class="client-block">
  <div class="label">Klant &amp; Project</div>
  <div class="val">${escHtml(qe.client || '—')}</div>
  <div style="margin-top:2px;color:#555">${escHtml(qe.name)}</div>
</div>

${qe.materials.length > 0 ? `
<h3>Materialen</h3>
<table>
  <thead><tr><th>Omschrijving</th><th style="text-align:right">Aantal</th><th>Eenheid</th><th style="text-align:right">Stukprijs</th><th style="text-align:right">Totaal</th></tr></thead>
  <tbody>${matRows}</tbody>
</table>
<table class="subtotals">
  <tr><td colspan="4">Subtotaal materialen</td><td style="text-align:right">${fmtEur(t.matEx)}</td></tr>
  <tr><td colspan="4">Marge (${t.marginPct}%)</td><td style="text-align:right">+ ${fmtEur(t.matMargin)}</td></tr>
  <tr class="bold"><td colspan="4">Totaal materialen</td><td style="text-align:right">${fmtEur(t.matTotal)}</td></tr>
</table>` : ''}

${qe.services.length > 0 ? `
<h3>Diensten</h3>
<table>
  <thead><tr><th>Dienst</th><th style="text-align:right">Uren</th><th style="text-align:right">Tarief/uur</th><th style="text-align:right">Totaal</th></tr></thead>
  <tbody>${svcRows}</tbody>
</table>` : ''}

<div class="totals-box">
  <table>
    <thead><tr><th colspan="2">Totaaloverzicht</th></tr></thead>
    <tbody>
      ${qe.materials.length > 0 ? `<tr><td>Totaal materialen (incl. marge)</td><td style="text-align:right">${fmtEur(t.matTotal)}</td></tr>` : ''}
      ${qe.services.length > 0  ? `<tr><td>Totaal diensten</td><td style="text-align:right">${fmtEur(t.svcTotal)}</td></tr>` : ''}
      <tr><td>Subtotaal excl. BTW</td><td style="text-align:right">${fmtEur(t.subtotal)}</td></tr>
      <tr class="row-btw"><td>BTW (21%)</td><td style="text-align:right">+ ${fmtEur(t.btw)}</td></tr>
      <tr class="row-final"><td>TOTAAL incl. BTW</td><td style="text-align:right">${fmtEur(t.grandTotal)}</td></tr>
    </tbody>
  </table>
</div>

${qe.notes ? `<div class="notes"><div class="label">Notities</div><div>${escHtml(qe.notes)}</div></div>` : ''}

<div class="footer">Offerte ${quoteNum} · ${dateFmt} · Vonk &amp; Vorm</div>

</body></html>`;

  await api.exportPdf(html, `${quoteNum}-${(qe.name || 'offerte').replace(/[^a-z0-9]/gi, '-')}.pdf`);
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
  const members = await api.dbQuery({ action: 'select', table: 'team_members' });
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
        await api.dbQuery({ action: 'delete', table: 'team_members', where: { id: btn.dataset.id } });
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

  const members = await api.dbQuery({ action: 'select', table: 'team_members' });
  const color = MEMBER_COLORS[members.length % MEMBER_COLORS.length];

  await api.dbQuery({ action: 'insert', table: 'team_members', data: {
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

// ── Settings panel wiring ─────────────────────────────────────────────────────
async function wireCalDavSettings() {
  // Populate fields when settings open
  const origSettingsBtn = document.getElementById('settings-btn');
  const originalSettingsBtnClick = origSettingsBtn.onclick;

  // Patch settings open to also populate CalDAV fields
  const origOpen = document.getElementById('settings-btn').onclick;
  let caldavHasPassword = false;
  document.getElementById('settings-btn').onclick = async function (...args) {
    if (origOpen) origOpen.apply(this, args);
    const cfg = await api.caldavGetConfig();
    caldavHasPassword = cfg.hasPassword;
    document.getElementById('cfg-caldav-enabled').checked     = cfg.enabled;
    document.getElementById('cfg-caldav-host').value          = cfg.serverHost || 'dav.webmail.strato.de';
    document.getElementById('cfg-caldav-user').value          = cfg.username;
    document.getElementById('cfg-caldav-pass').value          = '';  // never pre-fill password
    document.getElementById('cfg-caldav-push-default').checked = cfg.pushByDefault;
    if (cfg.enabled && cfg.hasPassword) {
      setCalDavStatus('Geconfigureerd ✓', 'ok');
    } else {
      setCalDavStatus('', '');
    }
  };

  // Test connection button
  document.getElementById('cfg-caldav-test').onclick = async () => {
    const host = document.getElementById('cfg-caldav-host').value.trim();
    const user = document.getElementById('cfg-caldav-user').value.trim();
    const pass = document.getElementById('cfg-caldav-pass').value;
    // Allow empty password if one is already stored in keychain
    if (!host || !user || (!pass && !caldavHasPassword)) { setCalDavStatus('Vul server, gebruikersnaam en wachtwoord in', 'error'); return; }
    setCalDavStatus('Verbinding testen…', 'syncing');
    const result = await api.caldavTest({ serverHost: host, username: user, password: pass });
    if (result.ok) {
      setCalDavStatus(`✓ Verbonden — kalender: ${result.calendarUrl}`, 'ok');
      caldavHasPassword = true;
      // Auto-save credentials so they persist across sessions
      await api.caldavSaveConfig({
        enabled:       document.getElementById('cfg-caldav-enabled').checked,
        serverHost:    host,
        username:      user,
        password:      pass || undefined,
        pushByDefault: document.getElementById('cfg-caldav-push-default').checked,
      });
    } else {
      setCalDavStatus(`✕ ${result.error}`, 'error');
    }
  };

  // Manual sync button
  document.getElementById('cfg-caldav-sync-now').onclick = async () => {
    setCalDavStatus('Synchroniseren…', 'syncing');
    const result = await api.caldavSyncNow();
    if (result.error) {
      setCalDavStatus(`✕ ${result.error}`, 'error');
    } else {
      setCalDavStatus('✓ Gesynchroniseerd', 'ok');
      await loadAll();
      renderView();
    }
  };

  // Patch the settings-save button to also save CalDAV config
  const origSaveClick = document.getElementById('settings-save').onclick;
  document.getElementById('settings-save').onclick = async function (...args) {
    // Only save CalDAV config if the username field is filled in.
    // Skipping when empty preserves any existing stored credentials
    // (password is never pre-filled for security, so an empty form
    // would otherwise wipe the stored credentials on every save).
    const user = document.getElementById('cfg-caldav-user').value.trim();
    if (user) {
      const enabled       = document.getElementById('cfg-caldav-enabled').checked;
      const serverHost    = document.getElementById('cfg-caldav-host').value.trim() || 'dav.webmail.strato.de';
      const password      = document.getElementById('cfg-caldav-pass').value || undefined;
      const pushByDefault = document.getElementById('cfg-caldav-push-default').checked;
      await api.caldavSaveConfig({ enabled, serverHost, username: user, password, pushByDefault });
    }
    // Run original settings save
    if (origSaveClick) origSaveClick.apply(this, args);
  };
}

function setCalDavStatus(msg, type) {
  const el = document.getElementById('cfg-caldav-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : type === 'ok' ? 'var(--green)' : 'var(--text2)';
}

// ── Sync status pill (sidebar) ────────────────────────────────────────────────

function updateSyncPill(text, type) {
  const pill = document.getElementById('sync-status-pill');
  if (!pill) return;
  pill.textContent = text;
  pill.className = type;
  pill.classList.remove('hidden');
}

function initCalDavListeners() {
  api.onCalDavSynced(async ({ time, imported }) => {
    const t = new Date(time).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    updateSyncPill(`☁ ${t}`, 'ok');
    if (imported > 0) {
      await loadAll();
      renderView();
      toast(`${imported} agenda-item${imported !== 1 ? 's' : ''} gesynchroniseerd`);
    }
  });
  api.onCalDavError((msg) => {
    updateSyncPill('☁ sync fout', 'error');
  });
}

// ── Task modal — calendar push checkbox ────────────────────────────────────────

async function maybeShowCalDavCheckbox(task) {
  const group = document.getElementById('task-caldav-group');
  const cb    = document.getElementById('task-caldav-push');
  if (!group || !cb) return;

  const cfg = await api.caldavGetConfig();
  const dateVal = document.getElementById('task-date').value;

  if (cfg.enabled && dateVal) {
    group.classList.remove('hidden');
    // Pre-check: default on if setting says so, or if task is already in calendar
    cb.checked = task?.caldav_uid ? true : cfg.pushByDefault;
  } else {
    group.classList.add('hidden');
    cb.checked = false;
  }
}

// ── Push task to CalDAV after save ────────────────────────────────────────────

async function maybePushTaskToCalDav(savedTask) {
  const cb = document.getElementById('task-caldav-push');
  if (!cb?.checked) return;

  updateSyncPill('☁ pushen…', 'syncing');
  const result = await api.caldavPushTask(savedTask);
  if (result.ok) {
    updateSyncPill('☁ gepusht ✓', 'ok');
    setTimeout(() => {
      const pill = document.getElementById('sync-status-pill');
      if (pill) pill.classList.add('hidden');
    }, 4000);
  } else {
    updateSyncPill('☁ push fout', 'error');
    toast(`Kalender push mislukt: ${result.error}`);
  }
}

/* ─── Boot ─────────────────────────────────────────────────────────────────── */
init().catch(console.error);
