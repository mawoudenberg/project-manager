"""
Project Manager – Raspberry Pi REST server
Usage:
    pip install flask
    python app.py --db /mnt/nas/shared/project-manager.db
"""
import sqlite3, json, argparse
from flask import Flask, request, jsonify

app   = Flask(__name__)
DB_PATH = None

ALLOWED_TABLES = {
    'tasks', 'todo_lists', 'todo_items', 'team_members',
    'projects', 'project_stages',
}

# ── Database helpers ────────────────────────────────────────────────────────────

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
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                description TEXT DEFAULT '',
                date        TEXT DEFAULT '',
                end_date    TEXT DEFAULT '',
                created_by  TEXT DEFAULT '',
                assigned_to TEXT DEFAULT '',
                status      TEXT DEFAULT 'pending',
                priority    TEXT DEFAULT 'medium',
                color       TEXT DEFAULT '#4f8ef7',
                project_id  INTEGER DEFAULT NULL,
                caldav_uid  TEXT DEFAULT '',
                caldav_etag TEXT DEFAULT '',
                all_day     INTEGER DEFAULT 1,
                task_time   TEXT DEFAULT '',
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
                sort_order  INTEGER DEFAULT 0,
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
                description TEXT DEFAULT '',
                start_date  TEXT DEFAULT '',
                end_date    TEXT DEFAULT '',
                status      TEXT DEFAULT 'active',
                color       TEXT DEFAULT '#4f8ef7',
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
        """)


def order_for(table):
    return {
        'tasks':          'ORDER BY date ASC, created_at ASC',
        'todo_lists':     'ORDER BY created_at DESC',
        'todo_items':     'ORDER BY sort_order ASC, id ASC',
        'team_members':   'ORDER BY name ASC',
        'projects':       'ORDER BY created_at DESC',
        'project_stages': 'ORDER BY sort_order ASC, id ASC',
    }.get(table, '')


# ── Generic query endpoint ──────────────────────────────────────────────────────

@app.route('/api/query', methods=['POST'])
def handle_query():
    body  = request.get_json(force=True)
    action = body.get('action')
    table  = body.get('table')
    data   = body.get('data')   or {}
    where  = body.get('where')  or {}

    if table not in ALLOWED_TABLES:
        return jsonify({'error': f'Table not allowed: {table}'}), 400

    with get_db() as db:
        if action == 'select':
            sql = f"SELECT * FROM {table}"
            params = []
            if where:
                clauses = [f"{k}=?" for k in where]
                sql += " WHERE " + " AND ".join(clauses)
                params = list(where.values())
            sql += " " + order_for(table)
            rows = db.execute(sql, params).fetchall()
            return jsonify([dict(r) for r in rows])

        elif action == 'insert':
            keys = list(data.keys())
            sql  = f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join(['?']*len(keys))})"
            cur  = db.execute(sql, [data[k] for k in keys])
            return jsonify({'id': cur.lastrowid}), 201

        elif action == 'update':
            if not where:
                return jsonify({'error': 'update requires where'}), 400
            sets    = ', '.join(f"{k}=?" for k in data)
            clauses = ' AND '.join(f"{k}=?" for k in where)
            sql     = f"UPDATE {table} SET {sets} WHERE {clauses}"
            db.execute(sql, [*data.values(), *where.values()])
            return jsonify({'ok': True})

        elif action == 'delete':
            if not where:
                return jsonify({'error': 'delete requires where'}), 400
            clauses = ' AND '.join(f"{k}=?" for k in where)
            db.execute(f"DELETE FROM {table} WHERE {clauses}", list(where.values()))
            return jsonify({'ok': True})

        else:
            return jsonify({'error': f'Unknown action: {action}'}), 400


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'db': DB_PATH})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--db',   default='/mnt/nas/shared/project-manager.db')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()
    DB_PATH = args.db
    init_db()
    print(f"Project Manager server running on {args.host}:{args.port}  DB: {DB_PATH}")
    app.run(host=args.host, port=args.port, threaded=True)
