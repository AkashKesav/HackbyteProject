import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { EXCLUDED_DIRECTORIES } from '../constants';
import type { RecentCommitEvidence, RecentDocumentEvidence } from '../types';

export async function collectRecentDocs(
  repoRoot: string,
  commits: RecentCommitEvidence[],
  lookbackHours: number,
  maxDocs: number,
  maxExcerptChars: number
): Promise<RecentDocumentEvidence[]> {
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const commitTouchMap = new Map<string, string[]>();
  const candidatePaths = new Set<string>();

  for (const commit of commits) {
    for (const changedFile of commit.changedFiles) {
      if (!isLikelyDocFile(changedFile)) {
        continue;
      }

      candidatePaths.add(changedFile);
      const hashes = commitTouchMap.get(changedFile) ?? [];
      hashes.push(commit.hash);
      commitTouchMap.set(changedFile, hashes);
    }
  }

  await walkForRecentDocs(repoRoot, repoRoot, cutoff, candidatePaths);

  const docs: RecentDocumentEvidence[] = [];

  for (const relativePath of candidatePaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        continue;
      }

      const content = await readFile(absolutePath, 'utf8');
      const excerpt = content.trim().slice(0, maxExcerptChars).trim();
      if (!excerpt) {
        continue;
      }

      docs.push({
        relativePath: toPosixPath(relativePath),
        modifiedAt: fileStat.mtime.toISOString(),
        excerpt,
        relatedCommitHashes: commitTouchMap.get(relativePath) ?? [],
        source: 'workspace',
      });
    } catch {
      // Ignore deleted or unreadable files.
    }
  }

  docs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return docs.slice(0, maxDocs);
}

async function walkForRecentDocs(
  repoRoot: string,
  currentPath: string,
  cutoff: number,
  candidatePaths: Set<string>
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = toPosixPath(path.relative(repoRoot, absolutePath));

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(relativePath) || EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await walkForRecentDocs(repoRoot, absolutePath, cutoff, candidatePaths);
      continue;
    }

    if (!entry.isFile() || !isLikelyDocFile(relativePath)) {
      continue;
    }

    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.mtimeMs >= cutoff) {
        candidatePaths.add(relativePath);
      }
    } catch {
      // Skip entries that disappear during the scan.
    }
  }
}

function isLikelyDocFile(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath);
  const lower = normalized.toLowerCase();
  const extension = path.extname(lower);
  const baseName = path.basename(lower);

  if (baseName.startsWith('readme')) {
    return true;
  }

  if (extension === '.md' || extension === '.mdx') {
    return true;
  }

  if (extension === '.txt') {
    return lower.includes('/docs/') || lower.includes('/spec') || lower.includes('/notes/');
  }

  return false;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}
