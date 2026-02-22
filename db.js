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
  db.pragma('journal_mode = WAL');
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
      created_at  TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS quotes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      client      TEXT DEFAULT '',
      quote_date  TEXT DEFAULT (date('now')),
      margin      REAL DEFAULT 20,
      status      TEXT DEFAULT 'draft',
      notes       TEXT DEFAULT '',
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
  `);
}

// ─── Migrations (add columns to existing tables) ─────────────────────────────

function migrateSchema() {
  const cols = db.pragma('table_info(tasks)').map(c => c.name);
  if (!cols.includes('caldav_uid'))  db.exec("ALTER TABLE tasks ADD COLUMN caldav_uid  TEXT DEFAULT ''");
  if (!cols.includes('caldav_etag')) db.exec("ALTER TABLE tasks ADD COLUMN caldav_etag TEXT DEFAULT ''");
  if (!cols.includes('end_date'))    db.exec("ALTER TABLE tasks ADD COLUMN end_date    TEXT DEFAULT ''");
  if (!cols.includes('project_id')) db.exec("ALTER TABLE tasks ADD COLUMN project_id  INTEGER DEFAULT NULL");
}

// ─── Generic query dispatcher ─────────────────────────────────────────────────

function query({ action, table, data, where }) {
  if (!db) throw new Error('Database not open');

  switch (action) {
    case 'select': return selectRows(table, where);
    case 'insert': return insertRow(table, data);
    case 'update': return updateRow(table, data, where);
    case 'delete': return deleteRow(table, where);
    default: throw new Error(`Unknown action: ${action}`);
  }
}

function selectRows(table, where) {
  validateTable(table);
  let sql = `SELECT * FROM ${table}`;
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

function insertRow(table, data) {
  validateTable(table);
  const keys = Object.keys(data);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const result = db.prepare(sql).run(...Object.values(data));
  return { id: result.lastInsertRowid, changes: result.changes };
}

function updateRow(table, data, where) {
  validateTable(table);
  const setClauses = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const whereClauses = Object.entries(where).map(([k]) => `${k} = ?`).join(' AND ');
  const sql = `UPDATE ${table} SET ${setClauses} WHERE ${whereClauses}`;
  const params = [...Object.values(data), ...Object.values(where)];
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes };
}

function deleteRow(table, where) {
  validateTable(table);
  const whereClauses = Object.entries(where).map(([k]) => `${k} = ?`).join(' AND ');
  const sql = `DELETE FROM ${table} WHERE ${whereClauses}`;
  const result = db.prepare(sql).run(...Object.values(where));
  return { changes: result.changes };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_TABLES = new Set(['tasks', 'todo_lists', 'todo_items', 'quotes', 'quote_items', 'team_members', 'projects']);

function validateTable(table) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Table not allowed: ${table}`);
}

function orderFor(table) {
  if (table === 'tasks')       return ' ORDER BY date ASC, created_at ASC';
  if (table === 'todo_lists')  return ' ORDER BY created_at DESC';
  if (table === 'todo_items')  return ' ORDER BY created_at ASC';
  if (table === 'team_members') return ' ORDER BY name ASC';
  if (table === 'projects')    return ' ORDER BY start_date ASC, name ASC';
  if (table === 'quotes')      return ' ORDER BY created_at DESC';
  if (table === 'quote_items') return ' ORDER BY sort_order ASC, id ASC';
  return '';
}

module.exports = { openDatabase, query };
