'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../db');

test('local database stores only positive half-hour time entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-manager-hours-'));
  const dbPath = path.join(dir, 'test.db');

  try {
    db.openDatabase(dbPath);
    const project = db.query({ action: 'insert', table: 'projects', data: { name: 'Testproject', status: 'active' } });
    const entry = db.query({
      action: 'insert', table: 'time_entries',
      data: { entry_date: '2026-08-22', hours: 2.5, project_id: project.id, employee: 'Maurits' },
    });
    const rows = db.query({ action: 'select', table: 'time_entries', where: { id: entry.id } });
    assert.equal(rows[0].hours, 2.5);
    assert.throws(() => db.query({
      action: 'insert', table: 'time_entries',
      data: { entry_date: '2026-08-22', hours: 1.25, project_id: project.id, employee: 'Maurits' },
    }), /CHECK constraint failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
