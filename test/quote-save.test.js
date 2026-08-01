'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const db = require('../db');

function quote(name) {
  return {
    name, client: 'Test client', quote_date: '2026-08-01', margin: 20,
    status: 'draft', notes: '', project_name: '', created_by: 'Test',
    image_data: '', extras_json: '', total_price: 100,
  };
}

function item(name = 'Original item') {
  return {
    type: 'material', name, quantity: 1, unit: 'st', unit_price: 100,
    sort_order: 0, margin: null, is_outsourced: 0, enabled: 1,
  };
}

test('save_quote rolls back a failed replacement in local SQLite mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-quote-save-'));
  try {
    db.openDatabase(path.join(directory, 'project-manager.db'));
    const created = db.query({ action: 'save_quote', table: 'quotes', data: {
      quote: quote('Original quote'), items: [item()],
    }});

    assert.throws(() => db.query({ action: 'save_quote', table: 'quotes', data: {
      id: created.id, quote: quote('Changed quote'), items: [item(null)],
    }}));

    assert.equal(
      db.query({ action: 'select', table: 'quotes', where: { id: created.id } })[0].name,
      'Original quote',
    );
    assert.deepEqual(
      db.query({ action: 'select', table: 'quote_items', where: { quote_id: created.id } }).map(row => row.name),
      ['Original item'],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
