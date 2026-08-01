'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function openDatabase(filePath) {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(filePath);
  // WAL mode is preferred (faster, safer for synced folders on macOS/Linux).
  // On Windows, WAL requires shared-memory files that Google Drive may lock —
  // fall back to DELETE mode if WAL cannot be set.
  try {
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal') db.pragma('journal_mode = DELETE');
  } catch (_) {
    db.pragma('journal_mode = DELETE');
  }
  db.pragma('foreign_keys = ON');
  createSchema();
  migrateSchema();
  return db;
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      date        TEXT,
      created_by  TEXT DEFAULT '',
      assigned_to TEXT DEFAULT '',
      status      TEXT DEFAULT 'pending',
      priority    TEXT DEFAULT 'medium',
      color       TEXT DEFAULT '#4f8ef7',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS todo_lists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by  TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS todo_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id     INTEGER NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      completed   INTEGER DEFAULT 0,
      assigned_to TEXT DEFAULT '',
      created_by  TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      sort_order  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      email      TEXT DEFAULT '',
      color      TEXT DEFAULT '#4f8ef7',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#4f8ef7',
      description TEXT DEFAULT '',
      status      TEXT DEFAULT 'active',
      start_date  TEXT DEFAULT '',
      end_date    TEXT DEFAULT '',
      created_by  TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_stages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      start_date  TEXT DEFAULT '',
      end_date    TEXT DEFAULT '',
      color       TEXT DEFAULT '',
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stage_slots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_id    INTEGER NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,
      start_date  TEXT DEFAULT '',
      end_date    TEXT DEFAULT '',
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      client      TEXT DEFAULT '',
      quote_date  TEXT DEFAULT (date('now')),
      margin      REAL DEFAULT 20,
      status      TEXT DEFAULT 'draft',
      notes       TEXT DEFAULT '',
      project_name TEXT DEFAULT '',
      created_by  TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quote_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id    INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      quantity    REAL DEFAULT 1,
      unit        TEXT DEFAULT '',
      unit_price  REAL DEFAULT 0,
      sort_order  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL DEFAULT '',
      contact     TEXT DEFAULT '',
      address     TEXT DEFAULT '',
      postcode    TEXT DEFAULT '',
      email       TEXT DEFAULT '',
      phone       TEXT DEFAULT '',
      notes       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── Migrations (add columns to existing tables) ─────────────────────────────

