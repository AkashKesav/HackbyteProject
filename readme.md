# CodeTruth + Living Codebase Narrator

This repository now hosts both hackathon projects in one place:

- `HackbyteProject` remains the AI provenance tracker that captures model usage, proxy events, and commit evidence.
- `living-codebase-narrator` is included as a companion system that turns code deltas into narrated documentation cards.

## Full Documentation

For a detailed architecture and codebase guide, see:

- `docs/CODEBASE_GUIDE.md`

## Repo Layout

- `backend/`: Commit Confessional / CodeTruth backend
- `frontend/`: Commit Confessional dashboard
- `firefox-extension/`: browser capture integration
- `vscode-extension/`: local editor integration
- `living-codebase-narrator/living-codebase-narrator/living-codebase-narrator/`: imported narrator workspace

The narrator workspace keeps its original internal layout:

- `apps/backend`: delta-to-doc backend
- `apps/web`: live documentation feed
- `apps/extension`: VS Code extension
- `packages/types`: shared types
- `spacetime/server`: SpacetimeDB module

## What Each Project Does

### CodeTruth

- Detects AI tool usage near the source
- Stores prompt and proxy evidence
- Correlates captures to repository context
- Surfaces contribution and risk signals in a dashboard

### Living Codebase Narrator

- Accepts code delta events
- Generates narrative documentation entries
- Exposes a live web feed for teammates
- Supports optional audio narration and SpacetimeDB integration

## Root Commands

Install and run the original Hackbyte app:

```powershell
npm install
npm run dev:backend
npm run dev:frontend
```

Run the imported narrator services from this same repo root:

```powershell
npm run dev:narrator:backend
npm run dev:narrator:web
```

Run both narrator services together:

```powershell
npm run dev:narrator
```

Run both Hackbyte services and both narrator services together:

```powershell
npm run dev:all
```

Build the two web apps separately:

```powershell
npm run build
npm run build:narrator:web
```

## Current Merge Shape

This is a repository merge, not a full product fusion yet. Both apps now live in one codebase with shared root-level commands, but their APIs and UIs are still separate:

- CodeTruth backend defaults to `http://localhost:4000`
- Narrator backend keeps its own backend inside the imported workspace

That keeps both projects runnable while leaving room for a later phase where:

1. the narrator feed can be embedded into the main dashboard
2. proxy captures can generate narrated documentation automatically
3. contributor evidence and live code narration can share one backend contract
