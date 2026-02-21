"""
Raspberry Pi REST server — future migration path.
Usage:
  pip install flask
  python app.py --db /path/to/project-manager.db
"""
import sqlite3, json, argparse
from pathlib import Path
from flask import Flask, request, jsonify

app = Flask(__name__)
DB_PATH = None


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                date TEXT,
                created_by TEXT DEFAULT '',
                assigned_to TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                priority TEXT DEFAULT 'medium',
                color TEXT DEFAULT '#4f8ef7',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS todo_lists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                created_by TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS todo_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id INTEGER NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                completed INTEGER DEFAULT 0,
                assigned_to TEXT DEFAULT '',
                created_by TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)


# ── Tasks ──────────────────────────────────────────────────────────────────────

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    with get_db() as db:
        rows = db.execute("SELECT * FROM tasks ORDER BY date ASC, created_at ASC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/tasks', methods=['POST'])
def create_task():
    data = request.json
    keys = [k for k in data if k != 'id']
    sql = f"INSERT INTO tasks ({','.join(keys)}) VALUES ({','.join(['?']*len(keys))})"
    with get_db() as db:
        cur = db.execute(sql, [data[k] for k in keys])
        return jsonify({'id': cur.lastrowid}), 201


@app.route('/api/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    data = {k: v for k, v in request.json.items() if k not in ('id','created_at')}
    sets = ', '.join(f"{k}=?" for k in data)
    with get_db() as db:
        db.execute(f"UPDATE tasks SET {sets} WHERE id=?", [*data.values(), task_id])
    return jsonify({'ok': True})


@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    with get_db() as db:
        db.execute("DELETE FROM tasks WHERE id=?", [task_id])
    return jsonify({'ok': True})


# ── Todo Lists ─────────────────────────────────────────────────────────────────

@app.route('/api/lists', methods=['GET'])
def get_lists():
    with get_db() as db:
        rows = db.execute("SELECT * FROM todo_lists ORDER BY created_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/lists', methods=['POST'])
def create_list():
    data = request.json
    keys = [k for k in data if k != 'id']
    sql = f"INSERT INTO todo_lists ({','.join(keys)}) VALUES ({','.join(['?']*len(keys))})"
    with get_db() as db:
        cur = db.execute(sql, [data[k] for k in keys])
    return jsonify({'id': cur.lastrowid}), 201


@app.route('/api/lists/<int:list_id>', methods=['DELETE'])
def delete_list(list_id):
    with get_db() as db:
        db.execute("DELETE FROM todo_lists WHERE id=?", [list_id])
    return jsonify({'ok': True})


# ── Todo Items ─────────────────────────────────────────────────────────────────

@app.route('/api/lists/<int:list_id>/items', methods=['GET'])
def get_items(list_id):
    with get_db() as db:
        rows = db.execute("SELECT * FROM todo_items WHERE list_id=? ORDER BY created_at ASC", [list_id]).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/lists/<int:list_id>/items', methods=['POST'])
def create_item(list_id):
    data = {**request.json, 'list_id': list_id}
    keys = [k for k in data if k != 'id']
    sql = f"INSERT INTO todo_items ({','.join(keys)}) VALUES ({','.join(['?']*len(keys))})"
    with get_db() as db:
        cur = db.execute(sql, [data[k] for k in keys])
    return jsonify({'id': cur.lastrowid}), 201


@app.route('/api/items/<int:item_id>', methods=['PUT'])
def update_item(item_id):
    data = {k: v for k, v in request.json.items() if k not in ('id','created_at')}
    sets = ', '.join(f"{k}=?" for k in data)
    with get_db() as db:
        db.execute(f"UPDATE todo_items SET {sets} WHERE id=?", [*data.values(), item_id])
    return jsonify({'ok': True})


@app.route('/api/items/<int:item_id>', methods=['DELETE'])
def delete_item(item_id):
    with get_db() as db:
        db.execute("DELETE FROM todo_items WHERE id=?", [item_id])
    return jsonify({'ok': True})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default='project-manager.db', help='Path to SQLite database')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()
    DB_PATH = args.db
    init_db()
    print(f"Starting server on {args.host}:{args.port}, DB: {DB_PATH}")
    app.run(host=args.host, port=args.port)
