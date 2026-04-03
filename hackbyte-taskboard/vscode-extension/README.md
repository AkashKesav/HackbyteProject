# Hackbyte Taskboard VS Code Extension

This extension resolves open task-board items from recent Git commits and recently edited documentation.

## What it does

- Reads open tasks from the shared SpacetimeDB database
- Inspects recent commits on the current branch
- Scans recently modified docs in the workspace
- Sends the evidence plus open tasks to Gemini
- Shows a review list before applying any task closures
- Calls `resolve_task_from_inference` so the website updates in real time

## Commands

- `Hackbyte: Resolve Tasks From Recent Work`
- `Hackbyte: Configure Gemini API Key`
- `Hackbyte: Open Live Task Board`

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Build the extension bundle:

```bash
npm run build
```

3. Open the `hackbyte-taskboard` repo in VS Code.

4. Open the `vscode-extension` folder in the extension host workflow:
   - `Run and Debug`
   - launch the extension in a new Extension Development Host window

5. Run `Hackbyte: Configure Gemini API Key` once.

6. Run `Hackbyte: Resolve Tasks From Recent Work`.

## Important settings

- `hackbyteTaskboard.spacetimeHttpUrl`
- `hackbyteTaskboard.databaseName`
- `hackbyteTaskboard.boardUrl`
- `hackbyteTaskboard.geminiModel`
- `hackbyteTaskboard.recentCommitCount`
- `hackbyteTaskboard.recentDocLookbackHours`
- `hackbyteTaskboard.confidenceThreshold`

Defaults are wired for the current local stack:

- SpacetimeDB: `http://127.0.0.1:3000`
- database: `hackbyte-taskboard`
- board: `http://127.0.0.1:5173/`