function migrateSchema() {
  const cols = db.pragma('table_info(tasks)').map(c => c.name);
  if (!cols.includes('caldav_uid'))  db.exec("ALTER TABLE tasks ADD COLUMN caldav_uid  TEXT DEFAULT ''");
  if (!cols.includes('caldav_etag')) db.exec("ALTER TABLE tasks ADD COLUMN caldav_etag TEXT DEFAULT ''");
  if (!cols.includes('end_date'))    db.exec("ALTER TABLE tasks ADD COLUMN end_date    TEXT DEFAULT ''");
  if (!cols.includes('project_id')) db.exec("ALTER TABLE tasks ADD COLUMN project_id  INTEGER DEFAULT NULL");
  if (!cols.includes('all_day'))    db.exec("ALTER TABLE tasks ADD COLUMN all_day     INTEGER DEFAULT 1");
  if (!cols.includes('task_time'))  db.exec("ALTER TABLE tasks ADD COLUMN task_time   TEXT    DEFAULT ''");
  if (!cols.includes('stage_id'))   db.exec("ALTER TABLE tasks ADD COLUMN stage_id    INTEGER DEFAULT NULL");

  const itemCols = db.pragma('table_info(todo_items)').map(c => c.name);
  if (!itemCols.includes('sort_order')) {
    db.exec("ALTER TABLE todo_items ADD COLUMN sort_order INTEGER DEFAULT 0");
    db.exec("UPDATE todo_items SET sort_order = id");
  }

  const quoteCols = db.pragma('table_info(quotes)').map(c => c.name);
  if (!quoteCols.includes('image_data'))  db.exec("ALTER TABLE quotes ADD COLUMN image_data  TEXT DEFAULT ''");
  if (!quoteCols.includes('extras_json')) db.exec("ALTER TABLE quotes ADD COLUMN extras_json TEXT DEFAULT ''");
  // Denormalized total (excl. BTW), kept in sync on save — lets the quote list load instantly
  if (!quoteCols.includes('total_price')) db.exec("ALTER TABLE quotes ADD COLUMN total_price REAL");
  // Explicit link to the project's name — decouples project linkage from the quote's own
  // (editable, duplicatable) name so a duplicated/renamed quote keeps pointing at the same project.
  if (!quoteCols.includes('project_name')) db.exec("ALTER TABLE quotes ADD COLUMN project_name TEXT DEFAULT ''");
  // Wanneer een offerte op status "later" is gezet (los van created_at, dat veel ouder
  // kan zijn) + tot wanneer een follow-up-herinnering is uitgesteld via de snooze-knop.
  if (!quoteCols.includes('later_since'))         db.exec("ALTER TABLE quotes ADD COLUMN later_since TEXT DEFAULT ''");
  if (!quoteCols.includes('later_snoozed_until')) db.exec("ALTER TABLE quotes ADD COLUMN later_snoozed_until TEXT DEFAULT ''");
  // Zelfde mechanisme, maar voor verzonden offertes zonder reactie van de klant.
  if (!quoteCols.includes('sent_since'))         db.exec("ALTER TABLE quotes ADD COLUMN sent_since TEXT DEFAULT ''");
  if (!quoteCols.includes('sent_snoozed_until')) db.exec("ALTER TABLE quotes ADD COLUMN sent_snoozed_until TEXT DEFAULT ''");

  const stageCols = db.pragma('table_info(project_stages)').map(c => c.name);
  if (!stageCols.includes('notes')) {
    db.exec("ALTER TABLE project_stages ADD COLUMN notes TEXT DEFAULT ''");
  }

  const projCols = db.pragma('table_info(projects)').map(c => c.name);
  if (!projCols.includes('client')) db.exec("ALTER TABLE projects ADD COLUMN client TEXT DEFAULT ''");
  // Algemene/interne projecten (bv. "Algemeen" voor opruimen/acquisitie) horen niet bij
  // de actieve pijplijn — uitsluiten van de Bedrijfsanalyse-cijfers zonder hun status
  // (en daarmee Gantt/kalender-zichtbaarheid) aan te raken.
  if (!projCols.includes('exclude_from_analysis')) db.exec("ALTER TABLE projects ADD COLUMN exclude_from_analysis INTEGER DEFAULT 0");
  // Auto-mark projects literally named "Algemeen" as excluded; one-time migration.
  db.exec("UPDATE projects SET exclude_from_analysis = 1 WHERE name = 'Algemeen' AND exclude_from_analysis = 0");
  // Handmatige koppeling met een Moneybird-Project (id), voor wanneer de naam in
  // Moneybird afwijkt van de projectnaam in deze app en automatisch matchen faalt.
  if (!projCols.includes('moneybird_project_id')) db.exec("ALTER TABLE projects ADD COLUMN moneybird_project_id TEXT DEFAULT ''");

  const qiCols = db.pragma('table_info(quote_items)').map(c => c.name);
  if (!qiCols.includes('is_outsourced'))  db.exec("ALTER TABLE quote_items ADD COLUMN is_outsourced  INTEGER DEFAULT 0");
  if (!qiCols.includes('margin'))         db.exec("ALTER TABLE quote_items ADD COLUMN margin         REAL    DEFAULT NULL");
  if (!qiCols.includes('enabled'))        db.exec("ALTER TABLE quote_items ADD COLUMN enabled        INTEGER DEFAULT 1");
  if (!qiCols.includes('section_label'))  db.exec("ALTER TABLE quote_items ADD COLUMN section_label  TEXT    DEFAULT NULL");

  // One-time migration: consolidate duplicate stages by (project_id, name) and
  // move their date ranges into the new stage_slots table.
  const slotCount  = db.prepare("SELECT COUNT(*) AS c FROM stage_slots").get().c;
  const stageCount = db.prepare("SELECT COUNT(*) AS c FROM project_stages").get().c;
  if (slotCount === 0 && stageCount > 0) {
    const groups = db.prepare(`
      SELECT project_id, name,
             GROUP_CONCAT(id) AS ids,
             MIN(id) AS keep_id
        FROM project_stages
       GROUP BY project_id, name
    `).all();
    const tx = db.transaction(() => {
      for (const g of groups) {
        const ids = g.ids.split(',').map(Number);
        const keepId = g.keep_id;
        const ph = ids.map(() => '?').join(',');
        const stages = db.prepare(
          `SELECT id, start_date, end_date FROM project_stages WHERE id IN (${ph}) ORDER BY id ASC`
        ).all(...ids);
        stages.forEach((s, i) => {
          if (s.start_date && s.end_date) {
            db.prepare(
              "INSERT INTO stage_slots (stage_id, start_date, end_date, sort_order) VALUES (?, ?, ?, ?)"
            ).run(keepId, s.start_date, s.end_date, i);
          }
        });
        const others = ids.filter(id => id !== keepId);
        if (others.length > 0) {
          const ophP = others.map(() => '?').join(',');
          db.prepare(`UPDATE tasks SET stage_id = ? WHERE stage_id IN (${ophP})`).run(keepId, ...others);
          db.prepare(`DELETE FROM project_stages WHERE id IN (${ophP})`).run(...others);
        }
      }
    });
    tx();
  }
}

// ─── Generic query dispatcher ─────────────────────────────────────────────────

