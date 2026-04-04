# SpacetimeDB layer (skeleton)

This repo includes a **TypeScript SpacetimeDB module skeleton** in `spacetime/server`.

## What’s here

- Tables:
  - `code_deltas`
  - `doc_entries`
  - `doc_annotations` (per-note rows; `doc_entries` stays the main doc row)
- Reducers (client-callable):
  - `submit_code_delta` — insert a code delta row
  - `upsert_doc_entry` — insert or replace a doc entry by `id`
  - `vote_doc_entry` — params: `docEntryId`, `direction` (`up` | `down`), `updatedAt` (ISO string)
  - `add_annotation` — insert into `doc_annotations`
  - `set_doc_status` — update `doc_entries.status`
- Module entrypoint: `spacetime/server/src/index.ts`

## Generating TypeScript client bindings (optional)

If you have the SpacetimeDB CLI installed:

```powershell
spacetime generate --lang typescript --out-dir "apps/web/src/module_bindings" --module-path "spacetime/server"
```

This MVP keeps `apps/web` typechecking even before bindings are generated.

