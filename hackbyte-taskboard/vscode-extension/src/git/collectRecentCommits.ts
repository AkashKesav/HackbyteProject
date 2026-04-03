import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CollectedCommitContext, RecentCommitEvidence } from '../types';

const execFileAsync = promisify(execFile);
const RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';

export async function resolveGitRepoRoot(workspacePath: string): Promise<string> {
  return runGit(workspacePath, ['rev-parse', '--show-toplevel']);
}

export async function collectRecentCommits(
  repoRoot: string,
  limit: number,
  maxDiffChars: number
): Promise<CollectedCommitContext> {
  const branch = (await runGit(repoRoot, ['branch', '--show-current'])) || 'HEAD';
  const logOutput = await runGit(repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--date=iso-strict',
    `--pretty=format:${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%cI`,
    '--name-only',
    '--no-renames',
  ]);

  const commits: RecentCommitEvidence[] = [];

  for (const block of logOutput.split(RECORD_SEPARATOR)) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }

    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const [hash = '', subject = '', committedAt = ''] = lines[0].split(FIELD_SEPARATOR);
    if (!hash || !subject) {
      continue;
    }

    const changedFiles = lines.slice(1).map(line => line.trim()).filter(Boolean);
    const diffSummary = await runGit(repoRoot, [
      'show',
      '--stat',
      '--summary',
      '--format=',
      '--no-renames',
      '--no-ext-diff',
      hash,
    ]);

    commits.push({
      hash,
      subject,
      committedAt,
      changedFiles,
      diffSummary: truncate(diffSummary, maxDiffChars),
    });
  }

  return {
    repoRoot,
    branch,
    commits,
  };
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024 * 8,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed in ${repoRoot}: git ${args.join(' ')}\n${detail}`);
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}\n[truncated]`;
}
