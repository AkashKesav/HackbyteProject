// SpacetimeDB TypeScript module: tables + reducers for deltas, docs, votes, annotations, status.
// Run/publish with the SpacetimeDB CLI; client bindings: `spacetime generate` (see ../README.md).

import { t, table, schema } from 'spacetimedb/server';

const code_deltas = table(
  { name: 'code_deltas', public: true },
  {
    id: t.string().primaryKey(),
    sessionId: t.string(),
    author: t.string(),
    filePath: t.string(),
    language: t.string(),
    diff: t.string(),
    context: t.string(),
    changedLines: t.u32(),
    source: t.string(),
    repo: t.option(t.string()),
    branch: t.option(t.string()),
    status: t.string(),
    createdAt: t.string(),
    updatedAt: t.string()
  }
);

const doc_entries = table(
  { name: 'doc_entries', public: true },
  {
    id: t.string().primaryKey(),
    deltaId: t.string().index(),
    sessionId: t.string(),
    author: t.string(),
    filePath: t.string(),
    language: t.string(),
    diff: t.string(),
    context: t.string(),
    summary: t.string(),
    whatChanged: t.array(t.string()),
    whyItMatters: t.array(t.string()),
    tags: t.array(t.string()),
    audioUrl: t.option(t.string()),
    votesUp: t.u32(),
    votesDown: t.u32(),
    status: t.string(),
    source: t.string(),
    createdAt: t.string(),
    updatedAt: t.string()
  }
);

const doc_annotations = table(
  { name: 'doc_annotations', public: true },
  {
    id: t.string().primaryKey(),
    docEntryId: t.string().index(),
    author: t.string(),
    text: t.string(),
    createdAt: t.string()
  }
);

const spacetimedb = schema({ code_deltas, doc_entries, doc_annotations });

export const submit_code_delta = spacetimedb.reducer(
  {
    id: t.string(),
    sessionId: t.string(),
    author: t.string(),
    filePath: t.string(),
    language: t.string(),
    diff: t.string(),
    context: t.string(),
    changedLines: t.u32(),
    source: t.string(),
    repo: t.option(t.string()),
    branch: t.option(t.string()),
    status: t.string(),
    createdAt: t.string(),
    updatedAt: t.string()
  },
  (ctx, p) => {
    ctx.db.code_deltas.insert({
      id: p.id,
      sessionId: p.sessionId,
      author: p.author,
      filePath: p.filePath,
      language: p.language,
      diff: p.diff,
      context: p.context,
      changedLines: p.changedLines,
      source: p.source,
      repo: p.repo,
      branch: p.branch,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    });
  }
);

export const upsert_doc_entry = spacetimedb.reducer(
  {
    id: t.string(),
    deltaId: t.string(),
    sessionId: t.string(),
    author: t.string(),
    filePath: t.string(),
    language: t.string(),
    diff: t.string(),
    context: t.string(),
    summary: t.string(),
    whatChanged: t.array(t.string()),
    whyItMatters: t.array(t.string()),
    tags: t.array(t.string()),
    audioUrl: t.option(t.string()),
    votesUp: t.u32(),
    votesDown: t.u32(),
    status: t.string(),
    source: t.string(),
    createdAt: t.string(),
    updatedAt: t.string()
  },
  (ctx, p) => {
    const row = {
      id: p.id,
      deltaId: p.deltaId,
      sessionId: p.sessionId,
      author: p.author,
      filePath: p.filePath,
      language: p.language,
      diff: p.diff,
      context: p.context,
      summary: p.summary,
      whatChanged: p.whatChanged,
      whyItMatters: p.whyItMatters,
      tags: p.tags,
      audioUrl: p.audioUrl,
      votesUp: p.votesUp,
      votesDown: p.votesDown,
      status: p.status,
      source: p.source,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
    const existing = ctx.db.doc_entries.id.find(p.id);
    if (existing == null) {
      ctx.db.doc_entries.insert(row);
    } else {
      ctx.db.doc_entries.id.update(row);
    }
  }
);

export const vote_doc_entry = spacetimedb.reducer(
  {
    docEntryId: t.string(),
    direction: t.string(),
    updatedAt: t.string()
  },
  (ctx, p) => {
    const row = ctx.db.doc_entries.id.find(p.docEntryId);
    if (row == null) return;
    const up = p.direction === 'up' ? row.votesUp + 1 : row.votesUp;
    const down = p.direction === 'down' ? row.votesDown + 1 : row.votesDown;
    ctx.db.doc_entries.id.update({
      id: row.id,
      deltaId: row.deltaId,
      sessionId: row.sessionId,
      author: row.author,
      filePath: row.filePath,
      language: row.language,
      diff: row.diff,
      context: row.context,
      summary: row.summary,
      whatChanged: row.whatChanged,
      whyItMatters: row.whyItMatters,
      tags: row.tags,
      audioUrl: row.audioUrl,
      votesUp: up,
      votesDown: down,
      status: row.status,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: p.updatedAt
    });
  }
);

export const add_annotation = spacetimedb.reducer(
  {
    id: t.string(),
    docEntryId: t.string(),
    author: t.string(),
    text: t.string(),
    createdAt: t.string()
  },
  (ctx, p) => {
    ctx.db.doc_annotations.insert({
      id: p.id,
      docEntryId: p.docEntryId,
      author: p.author,
      text: p.text,
      createdAt: p.createdAt
    });
  }
);

export const set_doc_status = spacetimedb.reducer(
  {
    docEntryId: t.string(),
    status: t.string(),
    updatedAt: t.string()
  },
  (ctx, p) => {
    const row = ctx.db.doc_entries.id.find(p.docEntryId);
    if (row == null) return;
    ctx.db.doc_entries.id.update({
      id: row.id,
      deltaId: row.deltaId,
      sessionId: row.sessionId,
      author: row.author,
      filePath: row.filePath,
      language: row.language,
      diff: row.diff,
      context: row.context,
      summary: row.summary,
      whatChanged: row.whatChanged,
      whyItMatters: row.whyItMatters,
      tags: row.tags,
      audioUrl: row.audioUrl,
      votesUp: row.votesUp,
      votesDown: row.votesDown,
      status: p.status,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: p.updatedAt
    });
  }
);

export default spacetimedb;
