import path from 'node:path';
import { DEFAULT_BOARD_URL, DEFAULT_DATABASE_NAME, DEFAULT_GEMINI_MODEL, DEFAULT_SPACETIME_HTTP_URL } from '../constants';
import { collectRecentDocs } from '../docs/collectRecentDocs';
import { inferTaskResolutions } from '../gemini/client';
import { collectRecentCommits } from '../git/collectRecentCommits';
import { fetchOpenTasks } from '../spacetime/fetchOpenTasks';
import { resolveTasks } from '../spacetime/resolveTasks';
import type { ExtensionConfig, OpenTask, ResolutionCandidate } from '../types';

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Set GEMINI_API_KEY before running the smoke script.');
  }

  const repoRoot = path.resolve(process.env.REPO_ROOT ?? path.join(process.cwd(), '..'));
  const config: ExtensionConfig = {
    spacetimeHttpUrl: process.env.SPACETIME_HTTP_URL?.trim() || DEFAULT_SPACETIME_HTTP_URL,
    databaseName: process.env.SPACETIME_DB_NAME?.trim() || DEFAULT_DATABASE_NAME,
    boardUrl: process.env.BOARD_URL?.trim() || DEFAULT_BOARD_URL,
    geminiModel: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    recentCommitCount: integerEnv('RECENT_COMMIT_COUNT', 8),
    recentDocLookbackHours: integerEnv('RECENT_DOC_LOOKBACK_HOURS', 24),
    confidenceThreshold: numberEnv('CONFIDENCE_THRESHOLD', 0.76),
    maxCommitDiffChars: integerEnv('MAX_COMMIT_DIFF_CHARS', 1400),
    maxDocumentExcerptChars: integerEnv('MAX_DOCUMENT_EXCERPT_CHARS', 2600),
    maxRecentDocs: integerEnv('MAX_RECENT_DOCS', 8),
  };

  const openTasks = await fetchOpenTasks(config);
  const commitContext = await collectRecentCommits(
    repoRoot,
    config.recentCommitCount,
    config.maxCommitDiffChars
  );
  const documents = await collectRecentDocs(
    repoRoot,
    commitContext.commits,
    config.recentDocLookbackHours,
    config.maxRecentDocs,
    config.maxDocumentExcerptChars
  );

  const geminiResponse = await inferTaskResolutions({
    apiKey,
    model: config.geminiModel,
    branch: commitContext.branch,
    openTasks,
    commits: commitContext.commits,
    documents,
  });

  const vettedCandidates = vetCandidates({
    openTasks,
    candidates: geminiResponse.candidates,
    confidenceThreshold: config.confidenceThreshold,
    commitHashes: new Set(commitContext.commits.map(commit => commit.hash)),
    documentRefs: new Set(documents.map(document => document.relativePath)),
  });

  console.log(
    JSON.stringify(
      {
        repoRoot,
        branch: commitContext.branch,
        openTaskCount: openTasks.length,
        commitCount: commitContext.commits.length,
        documentCount: documents.length,
        candidates: vettedCandidates,
      },
      null,
      2
    )
  );

  if (process.env.APPLY_RESOLUTIONS === '1' && vettedCandidates.length > 0) {
    await resolveTasks(config, vettedCandidates);
    console.log(`Applied ${vettedCandidates.length} resolution(s).`);
  }
}

function vetCandidates({
  openTasks,
  candidates,
  confidenceThreshold,
  commitHashes,
  documentRefs,
}: {
  openTasks: OpenTask[];
  candidates: ResolutionCandidate[];
  confidenceThreshold: number;
  commitHashes: Set<string>;
  documentRefs: Set<string>;
}): ResolutionCandidate[] {
  const openTaskIds = new Set(openTasks.map(task => task.id));
  const seenTaskIds = new Set<number>();

  return candidates
    .map(candidate => ({
      ...candidate,
      reason: candidate.reason.trim(),
      commitHash: candidate.commitHash?.trim(),
      documentRefs: candidate.documentRefs
        .map(ref => ref.trim())
        .filter(ref => ref.length > 0 && documentRefs.has(ref)),
      matchedSignals: candidate.matchedSignals.map(signal => signal.trim()).filter(Boolean),
      evidenceSummary: candidate.evidenceSummary.trim(),
    }))
    .filter(candidate => candidate.shouldClose)
    .filter(candidate => candidate.reason.length > 0)
    .filter(candidate => candidate.confidence >= confidenceThreshold)
    .filter(candidate => openTaskIds.has(candidate.taskId))
    .filter(candidate => {
      if (candidate.commitHash && !commitHashes.has(candidate.commitHash)) {
        candidate.commitHash = undefined;
      }
      return true;
    })
    .filter(candidate => {
      if (seenTaskIds.has(candidate.taskId)) {
        return false;
      }

      seenTaskIds.add(candidate.taskId);
      return true;
    });
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
