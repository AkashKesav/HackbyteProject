import path from 'node:path';
import type {
  OpenTask,
  RecentCommitEvidence,
  RecentDocumentEvidence,
  ResolutionCandidate,
} from '../types';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'board',
  'build',
  'change',
  'changes',
  'close',
  'code',
  'complete',
  'completed',
  'create',
  'current',
  'done',
  'feature',
  'file',
  'files',
  'fix',
  'for',
  'from',
  'function',
  'functions',
  'implementation',
  'implemented',
  'implementing',
  'in',
  'is',
  'item',
  'manual',
  'new',
  'of',
  'on',
  'open',
  'progress',
  'release',
  'review',
  'task',
  'the',
  'this',
  'todo',
  'under',
  'update',
  'work',
]);

export function buildFallbackCandidates({
  openTasks,
  commits,
  documents,
  confidenceThreshold,
}: {
  openTasks: OpenTask[];
  commits: RecentCommitEvidence[];
  documents: RecentDocumentEvidence[];
  confidenceThreshold: number;
}): ResolutionCandidate[] {
  const documentTokenMap = new Map(
    documents.map(document => [document.relativePath, tokenize(`${document.relativePath}\n${document.excerpt}`)])
  );

  const candidates: ResolutionCandidate[] = [];

  for (const task of openTasks) {
    const taskTokens = tokenize(`${task.title}\n${task.context}`);
    if (taskTokens.size === 0) {
      continue;
    }

    let best: ResolutionCandidate | undefined;
    let bestScore = -1;

    for (const commit of commits) {
      const subjectTokens = tokenize(commit.subject);
      const fileTokens = tokenize(commit.changedFiles.join('\n'));
      const diffTokens = tokenize(commit.diffSummary);

      const subjectOverlap = intersect(taskTokens, subjectTokens);
      const fileOverlap = intersect(taskTokens, fileTokens);
      const diffOverlap = intersect(taskTokens, diffTokens);

      const relatedDocs = documents.filter(document =>
        document.relatedCommitHashes.includes(commit.hash)
      );
      const matchingDocRefs = relatedDocs
        .filter(document => intersect(taskTokens, documentTokenMap.get(document.relativePath) ?? new Set()).size > 0)
        .map(document => document.relativePath);

      const distinctOverlap = new Set([
        ...subjectOverlap,
        ...fileOverlap,
        ...diffOverlap,
        ...matchingDocRefs.flatMap(ref => Array.from(intersect(taskTokens, documentTokenMap.get(ref) ?? new Set()))),
      ]);

      if (distinctOverlap.size === 0) {
        continue;
      }

      const domainOverlap = Array.from(distinctOverlap).filter(token => !STOPWORDS.has(token));
      if (domainOverlap.length === 0) {
        continue;
      }

      const score =
        domainOverlap.length * 3 +
        subjectOverlap.size * 3 +
        fileOverlap.size * 2 +
        diffOverlap.size +
        matchingDocRefs.length * 2;

      const confidence = Math.min(
        0.9,
        0.58 +
          Math.min(domainOverlap.length, 3) * 0.08 +
          (subjectOverlap.size > 0 ? 0.11 : 0) +
          (fileOverlap.size > 0 ? 0.08 : 0) +
          (matchingDocRefs.length > 0 ? 0.07 : 0)
      );

      if (confidence < confidenceThreshold || score < 5) {
        continue;
      }

      const candidate: ResolutionCandidate = {
        taskId: task.id,
        shouldClose: true,
        confidence,
        reason: `Fallback matcher found strong overlap between task keywords (${domainOverlap.slice(0, 4).join(', ')}) and recent commit evidence.`,
        commitHash: commit.hash,
        documentRefs: matchingDocRefs,
        evidenceSummary: buildEvidenceSummary(commit, matchingDocRefs),
        matchedSignals: domainOverlap.slice(0, 6),
      };

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (best) {
      candidates.push(best);
    }
  }

  return candidates;
}

function buildEvidenceSummary(
  commit: RecentCommitEvidence,
  matchingDocRefs: string[]
): string {
  const fileSample = commit.changedFiles
    .slice(0, 3)
    .map(file => path.basename(file))
    .join(', ');

  const parts = [
    `commit ${commit.hash.slice(0, 8)}: ${commit.subject}`,
    fileSample ? `files ${fileSample}` : '',
    matchingDocRefs.length > 0 ? `docs ${matchingDocRefs.join(', ')}` : '',
  ].filter(Boolean);

  return parts.join(' | ');
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map(token => token.trim())
      .filter(token => token.length >= 3)
      .filter(token => !STOPWORDS.has(token))
  );
}

function intersect(left: Set<string>, right: Set<string>): Set<string> {
  const next = new Set<string>();

  for (const value of left) {
    if (right.has(value)) {
      next.add(value);
    }
  }

  return next;
}
