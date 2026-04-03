import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function initializeOutputChannel(channel: vscode.OutputChannel): void {
  outputChannel = channel;
}

export function logLine(message: string): void {
  outputChannel?.appendLine(message);
}

export function revealLogs(): void {
  outputChannel?.show(true);
}
