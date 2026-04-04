# Living Codebase Narrator

Documentation that writes itself as you code.

## What this repo contains (MVP)

- `apps/extension`: VS Code extension — save → diff → debounce → `POST /deltas`; sidebar webview with live docs
- `apps/backend`: local HTTP API — Gemini/Hugging Face + fallback, optional ElevenLabs audio, JSONL + optional MongoDB
- `apps/web`: React + Vite — polls `/docs`, plays audio, voting buttons
- `spacetime/server`: SpacetimeDB module — `code_deltas`, `doc_entries`, `doc_annotations` + reducers
- `packages/types`: shared TypeScript types

## Quick start (Windows / PowerShell)

### 1) Install dependencies

From the repo root, **npm 7+** (workspaces):

```powershell
cd "c:\Users\Veeravardhan\OneDrive\Desktop\projects\living-codebase-narrator"
npm install
```

If `npm install` at the root fails, install each package:

```powershell
cd "packages\types"; npm install
cd "..\..\apps\backend"; npm install
cd "..\web"; npm install
cd "..\extension"; npm install
cd "..\..\spacetime\server"; npm install
```

### 2) Configure env (optional)

```powershell
Copy-Item ".env.example" ".env"
```

Edit `.env` with API keys as needed. No keys = LLM fallback + no cloud TTS.

### 3) Run backend + web

Terminal A:

```powershell
cd "apps\backend"
npm run dev
```

Terminal B:

```powershell
cd "apps\web"
npm run dev
```

- Backend: `http://localhost:8787`
- Web: `http://localhost:5173` (Vite proxies API routes to the backend)

### 4) VS Code extension (Extension Development Host)

1. Open this repo in VS Code.
2. **Run and Debug** → **Run Extension (Living Codebase Narrator)** (builds `apps/extension` via preLaunch task).
3. In the **Extension Development Host**: open a folder, edit a file, **save** (wait for debounce, default 5s).
4. Open the **Narrator** activity bar → **Living Docs** sidebar.

**Commands** (Command Palette):

- `LCN: Ping Backend` — `GET /health`
- `LCN: Show Output Log` — extension log (skipped saves, POST errors)

**If nothing sends:** lower **Settings → Living Codebase Narrator → min changed lines** to `1`, confirm backend URL, read **Output → Living Codebase Narrator**.

### 5) Manual API script

With the backend running:

```powershell
cd "c:\Users\Veeravardhan\OneDrive\Desktop\projects\living-codebase-narrator"
powershell -ExecutionPolicy Bypass -File ".\scripts\manual-api-test.ps1"
```

Optional: `.\scripts\manual-api-test.ps1 -BaseUrl "http://localhost:8787"`

## SpacetimeDB (optional)

Module lives in `spacetime/server`. Reducers: `submit_code_delta`, `upsert_doc_entry`, `vote_doc_entry`, `add_annotation`, `set_doc_status`.

Generate TypeScript client bindings (requires SpacetimeDB CLI):

```powershell
spacetime generate --lang typescript --out-dir "apps/web/src/module_bindings" --module-path "spacetime/server"
```

## Manual test checklist

1. `POST /debug/gemini` — direct LLM
2. `POST /debug/elevenlabs` — TTS
3. `GET /health` — Mongo / integrations
4. `POST /deltas` — full pipeline
5. Web UI at `http://localhost:5173`
6. Extension in Extension Development Host
7. End-to-end: save file → doc appears in web + sidebar
