import * as vscode from 'vscode';
import type { OpenTask, ResolutionCandidate } from '../types';

interface ResolutionQuickPickItem extends vscode.QuickPickItem {
  candidate: ResolutionCandidate;
}

export async function showResolutionPreview(
  candidates: ResolutionCandidate[],
  tasksById: Map<number, OpenTask>
): Promise<ResolutionCandidate[]> {
  const items: ResolutionQuickPickItem[] = candidates.map(candidate => {
    const task = tasksById.get(candidate.taskId);
    const confidence = `${Math.round(candidate.confidence * 100)}%`;
    const commit = candidate.commitHash ? `commit ${candidate.commitHash}` : 'no commit link';
    const docs =
      candidate.documentRefs.length > 0
        ? `docs ${candidate.documentRefs.join(', ')}`
        : 'no doc refs';

    return {
      label: task?.title ?? `Task ${candidate.taskId}`,
      description: `${confidence} | ${commit} | ${docs}`,
      detail: [candidate.reason, candidate.evidenceSummary]
        .filter(Boolean)
        .join(' | '),
      picked: true,
      candidate,
    };
  });

  const selection = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    placeHolder: 'Select the inferred task resolutions you want to apply.',
    title: 'Hackbyte Taskboard: Review Resolution Suggestions',
  });

  return selection?.map(item => item.candidate) ?? [];
}
