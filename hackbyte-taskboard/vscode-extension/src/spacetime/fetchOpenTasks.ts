import {
  decodeIdentity,
  decodeOptionString,
  decodeTimestampToIso,
  executeSql,
  mapSqlRows,
} from './client';
import type { ExtensionConfig, OpenTask, TaskStatus } from '../types';

export async function fetchOpenTasks(config: ExtensionConfig): Promise<OpenTask[]> {
  const response = await executeSql(config, 'SELECT * FROM task');
  const rows = mapSqlRows(response);

  return rows
    .map(row => toTask(row))
    .filter(task => task.status !== 'done')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function toTask(row: Record<string, unknown>): OpenTask {
  return {
    id: Number(row.id),
    title: String(row.title ?? ''),
    status: normalizeStatus(row.status),
    source: String(row.source ?? 'manual'),
    commitHash: decodeOptionString(row.commit_hash),
    context: String(row.context ?? ''),
    createdAt: decodeTimestampToIso(row.created_at) ?? new Date(0).toISOString(),
    authorIdentity: decodeIdentity(row.author_identity),
    resolutionKind: String(row.resolution_kind ?? 'unresolved'),
    resolutionSource: String(row.resolution_source ?? 'unresolved'),
    resolutionContext: String(row.resolution_context ?? ''),
    resolutionCommitHash: String(row.resolution_commit_hash ?? ''),
    resolutionDocumentRefs: Array.isArray(row.resolution_document_refs)
      ? row.resolution_document_refs.map(value => String(value))
      : [],
  };
}

function normalizeStatus(value: unknown): TaskStatus {
  const normalized = String(value ?? 'todo').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'done' || normalized === 'in_progress') {
    return normalized;
  }

  return 'todo';
}
