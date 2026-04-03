import type {
  OpenTask,
  RecentCommitEvidence,
  RecentDocumentEvidence,
} from '../types';

export function buildResolutionPrompt({
  branch,
  openTasks,
  commits,
  documents,
}: {
  branch: string;
  openTasks: OpenTask[];
  commits: RecentCommitEvidence[];
  documents: RecentDocumentEvidence[];
}): string {
  const payload = {
    branch,
    openTasks: openTasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      source: task.source,
      commitHash: task.commitHash,
      context: task.context,
    })),
    recentCommits: commits.map(commit => ({
      hash: commit.hash,
      subject: commit.subject,
      committedAt: commit.committedAt,
      changedFiles: commit.changedFiles,
      diffSummary: commit.diffSummary,
    })),
    recentDocuments: documents.map(document => ({
      relativePath: document.relativePath,
      modifiedAt: document.modifiedAt,
      relatedCommitHashes: document.relatedCommitHashes,
      excerpt: document.excerpt,
    })),
  };

  return [
    'You are matching recent engineering work to existing open tasks on a collaborative dev board.',
    'Return only JSON that matches the requested schema.',
    'Rules:',
    '- Never invent new tasks.',
    '- Only recommend closing a task when the commits and/or recent docs clearly satisfy the task title and context.',
    '- Prefer false negatives over false positives.',
    '- Use commit hashes exactly as provided.',
    '- Use document refs exactly as provided.',
    '- If no clear evidence exists for a task, either omit it or return shouldClose=false.',
    '- Keep reasons concrete and tied to the evidence.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
