import * as vscode from 'vscode';
import {
  DEFAULT_BOARD_URL,
  DEFAULT_DATABASE_NAME,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_SPACETIME_HTTP_URL,
  EXTENSION_NAMESPACE,
  GEMINI_API_KEY_SECRET,
} from './constants';
import type { ExtensionConfig } from './types';

export function getExtensionConfig(): ExtensionConfig {
  const section = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);

  return {
    spacetimeHttpUrl:
      section.get<string>('spacetimeHttpUrl')?.trim() || DEFAULT_SPACETIME_HTTP_URL,
    databaseName: section.get<string>('databaseName')?.trim() || DEFAULT_DATABASE_NAME,
    boardUrl: section.get<string>('boardUrl')?.trim() || DEFAULT_BOARD_URL,
    geminiModel: section.get<string>('geminiModel')?.trim() || DEFAULT_GEMINI_MODEL,
    recentCommitCount: Math.max(1, Math.trunc(section.get<number>('recentCommitCount') ?? 8)),
    recentDocLookbackHours: Math.max(
      1,
      Math.trunc(section.get<number>('recentDocLookbackHours') ?? 24)
    ),
    confidenceThreshold: clamp(section.get<number>('confidenceThreshold') ?? 0.76, 0, 1),
    maxCommitDiffChars: Math.max(
      200,
      Math.trunc(section.get<number>('maxCommitDiffChars') ?? 1400)
    ),
    maxDocumentExcerptChars: Math.max(
      400,
      Math.trunc(section.get<number>('maxDocumentExcerptChars') ?? 2600)
    ),
    maxRecentDocs: Math.max(1, Math.trunc(section.get<number>('maxRecentDocs') ?? 8)),
  };
}

export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    return vscode.workspace.getWorkspaceFolder(active) ?? vscode.workspace.workspaceFolders?.[0];
  }

  return vscode.workspace.workspaceFolders?.[0];
}

export async function chooseWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  const active = getPrimaryWorkspaceFolder();
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Choose the workspace folder whose recent commits should be matched against open tasks.',
    ignoreFocusOut: true,
  });

  return picked ?? active;
}

export async function getGeminiApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const stored = await context.secrets.get(GEMINI_API_KEY_SECRET);
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  return stored ?? fromEnv ?? undefined;
}

export async function promptForGeminiApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Paste your Gemini API key',
    prompt: 'Store the Gemini API key used to match recent work against open tasks.',
    validateInput(value) {
      return value.trim().length >= 20 ? undefined : 'Gemini API key looks too short.';
    },
  });

  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  await context.secrets.store(GEMINI_API_KEY_SECRET, trimmed);
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
