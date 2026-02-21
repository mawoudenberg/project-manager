# Project Manager

Cross-platform desktop app for shared team project management.
Uses a SQLite database on a shared Google Drive folder — no server required.
One config change migrates the team to a Raspberry Pi REST backend.

## Quick Start

```bash
# Requires Node.js 22 LTS (see below)
npm install
npm start
```

The first run opens a **Setup Wizard**:
1. Enter your name
2. Browse to your shared folder (e.g. Google Drive)
3. Click Finish — `project-manager.db` is created there

Other team members do the same, pointing to the same shared folder.

## Node.js requirement

Node 22 LTS is required (`better-sqlite3` native module).
If you have Homebrew: `brew install node@22`
Then add to your shell: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`

## Build installers

```bash
npm run build:mac   # → dist/Project Manager-1.0.0.dmg
npm run build:win   # → dist/Project Manager Setup 1.0.0.exe  (run on Windows)
```

## Views

| View | Description |
|------|-------------|
| Monthly | Calendar grid — click any day to add a task |
| Weekly | 7-column layout with cards per day |
| Daily | Task list with status checkboxes and priority indicators |
| Todo Lists | Kanban-style card grid with progress bars |

## Raspberry Pi migration

1. Run `python server/app.py --db /path/to/project-manager.db` on your Pi
2. Each user: Settings → mode → API → enter Pi URL (e.g. `http://raspberrypi.local:5000`)
3. Done — no reinstall

## File structure

```
project-manager/
├── main.js          Main process (window, IPC, DB)
├── preload.js       contextBridge (safe IPC)
├── db.js            SQLite operations
├── renderer/
│   ├── index.html   App shell + modals
│   ├── style.css    CSS (dark theme, responsive)
│   └── app.js       All UI logic
└── server/
    └── app.py       Flask REST API (Raspberry Pi)
```
