import type { DocEntry } from '@lcn/types';

/** JSONL may contain multiple revisions of the same doc id; keep the latest by `updatedAt`. */
export function mergeLatestDocsById(rows: DocEntry[]): DocEntry[] {
  const byId = new Map<string, DocEntry>();
  for (const row of rows) {
    const prev = byId.get(row.id);
    if (!prev || new Date(row.updatedAt).getTime() >= new Date(prev.updatedAt).getTime()) {
      byId.set(row.id, row);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function findLatestDocById(rows: DocEntry[], id: string): DocEntry | undefined {
  let best: DocEntry | undefined;
  for (const row of rows) {
    if (row.id !== id) continue;
    if (!best || new Date(row.updatedAt).getTime() >= new Date(best.updatedAt).getTime()) {
      best = row;
    }
  }
  return best;
}
