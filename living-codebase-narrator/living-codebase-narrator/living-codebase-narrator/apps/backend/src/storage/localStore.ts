import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function appendJsonl<T>(filePath: string, obj: T) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

export function readJsonl<T>(filePath: string, maxLines: number | null = null): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const sliced = maxLines ? lines.slice(Math.max(0, lines.length - maxLines)) : lines;
  const out: T[] = [];
  for (const l of sliced) {
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