function query({ action, table, data, where, columns }) {
  if (!db) throw new Error('Database not open');

  switch (action) {
    case 'select': return selectRows(table, where, columns);
    case 'insert': return insertRow(table, data);
    case 'update': return updateRow(table, data, where);
    case 'delete': return deleteRow(table, where);
    case 'save_quote': return saveQuote(data);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

function selectRows(table, where, columns) {
  validateTable(table);
  const selectCols = sanitizeColumns(table, columns);
  let sql = `SELECT ${selectCols} FROM ${table}`;
  const params = [];

  if (where && Object.keys(where).length > 0) {
    const clauses = Object.entries(where).map(([k, v]) => {
      params.push(v);
      return `${k} = ?`;
    });
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += orderFor(table);
  return db.prepare(sql).all(...params);
}

// Restricts a requested column list to columns that actually exist on the table,
// so callers can ask for a lightweight projection (e.g. quote list view) without
// risking SQL injection via arbitrary column names.
function sanitizeColumns(table, columns) {
  if (!Array.isArray(columns) || columns.length === 0) return '*';
  const validCols = new Set(db.pragma(`table_info(${table})`).map(c => c.name));
  const safe = columns.filter(c => validCols.has(c));
  return safe.length ? safe.join(', ') : '*';
}

function checkpoint() {
  // Flush WAL back to main .db file so Google Drive only needs to sync one file
  try { db.pragma('wal_checkpoint(FULL)'); } catch (_) {}
}

function insertRow(table, data) {
  validateTable(table);
  const keys = Object.keys(data);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const result = db.prepare(sql).run(...Object.values(data));
  checkpoint();
  return { id: result.lastInsertRowid, changes: result.changes };
}

function updateRow(table, data, where) {
  validateTable(table);
  const setClauses = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const whereClauses = Object.entries(where).map(([k]) => `${k} = ?`).join(' AND ');
  const sql = `UPDATE ${table} SET ${setClauses} WHERE ${whereClauses}`;
  const params = [...Object.values(data), ...Object.values(where)];
  const result = db.prepare(sql).run(...params);
  checkpoint();
  return { changes: result.changes };
}

function deleteRow(table, where) {
  validateTable(table);
  const whereClauses = Object.entries(where).map(([k]) => `${k} = ?`).join(' AND ');
  const sql = `DELETE FROM ${table} WHERE ${whereClauses}`;
  const result = db.prepare(sql).run(...Object.values(where));
  checkpoint();
  return { changes: result.changes };
}

// Replace a quote and all of its line items as one SQLite transaction.  The
// quote editor used to update the parent, delete every item, then insert items
// one-by-one from the renderer.  A crash or a failed write in that gap could
// permanently leave a quote with missing items.
function saveQuote(payload) {
  const { id, quote, items } = payload || {};
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    throw new Error('save_quote requires quote data');
  }
  if (!Array.isArray(items)) {
    throw new Error('save_quote requires an items array');
  }

  const quoteKeys = Object.keys(quote);
  if (quoteKeys.length === 0) throw new Error('save_quote requires quote fields');
  const quotePlaceholders = quoteKeys.map(() => '?').join(', ');
  const insertQuote = db.prepare(
    `INSERT INTO quotes (${quoteKeys.join(', ')}) VALUES (${quotePlaceholders})`
  );
  const updateQuote = db.prepare(
    `UPDATE quotes SET ${quoteKeys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`
  );
  const deleteItems = db.prepare('DELETE FROM quote_items WHERE quote_id = ?');
  const itemKeys = ['quote_id', 'type', 'name', 'quantity', 'unit', 'unit_price', 'sort_order', 'margin', 'is_outsourced', 'enabled', 'section_label'];
  const insertItem = db.prepare(
    `INSERT INTO quote_items (${itemKeys.join(', ')}) VALUES (${itemKeys.map(() => '?').join(', ')})`
  );

  const transaction = db.transaction(() => {
    let quoteId = id;
    if (quoteId) {
      const result = updateQuote.run(...quoteKeys.map(k => quote[k]), quoteId);
      if (result.changes !== 1) throw new Error(`Quote not found: ${quoteId}`);
      deleteItems.run(quoteId);
    } else {
      quoteId = insertQuote.run(...quoteKeys.map(k => quote[k])).lastInsertRowid;
    }

    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('save_quote items must be objects');
      }
      insertItem.run(...itemKeys.map(k => k === 'quote_id' ? quoteId : (item[k] ?? null)));
    }
    return Number(quoteId);
  });

  const quoteId = transaction();
  checkpoint();
  return { id: quoteId, changes: 1 };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_TABLES = new Set(['tasks', 'todo_lists', 'todo_items', 'quotes', 'quote_items', 'team_members', 'projects', 'project_stages', 'stage_slots', 'clients']);

function validateTable(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Table not allowed: ${table}`);
}

function orderFor(table) {
  if (table === 'tasks')       return ' ORDER BY date ASC, created_at ASC';
  if (table === 'todo_lists')  return ' ORDER BY created_at DESC';
  if (table === 'todo_items')  return ' ORDER BY sort_order ASC, id ASC';
  if (table === 'team_members') return ' ORDER BY name ASC';
  if (table === 'projects')    return ' ORDER BY start_date ASC, name ASC';
  if (table === 'quotes')          return ' ORDER BY created_at DESC';
  if (table === 'quote_items')     return ' ORDER BY sort_order ASC, id ASC';
  if (table === 'project_stages')  return ' ORDER BY sort_order ASC, id ASC';
  if (table === 'clients')         return ' ORDER BY name ASC';
  if (table === 'stage_slots')     return ' ORDER BY start_date ASC, id ASC';
  return '';
}

module.exports = { openDatabase, query };
