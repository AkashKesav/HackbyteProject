# HackbyteProject Codebase Guide

## Purpose

This repository contains two related systems:

1. `Commit Confessional` / `CodeTruth`
   Tracks AI-assisted coding activity, correlates it to repository changes, computes AI contribution receipts, and surfaces security findings.
2. `Living Codebase Narrator`
   Converts saved editor diffs into narrated documentation cards with optional audio and storage integrations.

The repo is not a full monolith yet. It is a merged workspace that runs both products side by side.

## Top-Level Layout

```text
HackbyteProject/
|- backend/                     Commit Confessional backend API
|- frontend/                    Commit Confessional dashboard
|- vscode-extension/            Merged VS Code extension
|- firefox-extension/           Firefox capture extension + native host bridge
|- scripts/                     Root CLI utilities
|- .githooks/                   Git hook for post-commit receipts
|- .github/                     Dependabot + security workflows
|- living-codebase-narrator/    Imported narrator workspace
|- .aidetector.json             Local AI lineage store
|- package.json                 Root workspace commands
|- readme.md                    Short repo overview
```

## Main Products

### 1. Commit Confessional / CodeTruth

Main goal:

- capture AI-related activity from the editor and browser
- associate that activity with the current repository
- estimate how much of a diff or commit was AI-assisted
- enrich receipts with security and dependency audit findings
- show the latest state in a local dashboard

Main folders:

- `backend/`
- `frontend/`
- `vscode-extension/`
- `firefox-extension/`
- `scripts/`

### 2. Living Codebase Narrator

Main goal:

- watch saved file diffs
- generate summary cards describing what changed and why it matters
- display those cards in a live feed
- optionally use Gemini, ElevenLabs, MongoDB, and SpacetimeDB

Main folder:

- `living-codebase-narrator/living-codebase-narrator/living-codebase-narrator/`

## Runtime Map

### Default local ports

- Commit Confessional backend: `4000`
- Commit Confessional frontend: Vite default, usually `5173`
- Narrator backend: `8787`
- Narrator web app: Vite default for its app
- Simulation proxy base: `http://localhost:4000/proxy/<provider>/...`
- Optional local MITM proxy: `8877`

### Main execution entry points

- Root workspace commands live in `package.json`
- Commit Confessional backend entry point: `backend/src/server.js`
- Commit Confessional frontend entry point: `frontend/src/main.jsx`
- VS Code extension entry point: `vscode-extension/extension.js`
- Narrator backend entry point: `living-codebase-narrator/.../apps/backend/src/server.ts`
- Narrator web entry point: `living-codebase-narrator/.../apps/web/src/main.tsx`
- Narrator VS Code extension entry point: `living-codebase-narrator/.../apps/extension/src/extension.ts`

## Root Commands

From the repository root:

```powershell
npm run dev:backend
npm run dev:frontend
npm run dev:narrator:backend
npm run dev:narrator:web
npm run dev:narrator
npm run dev:all
npm run build
npm run build:narrator:web
npm run receipt:preview
npm run receipt:post-commit
npm run security:audit:deps
```

What they do:

- `dev:backend`: starts the Commit Confessional backend
- `dev:frontend`: starts the Commit Confessional dashboard
- `dev:narrator:backend`: starts the narrator backend
- `dev:narrator:web`: starts the narrator web app
- `dev:narrator`: starts both narrator services
- `dev:all`: starts both Commit Confessional services and both narrator services
- `build`: builds the Commit Confessional frontend
- `build:narrator:web`: builds the narrator web app
- `receipt:preview`: computes a working-tree receipt
- `receipt:post-commit`: computes a receipt for the current `HEAD`
- `security:audit:deps`: runs dependency CVE scanning via `npm audit`

## Configuration

### Commit Confessional backend environment variables

Defined through `.env`, `.env.local`, `backend/.env`, or `backend/.env.local`:

