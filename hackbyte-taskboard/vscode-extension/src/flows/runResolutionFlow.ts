import * as vscode from 'vscode';
import { getExtensionConfig, getGeminiApiKey, getPrimaryWorkspaceFolder } from '../config';
import { collectRecentDocs } from '../docs/collectRecentDocs';
import { inferTaskResolutions } from '../gemini/client';
import { collectRecentCommits, resolveGitRepoRoot } from '../git/collectRecentCommits';
import { fetchOpenTasks } from '../spacetime/fetchOpenTasks';
import { resolveTasks } from '../spacetime/resolveTasks';
import { showResolutionPreview } from '../ui/showResolutionPreview';
import type { OpenTask, ResolutionCandidate } from '../types';

export async function runResolutionFlow(
  context: vscode.ExtensionContext
): Promise<void> {
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(
      'Open a workspace folder before resolving tasks from recent work.'
    );
    return;
  }

  const apiKey = await getGeminiApiKey(context);
  if (!apiKey) {
    void vscode.window.showInformationMessage(
      'Configure a Gemini API key first with "Hackbyte: Configure Gemini API Key".'
    );
    return;
  }

  const config = getExtensionConfig();

  try {
    const selectedCandidates = await vscode.window.withProgress<ResolutionCandidate[]>({
      location: vscode.ProgressLocation.Notification,
      title: 'Hackbyte Taskboard',
      cancellable: false,
    }, async progress => {
      progress.report({ message: 'Loading open tasks from SpacetimeDB...' });
      const openTasks = await fetchOpenTasks(config);
      if (openTasks.length === 0) {
        void vscode.window.showInformationMessage('No open tasks are available to resolve.');
        return [];
      }

      progress.report({ message: 'Inspecting recent commits...' });
      const repoRoot = await resolveGitRepoRoot(workspaceFolder.uri.fsPath);
      const commitContext = await collectRecentCommits(
        repoRoot,
        config.recentCommitCount,
        config.maxCommitDiffChars
      );

      progress.report({ message: 'Scanning recent documentation...' });
      const documents = await collectRecentDocs(
        commitContext.repoRoot,
        commitContext.commits,
        config.recentDocLookbackHours,
        config.maxRecentDocs,
        config.maxDocumentExcerptChars
      );

      if (commitContext.commits.length === 0 && documents.length === 0) {
        void vscode.window.showInformationMessage(
          'No recent commits or documentation changes were found to evaluate.'
        );
        return [];
      }

      progress.report({ message: 'Asking Gemini to match evidence against open tasks...' });
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

      if (vettedCandidates.length === 0) {
        void vscode.window.showInformationMessage(
          'Gemini did not find any high-confidence task completions in the recent work.'
        );
        return [];
      }

      progress.report({ message: 'Preparing a review list...' });
      const taskMap = new Map(openTasks.map(task => [task.id, task]));
      return showResolutionPreview(vettedCandidates, taskMap);
    });

    if (selectedCandidates.length === 0) {
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Hackbyte Taskboard',
      cancellable: false,
    }, async progress => {
      progress.report({ message: `Closing ${selectedCandidates.length} task(s) in SpacetimeDB...` });
      await resolveTasks(config, selectedCandidates);
    });

    const action = await vscode.window.showInformationMessage(
      `Closed ${selectedCandidates.length} task(s) in the live task board.`,
      'Open Board'
    );

    if (action === 'Open Board') {
      await vscode.env.openExternal(vscode.Uri.parse(config.boardUrl));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Hackbyte task resolution failed: ${message}`);
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
