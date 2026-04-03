import * as vscode from 'vscode';
import { getExtensionConfig, promptForGeminiApiKey } from './config';
import { runResolutionFlow } from './flows/runResolutionFlow';

let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Hackbyte Taskboard');
  outputChannel.appendLine('Hackbyte Taskboard extension activated.');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'hackbyteTaskboard.configureGeminiKey',
      async () => {
        outputChannel?.appendLine('Running command: configureGeminiKey');
        const key = await promptForGeminiApiKey(context);
        if (key) {
          outputChannel?.appendLine('Gemini API key stored successfully.');
          void vscode.window.showInformationMessage('Gemini API key stored for Hackbyte Taskboard.');
        }
      }
    ),
    vscode.commands.registerCommand(
      'hackbyteTaskboard.openLiveTaskBoard',
      async () => {
        outputChannel?.appendLine('Running command: openLiveTaskBoard');
        const config = getExtensionConfig();
        await vscode.env.openExternal(vscode.Uri.parse(config.boardUrl));
      }
    ),
    vscode.commands.registerCommand(
      'hackbyteTaskboard.resolveTasksFromRecentWork',
      async () => {
        outputChannel?.appendLine('Running command: resolveTasksFromRecentWork');
        await runResolutionFlow(context);
      }
    )
  );
}

export function deactivate(): void {
  outputChannel?.appendLine('Hackbyte Taskboard extension deactivated.');
}