- `PORT`
- `SIM_PROXY_PORT`
- `REAL_PROXY_PORT`
- `ENABLE_LOCAL_PROXY`
- `FRONTEND_URL`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_OAUTH_CALLBACK_URL`
- `GITHUB_OAUTH_SEND_REDIRECT_URI`
- `SEMGREP_BIN`
- `SEMGREP_CONFIG`
- `SEMGREP_CONFIGS`
- `SEMGREP_MAX_FINDINGS`
- `DEPENDENCY_AUDIT_MAX_FINDINGS`
- `SOLANA_RPC_URL`
- `SOLANA_WALLET_ADDRESS`
- `SOLANA_ANCHOR_MODE`

### VS Code extension settings

Exposed in `vscode-extension/package.json`:

- `commitConfessional.backendUrl`
- `commitConfessional.aiExtensions`
- `commitConfessional.promptWindowMs`
- `commitConfessional.pasteMinLength`
- `lcn.backendUrl`
- `lcn.debounceMs`
- `lcn.minChangedLines`
- `lcn.ignoreGlobs`

### Narrator backend environment variables

Defined in `living-codebase-narrator/.../apps/backend/src/env.ts`:

- `PORT`
- `PUBLIC_BASE_URL`
- `LOCAL_DATA_DIR`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `HF_TOKEN`
- `HF_MODEL`
- `MONGODB_URI`
- `MONGODB_DB`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `NARRATOR_HEADING_PREFIX`
- `SPACETIME_SERVER_URL`
- `SPACETIME_MODULE_NAME`

## Architecture Overview

### Commit Confessional flow

1. The VS Code extension observes editor events.
2. The Firefox extension and optional proxy capture browser-side AI activity.
3. Events are posted to the backend.
4. The backend stores captures in `backend/data/proxy-events.json`.
5. A receipt request analyzes a diff or commit.
6. Model evidence is built from:
   - VS Code local event logs
   - Firefox local event logs
   - backend capture history
   - `.aidetector.json` line-level lineage
7. Security integrations enrich the receipt:
   - Semgrep source scan
   - dependency CVE scan via `npm audit`
   - optional Solana anchoring metadata
8. The frontend dashboard polls the backend and renders the latest repo state.

### Narrator flow

1. A saved file in VS Code produces a unified diff.
2. The narrator extension debounces and posts the delta to `/deltas`.
3. The narrator backend generates documentation using Gemini if configured.
4. If LLM generation fails, it falls back to a local heuristic summarizer.
5. A `DocEntry` is stored in JSONL and optionally MongoDB.
6. The narrator web app and webview poll `/docs`.
7. If audio is available, ElevenLabs output is exposed through `/audio/:filename`.

## Commit Confessional Components

## Backend

Path:

- `backend/src/server.js`

Purpose:

- central API server
- state holder for captures, receipts, repo context, and GitHub session
- simulation proxy and optional local MITM proxy host

### Persistent backend state

Stored in `backend/data/`:

- `proxy-events.json`: normalized capture history
- `latest-receipt.json`: latest preview or commit receipt
- `receipt-history.json`: recent commit receipts
- `github-session.json`: cached GitHub user/token session
- `.http-mitm-proxy/`: local proxy CA artifacts

### Backend routes

#### Status and dashboard

- `GET /api/health`
  Returns backend status, repo summary, latest commit, latest receipt, GitHub state, and capture count.
- `GET /api/proxy/status`
  Returns proxy state plus analytics, captures, receipts, and repo details.
- `GET /api/dashboard`
  Returns the payload used by the frontend dashboard.

#### Proxy and capture ingestion

- `GET /api/proxy/events`
  Lists stored proxy events.
- `GET /api/proxy/events/:id`
  Returns one stored event.
- `POST /api/proxy/events`
  Stores a normalized proxy event.
- `POST /api/proxy/capture`
  Alternate event ingestion endpoint.
- `POST /api/proxy/simulate`
  Creates a simulated provider capture for demo/testing.
- `DELETE /api/proxy/events`
  Clears stored captures.
- `POST /api/proxy/test-request`
  Generates a manual test capture.
- `ALL /proxy/:provider/*`
  Simulation proxy endpoint that returns mock provider responses and stores an event.

#### Extension and receipt endpoints

- `POST /api/extension/events`
  Receives VS Code and Firefox extension events.
- `POST /api/receipt`
  Builds a receipt from diff or commit input and enriches it with security findings.

#### GitHub OAuth

- `GET /api/github/status`
  Returns GitHub connection status.
- `POST /api/github/connect`
  Creates an OAuth authorization URL.
- `GET /api/github/callback`
  Finishes the OAuth flow.
- `POST /api/github/logout`
  Clears the stored GitHub session.

### Core backend services

#### `backend/src/services/repoContext.js`

Responsible for:

- reading Git remote and branch metadata
- indexing repo files
- creating keyword tokens for repo correlation
- creating commit snapshots
- normalizing stored capture objects

#### `backend/src/services/proxyAnalysis.js`

Responsible for:

- provider inference from host names
- prompt text extraction from API request bodies
- model extraction
- repo correlation scoring
- basic vulnerability hint extraction from prompt text
- simulated proxy event generation

#### `backend/src/services/modelEvidence.js`

Responsible for:

- diff parsing
- meaningful changed line extraction
- local VS Code log correlation
- local Firefox log correlation
- AI contribution estimation
- Copilot-specific contribution estimation
- capture model resolution
- preview and commit receipt assembly

Important behaviors:

- treats `preview://...` receipt URLs as preview mode
- supports exact, structural-signature, similarity, and lineage-based attribution
- reports receipt methods like:
  - `hash-correlation`
  - `diff-hash-match`
  - `copilot-diff-coverage`
  - `copilot-tag-signature`
  - `stored-ai-signature`
  - `stored-ai-lineage`

#### `backend/src/services/aiDetectorStore.js`

Responsible for:

- loading and merging `.aidetector.json` lineage stores
- remapping detector paths from ancestor folders
- computing stored-tag coverage for changed lines
- recording commit-level receipt summaries back into the detector file

The detector store is line-oriented, not file-only. Each tracked file stores:

- `languageId`
- `updatedAt`
- `totalMeaningfulLines`
- `aiTaggedLines`
- `aiShare`
- `dominantOrigin`
- `lineTags[]`

Each line tag can carry:

- hash
- normalized content
- structural signature
- token fingerprint
- AI origin metadata
- provider/model/tool/source

#### `backend/src/services/receiptIntegrations.js`

Responsible for:

- Semgrep execution
- dependency CVE scanning via `npm audit`
- optional Solana receipt anchoring metadata

Semgrep behavior:

- default config: `p/default`
- custom config: `backend/semgrep/javascript-product-audit.yml`
- supports file-scoped scans for single-file preview mode

Dependency audit behavior:

- discovers `package-lock.json` files
- scans the root project and narrator workspace
- aggregates findings and highest severity

#### `backend/src/db.js`

Responsible for:

- deduplicating and sorting commit receipt history

### Security coverage

#### Custom Semgrep rules

Defined in `backend/semgrep/javascript-product-audit.yml`.

Current custom rules target:

- SQL injection
- `innerHTML` XSS
- raw HTML template XSS
- Express HTML response XSS
- open redirect
- path traversal
- command injection

#### Additional security automation

Defined in `.github/`:

- `dependabot.yml`
- `workflows/codeql.yml`
- `workflows/dependency-audit.yml`
- `workflows/gitleaks.yml`
- `workflows/trivy.yml`
- `workflows/zap-baseline.yml`

These provide:

- dependency update PRs
- static analysis
- dependency CVE CI checks
- secret scanning
- filesystem/container-style scanning
- baseline web scanning

## Frontend

Path:

- `frontend/src/App.jsx`

Purpose:

- local operational dashboard for Commit Confessional

Main features:

- auto-polling dashboard every 5 seconds
- GitHub connect/disconnect
- proxy simulation
- clearing events
- latest receipt summary
- recent commit table with AI and Copilot percentages
- security summary with Semgrep and dependency CVEs

Main views:

- main dashboard
- GitHub login page state

Displayed data includes:

- repo name and branch
- proxy health
- recent commits
- AI and Copilot percentages
- latest detected model
- Semgrep counts and severity
- dependency CVE counts
- contributor analytics

## VS Code Extension

Path:

- `vscode-extension/extension.js`

Purpose:

- merged editor integration for both Commit Confessional and Living Codebase Narrator

Main responsibilities:

- watch AI extension activation
- inspect Copilot logs for model and tool hints
- classify inserted text as typed, pasted, or inline suggestion
- emit editor events to the backend
- maintain `.aidetector.json`
- generate preview and commit receipts
- send save diffs to the narrator backend
- host the narrator-style sidebar webview

### Extension commands

- `Commit Confessional: Show Output`
- `Commit Confessional: Inspect AI Extensions`
- `Commit Confessional: List Matching AI Extensions`
- `Commit Confessional: Debug Status Report`
- `Commit Confessional: Test Latest Receipt`
- `Commit Confessional: Preview AI Percentage`
- `LCN: Ping Backend`
- `LCN: Show Output Log`

### Commit Confessional extension features

- tracks Copilot and other configured AI extension activations
- correlates recent tool activity with pasted or inserted code
- writes JSONL event logs under the current user profile
- maintains line-level AI lineage in `.aidetector.json`
- computes repo-root-aware preview diffs
- supports single-file preview mode
- supports clean-file scanning when no git diff exists

### Narrator extension features

- stores per-file snapshots in memory
- creates unified diffs on save
- debounces delta posts to the narrator backend
- refreshes a sidebar feed of generated doc cards

### AI tagging model

Current AI tagging is not only exact-text matching.

It now uses:

- exact normalized line hashes
- structural signatures
- token fingerprints
- similarity matching for lightly edited lines
- file-level lineage fallback for AI-majority files

That design is intended to handle mixed human/AI files better than an exact-text-only model.

## Firefox Extension

Path:

- `firefox-extension/manifest.json`
- `firefox-extension/background.js`
- `firefox-extension/content.js`
- `firefox-extension/native-host.js`

Purpose:

- detect supported AI site activity in Firefox
- forward relevant data to the local backend
- bridge browser events to a native local host when needed

Observed providers and domains include:

- ChatGPT / OpenAI
- Gemini / Google
- Claude / Anthropic
- xAI

Permissions include:

- `tabs`
- `storage`
- `nativeMessaging`
- `webRequest`
- local backend URLs
- selected AI provider domains

## Root Scripts and Hooks

### `scripts/preview-receipt.js`

Purpose:

- build a working-tree or single-file preview receipt

Features:

- repo-wide diff mode
- single-file mode
- untracked file synthetic diff generation
- clean-file scan fallback when no git diff exists
- Semgrep and dependency CVE summary printing

### `scripts/post-commit-receipt.js`

Purpose:

- build a receipt for the current `HEAD` commit

Typical use:

- manual verification
- git hook automation

### `scripts/run-merged-dev.mjs`

Purpose:

- start multiple local services together

Modes:

- `narrator`
- `all`

Behavior:

- starts selected services with colored prefixed output
- skips services whose ports are already occupied

### `.githooks/post-commit`

Purpose:

- automatically run `node scripts/post-commit-receipt.js` after a commit

## Living Codebase Narrator Workspace

Path:

- `living-codebase-narrator/living-codebase-narrator/living-codebase-narrator/`

This workspace remains mostly self-contained and has its own packages.

### Internal workspace layout

- `apps/backend`
- `apps/web`
- `apps/extension`
- `packages/types`
- `spacetime/server`

### Narrator backend

Path:

- `apps/backend/src/server.ts`

Purpose:

- accept code deltas
- generate doc entries
- persist entries locally
- optionally persist to MongoDB
- optionally synthesize audio

Important routes:

- `GET /health`
- `GET /docs`
- `POST /deltas`
- `GET /audio/:filename`
- `POST /docs/:id/vote`
- `POST /docs/:id/annotations`
- `POST /debug/gemini`
- `GET /debug/integrations`

Generation path:

1. validate delta with `zod`
2. append delta to JSONL store
3. call Gemini if configured
4. fall back to local summarization if needed
5. build a `DocEntry`
6. optionally generate ElevenLabs audio
7. append the document entry to JSONL
8. optionally upsert to MongoDB

### Narrator web app

Path:

- `apps/web/src/ui/App.tsx`

Purpose:

- render a live documentation feed
- poll `/health` and `/docs`
- play latest audio when available
- support voting on entries

### Narrator VS Code extension

Path:

- `apps/extension/src/extension.ts`

Purpose:

- original narrator-only editor integration

It is simpler than the merged root extension and focuses on:

- save-based diff capture
- delta posting
- sidebar display
- health check and log commands

### Shared types

Path:

- `packages/types/src/index.ts`

Purpose:

- shared TypeScript types for:
  - `CodeDelta`
  - `DocEntry`
  - health payloads

### SpacetimeDB module

Path:

- `spacetime/server/`

Purpose:

- optional realtime/server-side integration point for the narrator workspace

## Persistence Model

### Commit Confessional persistence

- `.aidetector.json`
  Local AI lineage store. Used for per-file and per-line attribution.
- `backend/data/proxy-events.json`
  Stored normalized captures.
- `backend/data/latest-receipt.json`
  Latest receipt payload.
- `backend/data/receipt-history.json`
  Commit receipt history.
- `backend/data/github-session.json`
  OAuth session cache.

### Narrator persistence

Under narrator `LOCAL_DATA_DIR`:

- `deltas.jsonl`
- `docs.jsonl`
- audio files

Optional additional persistence:

- MongoDB collection `doc_entries`

## Local Logs and Evidence Sources

### Editor/browser evidence files

User-level logs include:

- `~/.cc-vscode-log.jsonl`
- `~/.cc-firefox-log.jsonl`

These are used by the backend receipt engine together with backend capture history and `.aidetector.json`.

## Typical Developer Workflows

### Preview AI attribution for current changes

```powershell
node scripts/preview-receipt.js
```

### Preview one file only

```powershell
node scripts/preview-receipt.js path/to/file.js
```

If the file has no git diff, the script falls back to a clean-file scan.

### Generate a receipt for the latest commit

```powershell
node scripts/post-commit-receipt.js
```

### Run security coverage manually

```powershell
npm run security:audit:deps
node scripts/preview-receipt.js vscode-extension/demo-web-risks.js
```

### Run the narrator side

```powershell
npm run dev:narrator:backend
npm run dev:narrator:web
```

## Known Boundaries and Limitations

- The repository is a merge of two systems, not a fully unified platform yet.
- The main dashboard and narrator UI are still separate applications.
- AI attribution is heuristic, not legally authoritative.
- Dependency CVEs are project-level, not file-level.
- Browser prompt inspection is strongest in simulated or explicit capture paths unless the local MITM proxy is enabled and trusted.
- GitHub OAuth does not provide reliable per-device active-session location tracking.
- Static analysis can be widened, but no setup can guarantee every possible future CVE.

## Recommended Reading Order

If you are new to the repo, read files in this order:

1. `readme.md`
2. `package.json`
3. `backend/src/server.js`
4. `backend/src/services/modelEvidence.js`
5. `backend/src/services/receiptIntegrations.js`
6. `frontend/src/App.jsx`
7. `vscode-extension/extension.js`
8. `scripts/preview-receipt.js`
9. `living-codebase-narrator/.../apps/backend/src/server.ts`
10. `living-codebase-narrator/.../apps/web/src/ui/App.tsx`

## Short Summary

This codebase is a local-first developer observability workspace.

- Commit Confessional measures AI provenance and code risk around repo changes.
- Living Codebase Narrator turns saved diffs into explainable documentation.
- The VS Code extension is the main integration point that connects both systems.
- The backend is the correlation engine.
- The frontend is the operator dashboard.
- Security findings come from Semgrep, dependency audit, and GitHub automation.
