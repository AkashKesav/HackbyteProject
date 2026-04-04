import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { CodeDelta, DocEntry, HealthResponse } from '@lcn/types';
import { env } from './env.js';
import { appendJsonl, readJsonl, ensureDir } from './storage/localStore.js';
import { findLatestDocById, mergeLatestDocsById } from './docsMerge.js';
import { generateDocsWithGemini, isGeminiConfigured, isHuggingFaceConfigured, llmState } from './integrations/gemini.js';
import { isElevenLabsConfigured, synthesizeHeadingAudio } from './integrations/elevenlabs.js';
import { fallbackDocFromDiff } from './fallback.js';
import { getMongoClient, isMongoConfigured, mongoState } from './integrations/mongo.js';
import { isSpacetimeConfigured } from './integrations/spacetime.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const dataDir = path.resolve(process.cwd(), env.LOCAL_DATA_DIR);
const deltasFile = path.join(dataDir, 'deltas.jsonl');
const docsFile = path.join(dataDir, 'docs.jsonl');
ensureDir(dataDir);

const DeltaSchema = z.object({
  sessionId: z.string().min(1),
  author: z.string().min(1),
  filePath: z.string().min(1),
  language: z.string().min(1),
  diff: z.string().min(1),
  context: z.string().default(''),
  changedLines: z.number().int().nonnegative(),
  source: z.literal('vscode'),
  repo: z.string().optional(),
  branch: z.string().optional()
});

function nowIso() {
  return new Date().toISOString();
}


async function persistDocEntryMongo(doc: DocEntry) {
  const client = await getMongoClient();
  if (!client || !mongoState().connected) return;
  try {
    const db = client.db(env.MONGODB_DB);
    await db.collection('doc_entries').updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
  } catch (error) {
    console.warn('[lcn-backend] mongo persist failed', String(error));
  }
}

app.get('/health', async (_req, res) => {
  const configured = {
    gemini: { configured: isGeminiConfigured() },
    huggingface: { configured: isHuggingFaceConfigured() },
    elevenlabs: { configured: isElevenLabsConfigured(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID) },
    mongodb: { configured: isMongoConfigured(), connected: mongoState().connected },
    spacetime: { configured: isSpacetimeConfigured() }
  };
  if (configured.mongodb.configured && !configured.mongodb.connected) {
    await getMongoClient();
    configured.mongodb.connected = mongoState().connected;
  }
  const payload: HealthResponse = { ok: true, time: nowIso(), integrations: configured };
  res.json(payload);
});

app.get('/docs', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const all = readJsonl<DocEntry>(docsFile, null);
  const merged = mergeLatestDocsById(all);
  res.json({ ok: true, docs: merged.slice(0, limit) });
});

app.post('/deltas', async (req, res) => {
  const parsed = DeltaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const t = nowIso();
  const delta: CodeDelta = {
    id: nanoid(),
    sessionId: parsed.data.sessionId,
    author: parsed.data.author,
    filePath: parsed.data.filePath,
    language: parsed.data.language,
    diff: parsed.data.diff,
    context: parsed.data.context ?? '',
    changedLines: parsed.data.changedLines,
    source: 'vscode',
    repo: parsed.data.repo,
    branch: parsed.data.branch,
    status: 'new',
    createdAt: t,
    updatedAt: t
  };
  appendJsonl(deltasFile, delta);

  let summary: string;
  let whatChanged: string[];
  let whyItMatters: string[];
  let tags: string[];
  try {
    const gem = await generateDocsWithGemini({
      filePath: delta.filePath,
      language: delta.language,
      diff: delta.diff,
      context: delta.context
    });
    summary = gem.summary;
    whatChanged = gem.what_changed;
    whyItMatters = gem.why_it_matters;
    tags = gem.tags;
  } catch (error) {
    console.warn('[lcn-backend] llm generation failed, using fallback', String(error));
    const fb = fallbackDocFromDiff({
      filePath: delta.filePath,
      diff: delta.diff,
      changedLines: delta.changedLines
    });
    summary = fb.summary;
    whatChanged = fb.whatChanged;
    whyItMatters = fb.whyItMatters;
    tags = fb.tags;
  }

  const doc: DocEntry = {
    id: nanoid(),
    deltaId: delta.id,
    sessionId: delta.sessionId,
    author: delta.author,
    filePath: delta.filePath,
    language: delta.language,
    lines: null,
    diff: delta.diff,
    context: delta.context,
    summary,
    whatChanged,
    whyItMatters,
    tags,
    audioUrl: null,
    votes: { up: 0, down: 0 },
    annotations: [],
    status: 'published',
    source: 'vscode',
    createdAt: t,
    updatedAt: t
  };

  try {
    doc.audioUrl = await synthesizeHeadingAudio({
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      headingPrefix: env.NARRATOR_HEADING_PREFIX,
      summary: doc.summary,
      docId: doc.id
    });
  } catch (error) {
    console.warn('[lcn-backend] elevenlabs synthesis failed', String(error));
  }

  appendJsonl(docsFile, doc);
  void persistDocEntryMongo(doc);
  res.json({ ok: true, delta, doc });
});

app.get('/audio/:filename', (req, res) => {
  const filePath = path.resolve(process.cwd(), '.data', 'audio', req.params.filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).end('Not found');
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'audio/mpeg');
  fs.createReadStream(filePath).pipe(res);
});

app.post('/docs/:id/vote', (req, res) => {
  const id = String(req.params.id);
  const body = z.object({ direction: z.enum(['up', 'down']) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false });
    return;
  }
  const docs = readJsonl<DocEntry>(docsFile, null);
  const d = findLatestDocById(docs, id);
  if (!d) {
    res.status(404).json({ ok: false });
    return;
  }
  if (body.data.direction === 'up') d.votes.up += 1;
  else d.votes.down += 1;
  d.updatedAt = nowIso();
  // append an updated version (jsonl acts like an event log)
  appendJsonl(docsFile, d);
  void persistDocEntryMongo(d);
  res.json({ ok: true, doc: d });
});

app.post('/docs/:id/annotations', (req, res) => {
  const id = String(req.params.id);
  const body = z
    .object({ author: z.string().min(1), text: z.string().min(1).max(2000) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false });
    return;
  }
  const docs = readJsonl<DocEntry>(docsFile, null);
  const d = findLatestDocById(docs, id);
  if (!d) {
    res.status(404).json({ ok: false });
    return;
  }
  d.annotations.push({ id: nanoid(), author: body.data.author, text: body.data.text, createdAt: nowIso() });
  d.updatedAt = nowIso();
  appendJsonl(docsFile, d);
  void persistDocEntryMongo(d);
  res.json({ ok: true, doc: d });
});

app.post('/debug/gemini', async (req, res) => {
  try {
    const body = z
      .object({
        filePath: z.string().default('demo.ts'),
        language: z.string().default('typescript'),
        diff: z.string().default(''),
        context: z.string().default('')
      })
      .parse(req.body ?? {});
    const out = await generateDocsWithGemini(body);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/debug/integrations', async (_req, res) => {
  if (isMongoConfigured() && !mongoState().connected) {
    await getMongoClient();
  }

  res.json({
    ok: true,
    llm: {
      configured: {
        huggingface: isHuggingFaceConfigured(),
        gemini: isGeminiConfigured()
      },
      state: llmState()
    },
    elevenlabs: {
      configured: isElevenLabsConfigured(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID)
    },
    mongodb: {
      configured: isMongoConfigured(),
      state: mongoState()
    },
    spacetime: {
      configured: isSpacetimeConfigured()
    }
  });
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[lcn-backend] listening on http://localhost:${env.PORT}`);
});


