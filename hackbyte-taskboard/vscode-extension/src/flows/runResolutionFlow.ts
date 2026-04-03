import * as vscode from 'vscode';
import { chooseWorkspaceFolder, getExtensionConfig, getGeminiApiKey } from '../config';
import { collectRecentDocs } from '../docs/collectRecentDocs';
import { inferTaskResolutions } from '../gemini/client';
import { collectRecentCommits, resolveGitRepoRoot } from '../git/collectRecentCommits';
import { logLine, revealLogs } from '../logging';
import { buildFallbackCandidates } from '../matching/fallbackCandidates';
import { fetchOpenTasks } from '../spacetime/fetchOpenTasks';
import { resolveTasks } from '../spacetime/resolveTasks';
import { showResolutionPreview } from '../ui/showResolutionPreview';
import type { OpenTask, ResolutionCandidate } from '../types';

export async function runResolutionFlow(
  context: vscode.ExtensionContext
): Promise<void> {
  const workspaceFolder = await chooseWorkspaceFolder();
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(
      'Open a workspace folder before resolving tasks from recent work.'
    );
    return;
  }

  logLine(`Workspace selected: ${workspaceFolder.name} (${workspaceFolder.uri.fsPath})`);

  const apiKey = await getGeminiApiKey(context);
  if (!apiKey) {
    logLine('Gemini API key missing. Prompting user to configure it.');
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
      logLine(`Loaded ${openTasks.length} open task(s) from ${config.databaseName}.`);
      for (const task of openTasks) {
        logLine(`Open task ${task.id}: ${task.title} [${task.status}]`);
      }
      if (openTasks.length === 0) {
        void vscode.window.showInformationMessage('No open tasks are available to resolve.');
        return [];
      }

      progress.report({ message: 'Inspecting recent commits...' });
      const repoRoot = await resolveGitRepoRoot(workspaceFolder.uri.fsPath);
      logLine(`Resolved git repo root: ${repoRoot}`);
      const commitContext = await collectRecentCommits(
        repoRoot,
        config.recentCommitCount,
        config.maxCommitDiffChars
      );
      logLine(`Branch: ${commitContext.branch}`);
      logLine(`Collected ${commitContext.commits.length} recent commit(s).`);
      for (const commit of commitContext.commits) {
        logLine(`Commit ${commit.hash.slice(0, 8)}: ${commit.subject}`);
      }

      progress.report({ message: 'Scanning recent documentation...' });
      const documents = await collectRecentDocs(
        commitContext.repoRoot,
        commitContext.commits,
        config.recentDocLookbackHours,
        config.maxRecentDocs,
        config.maxDocumentExcerptChars
      );
      logLine(`Collected ${documents.length} recent document(s).`);
      for (const document of documents) {
        logLine(`Doc ${document.relativePath} (commits: ${document.relatedCommitHashes.map(hash => hash.slice(0, 8)).join(', ') || 'none'})`);
      }

      if (commitContext.commits.length === 0 && documents.length === 0) {
        void vscode.window.showInformationMessage(
          'No recent commits or documentation changes were found to evaluate.'
        );
        return [];
      }

      progress.report({ message: 'Asking Gemini to match evidence against open tasks...' });
      let geminiCandidates: ResolutionCandidate[] = [];
      try {
        const geminiResponse = await inferTaskResolutions({
          apiKey,
          model: config.geminiModel,
          branch: commitContext.branch,
          openTasks,
          commits: commitContext.commits,
          documents,
        });
        geminiCandidates = geminiResponse.candidates;
        logLine(`Gemini returned ${geminiResponse.candidates.length} raw candidate(s).`);
        for (const candidate of geminiResponse.candidates) {
          logLine(
            `Gemini candidate task ${candidate.taskId}: close=${candidate.shouldClose} confidence=${candidate.confidence.toFixed(2)} commit=${candidate.commitHash ?? 'none'} refs=${candidate.documentRefs.join(', ') || 'none'}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLine(`Gemini request failed, falling back to local matcher: ${message}`);
      }

      const vettedCandidates = vetCandidates({
        openTasks,
        candidates: geminiCandidates,
        confidenceThreshold: config.confidenceThreshold,
        commitHashes: new Set(commitContext.commits.map(commit => commit.hash)),
        documentRefs: new Set(documents.map(document => document.relativePath)),
      });
      logLine(`Gemini candidates after vetting: ${vettedCandidates.length}.`);

      const fallbackCandidates =
        vettedCandidates.length === 0
          ? buildFallbackCandidates({
              openTasks,
              commits: commitContext.commits,
              documents,
              confidenceThreshold: config.confidenceThreshold,
            })
          : [];

      if (fallbackCandidates.length > 0) {
        logLine(`Fallback matcher produced ${fallbackCandidates.length} candidate(s).`);
        for (const candidate of fallbackCandidates) {
          logLine(
            `Fallback candidate task ${candidate.taskId}: confidence=${candidate.confidence.toFixed(2)} commit=${candidate.commitHash ?? 'none'} refs=${candidate.documentRefs.join(', ') || 'none'}`
          );
        }
      }

      const finalCandidates = vettedCandidates.length > 0 ? vettedCandidates : fallbackCandidates;

      if (finalCandidates.length === 0) {
        revealLogs();
        void vscode.window.showInformationMessage(
          'No high-confidence task completions were found. Check the "Hackbyte Taskboard" output panel for repo and candidate details.'
        );
        return [];
      }

      progress.report({ message: 'Preparing a review list...' });
      const taskMap = new Map(openTasks.map(task => [task.id, task]));
      return showResolutionPreview(finalCandidates, taskMap);
    });

    if (selectedCandidates.length === 0) {
      logLine('No candidates were selected from the review picker.');
      return;
    }

    logLine(`User selected ${selectedCandidates.length} candidate(s) to apply.`);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Hackbyte Taskboard',
      cancellable: false,
    }, async progress => {
      progress.report({ message: `Closing ${selectedCandidates.length} task(s) in SpacetimeDB...` });
      await resolveTasks(config, selectedCandidates);
    });
    logLine(`Applied ${selectedCandidates.length} task resolution(s).`);

    const action = await vscode.window.showInformationMessage(
      `Closed ${selectedCandidates.length} task(s) in the live task board.`,
      'Open Board'
    );

    if (action === 'Open Board') {
      await vscode.env.openExternal(vscode.Uri.parse(config.boardUrl));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`Resolution flow failed: ${message}`);
    revealLogs();
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
