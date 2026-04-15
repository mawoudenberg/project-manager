"""
Project Manager – Raspberry Pi REST server
Usage:
    pip install flask
    python app.py --db /mnt/nas/shared/project-manager.db
"""
import sqlite3, json, argparse, os, base64
from flask import Flask, request, jsonify, send_from_directory, abort

app   = Flask(__name__)
DB_PATH = None

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ALLOWED_TABLES = {
    'tasks', 'todo_lists', 'todo_items', 'team_members',
    'projects', 'project_stages', 'stage_slots',
    'quotes', 'quote_items', 'presets',
}

# ── Static file serving ─────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(os.path.join(BASE, 'renderer'), 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    for folder in ['renderer', 'assets']:
        full = os.path.join(BASE, folder, filename)
        if os.path.isfile(full):
            return send_from_directory(os.path.join(BASE, folder), filename)
    return abort(404)


@app.route('/api/logo')
def logo():
    p = os.path.join(BASE, 'assets', 'Logo.png')
    if not os.path.isfile(p):
        return jsonify({'url': None})
    with open(p, 'rb') as f:
        data = base64.b64encode(f.read()).decode()
    return jsonify({'url': f'data:image/png;base64,{data}'})


# ── Database helpers ────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    db = get_db()
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
                stage_id    INTEGER DEFAULT NULL,
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
            CREATE TABLE IF NOT EXISTS quotes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL, client TEXT DEFAULT '',
                quote_date  TEXT DEFAULT (date('now')), margin REAL DEFAULT 20,
                status      TEXT DEFAULT 'draft', notes TEXT DEFAULT '',
                created_by  TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS quote_items (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                quote_id    INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
                type        TEXT NOT NULL, name TEXT NOT NULL,
                quantity    REAL DEFAULT 1, unit TEXT DEFAULT '',
                unit_price  REAL DEFAULT 0, sort_order INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS presets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                category    TEXT NOT NULL,
                name        TEXT NOT NULL,
                price       REAL DEFAULT 0,
                sort_order  INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS stage_slots (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                stage_id    INTEGER NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,
                start_date  TEXT DEFAULT '',
                end_date    TEXT DEFAULT '',
                sort_order  INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now'))
            );
        """)
    # Migrate: add sort_order to todo_lists if missing
    cols = [r[1] for r in db.execute("PRAGMA table_info(todo_lists)").fetchall()]
    if 'sort_order' not in cols:
        db.execute("ALTER TABLE todo_lists ADD COLUMN sort_order INTEGER DEFAULT 0")
    tcols = [r[1] for r in db.execute("PRAGMA table_info(tasks)").fetchall()]
    if 'stage_id' not in tcols:
        db.execute("ALTER TABLE tasks ADD COLUMN stage_id INTEGER DEFAULT NULL")
    qcols = [r[1] for r in db.execute("PRAGMA table_info(quotes)").fetchall()]
    if 'image_data' not in qcols:
        db.execute("ALTER TABLE quotes ADD COLUMN image_data TEXT DEFAULT ''")
    if 'extras_json' not in qcols:
        db.execute("ALTER TABLE quotes ADD COLUMN extras_json TEXT DEFAULT ''")
    scols = [r[1] for r in db.execute("PRAGMA table_info(project_stages)").fetchall()]
    if 'notes' not in scols:
        db.execute("ALTER TABLE project_stages ADD COLUMN notes TEXT DEFAULT ''")
    qicols = [r[1] for r in db.execute("PRAGMA table_info(quote_items)").fetchall()]
    if 'is_outsourced' not in qicols:
        db.execute("ALTER TABLE quote_items ADD COLUMN is_outsourced INTEGER DEFAULT 0")
    if 'margin' not in qicols:
        db.execute("ALTER TABLE quote_items ADD COLUMN margin REAL DEFAULT NULL")

    # One-time migration: consolidate duplicate stages by (project_id, name)
    # and move their date ranges into stage_slots.
    slot_count  = db.execute("SELECT COUNT(*) FROM stage_slots").fetchone()[0]
    stage_count = db.execute("SELECT COUNT(*) FROM project_stages").fetchone()[0]
    if slot_count == 0 and stage_count > 0:
        groups = db.execute("""
            SELECT project_id, name,
                   GROUP_CONCAT(id) AS ids,
                   MIN(id) AS keep_id
              FROM project_stages
             GROUP BY project_id, name
        """).fetchall()
        for g in groups:
            ids = [int(x) for x in g['ids'].split(',')]
            keep_id = g['keep_id']
            ph = ','.join('?' for _ in ids)
            stages = db.execute(
                f"SELECT id, start_date, end_date FROM project_stages WHERE id IN ({ph}) ORDER BY id ASC",
                ids
            ).fetchall()
            for i, s in enumerate(stages):
                if s['start_date'] and s['end_date']:
                    db.execute(
                        "INSERT INTO stage_slots (stage_id, start_date, end_date, sort_order) VALUES (?, ?, ?, ?)",
                        (keep_id, s['start_date'], s['end_date'], i)
                    )
            others = [x for x in ids if x != keep_id]
            if others:
                oph = ','.join('?' for _ in others)
                db.execute(f"UPDATE tasks SET stage_id = ? WHERE stage_id IN ({oph})", [keep_id] + others)
                db.execute(f"DELETE FROM project_stages WHERE id IN ({oph})", others)

    db.commit()
    db.close()


def order_for(table):
    return {
        'tasks':          'ORDER BY date ASC, created_at ASC',
        'todo_lists':     'ORDER BY sort_order ASC, created_at DESC',
        'todo_items':     'ORDER BY sort_order ASC, id ASC',
        'team_members':   'ORDER BY name ASC',
        'projects':       'ORDER BY created_at DESC',
        'project_stages': 'ORDER BY sort_order ASC, id ASC',
        'stage_slots':    'ORDER BY start_date ASC, id ASC',
        'quotes':         'ORDER BY created_at DESC',
        'quote_items':    'ORDER BY sort_order ASC, id ASC',
        'presets':        'ORDER BY sort_order ASC, id ASC',
    }.get(table, '')


# ── Generic query endpoint ──────────────────────────────────────────────────────

@app.route('/api/query', methods=['POST'])
def handle_query():
    try:
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

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/api/presets', methods=['GET'])
def get_presets():
    try:
        with get_db() as db:
            rows = db.execute("SELECT * FROM presets ORDER BY sort_order ASC, id ASC").fetchall()
            return jsonify([dict(r) for r in rows])
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/api/presets', methods=['PUT'])
def save_presets():
    """Bulk-replace all presets. Body: { items: [ {category, name, price, sort_order}, ... ] }"""
    try:
        body = request.get_json(force=True)
        items = body.get('items', [])
        with get_db() as db:
            db.execute("DELETE FROM presets")
            for item in items:
                db.execute(
                    "INSERT INTO presets (category, name, price, sort_order) VALUES (?, ?, ?, ?)",
                    (item.get('category',''), item.get('name',''), item.get('price', 0), item.get('sort_order', 0))
                )
        return jsonify({'ok': True, 'count': len(items)})
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


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
