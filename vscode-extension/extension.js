const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

let outputChannel;
let activationTimer;
let copilotLogTimer;
let lastPromptContext = null;
const extensionStates = new Map();
let watchedCopilotLogPath = null;
let watchedCopilotLogSize = 0;
const seenCopilotLogLines = new Set();

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Commit Confessional");
  outputChannel.appendLine("Commit Confessional detector started.");
  outputChannel.show(true);
  void vscode.window.showInformationMessage(
    "Commit Confessional detector is active. Open the 'Commit Confessional' output channel."
  );

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.commands.registerCommand("commitConfessional.showOutput", () => {
      outputChannel.show(true);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("commitConfessional.inspectAiExtensions", async () => {
      const snapshot = getWatchedExtensions().map((id) => {
        const ext = vscode.extensions.getExtension(id);
        return `${id}: ${ext ? (ext.isActive ? "active" : "installed-inactive") : "not-installed"}`;
      });
      outputChannel.appendLine(snapshot.join("\n"));
      outputChannel.show(true);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("commitConfessional.listMatchingExtensions", async () => {
      const matches = vscode.extensions.all
        .map((ext) => ext.id)
        .filter((id) => /(copilot|codex|openai|chatgpt)/i.test(id))
        .sort();

      outputChannel.appendLine("Matching installed extensions:");
      outputChannel.appendLine(matches.length ? matches.join("\n") : "No matching extensions found.");
      outputChannel.show(true);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      void handleDocumentChange(event);
    })
  );

  activationTimer = setInterval(() => {
    void pollAiExtensionActivation();
  }, 2000);
  copilotLogTimer = setInterval(() => {
    void pollCopilotLogs();
  }, 3000);

  context.subscriptions.push({
    dispose() {
      if (activationTimer) {
        clearInterval(activationTimer);
      }
      if (copilotLogTimer) {
        clearInterval(copilotLogTimer);
      }
    },
  });

  void pollAiExtensionActivation(true);
  void pollCopilotLogs(true);
}

function deactivate() {
  if (activationTimer) {
    clearInterval(activationTimer);
  }
  if (copilotLogTimer) {
    clearInterval(copilotLogTimer);
  }
}

async function handleDocumentChange(event) {
  if (!event?.contentChanges?.length) {
    return;
  }

  const change = event.contentChanges[0];
  const insertedText = String(change.text || "");
  if (!insertedText.trim()) {
    return;
  }

  const documentPath = event.document?.uri?.fsPath || event.document?.uri?.toString() || "unknown";
  const promptPreview = buildPreview(insertedText);
  const isPromptLike = insertedText.trim().length >= 20 && /[?]|review|explain|fix|generate|write|debug|refactor/i.test(insertedText);

  if (isPromptLike) {
    lastPromptContext = {
      source: "text-edit",
      createdAt: Date.now(),
      preview: promptPreview,
      documentPath,
    };
  }

  const clipboardText = await readClipboardSafe();
  const isPaste = detectPaste(insertedText, clipboardText);

  if (!isPaste) {
    return;
  }

  lastPromptContext = {
    source: "paste",
    createdAt: Date.now(),
    preview: buildPreview(clipboardText),
    documentPath,
  };

  await emitEvent("paste-detected", {
    appName: "vscode",
    provider: "editor",
    extensionId: "vscode.editor",
    documentPath,
    method: "PASTE",
    eventType: "paste-detected",
    clipboardPreview: buildPreview(clipboardText),
    promptPreview,
  });
}

async function pollAiExtensionActivation(initial = false) {
  const now = Date.now();

  for (const extensionId of getWatchedExtensions()) {
    const extension = vscode.extensions.getExtension(extensionId);
    const isActive = Boolean(extension?.isActive);
    const previousState = extensionStates.get(extensionId);
    extensionStates.set(extensionId, isActive);

    if (initial || !extension || !isActive || previousState === isActive) {
      continue;
    }

    const provider = detectProviderFromExtensionId(extensionId);
    const recentPrompt = getRecentPromptContext(now);
    const summary = recentPrompt
      ? `${extensionId} activated after recent ${recentPrompt.source}: ${recentPrompt.preview}`
      : `${extensionId} activated with no recent prompt context`;

    await emitEvent("ai-activated", {
      appName: "vscode",
      provider,
      extensionId,
      eventType: "ai-activated",
      method: "ACTIVATE",
      documentPath: recentPrompt?.documentPath || getActiveDocumentPath(),
      promptPreview: recentPrompt?.preview || "none",
      clipboardPreview: recentPrompt?.source === "paste" ? recentPrompt.preview : "none",
      endpoint: `vscode-extension://${extensionId}`,
      tabTitle: vscode.window.activeTextEditor?.document?.fileName || "",
      summary,
    });
  }
}

async function emitEvent(label, payload) {
  const line = `[${new Date().toISOString()}] ${label}: ${payload.extensionId || payload.provider} ${payload.promptPreview || ""}`.trim();
  outputChannel.appendLine(line);

  const backendUrl = getConfig("backendUrl");
  if (!backendUrl) {
    return;
  }

  try {
    await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        userAgent: "vscode-extension",
      }),
    });
  } catch (error) {
    outputChannel.appendLine(`Backend post failed: ${error?.message || String(error)}`);
  }
}

function getWatchedExtensions() {
  const configured = getConfig("aiExtensions");
  return Array.isArray(configured) ? configured : [];
}

function getRecentPromptContext(now) {
  if (!lastPromptContext) {
    return null;
  }

  if (now - lastPromptContext.createdAt > Number(getConfig("promptWindowMs") || 60000)) {
    return null;
  }

  return lastPromptContext;
}

function getActiveDocumentPath() {
  return vscode.window.activeTextEditor?.document?.uri?.fsPath || "unknown";
}

function detectProviderFromExtensionId(extensionId) {
  const value = String(extensionId || "").toLowerCase();
  if (value.includes("copilot")) return "copilot";
  if (value.includes("codex")) return "codex";
  if (value.includes("openai") || value.includes("chatgpt")) return "openai";
  return "unknown";
}

function detectPaste(insertedText, clipboardText) {
  const minLength = Number(getConfig("pasteMinLength") || 12);
  const normalizedInserted = normalizeWhitespace(insertedText);
  const normalizedClipboard = normalizeWhitespace(clipboardText);

  if (!normalizedInserted || normalizedInserted.length < minLength) {
    return false;
  }

  return normalizedInserted === normalizedClipboard;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildPreview(value) {
  const text = normalizeWhitespace(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

async function readClipboardSafe() {
  try {
    return await vscode.env.clipboard.readText();
  } catch {
    return "";
  }
}

function getConfig(key) {
  return vscode.workspace.getConfiguration("commitConfessional").get(key);
}

async function pollCopilotLogs(initial = false) {
  const latestLog = findLatestCopilotLog();
  if (!latestLog) {
    if (initial) {
      outputChannel.appendLine("No Copilot log file found under %APPDATA%\\Code\\logs.");
    }
    return;
  }

  if (watchedCopilotLogPath !== latestLog.fullPath) {
    watchedCopilotLogPath = latestLog.fullPath;
    watchedCopilotLogSize = 0;
    seenCopilotLogLines.clear();
    outputChannel.appendLine(`Watching Copilot log: ${watchedCopilotLogPath}`);
  }

  const chunk = readNewLogChunk(watchedCopilotLogPath, watchedCopilotLogSize);
  if (!chunk) {
    return;
  }

  watchedCopilotLogSize = chunk.nextOffset;

  for (const line of chunk.lines) {
    const normalizedLine = String(line || "").trim();
    if (!normalizedLine) {
      continue;
    }

    const modelHint = extractModelHint(normalizedLine);
    if (!modelHint) {
      continue;
    }

    const dedupeKey = `${watchedCopilotLogPath}|${normalizedLine}`;
    if (seenCopilotLogLines.has(dedupeKey)) {
      continue;
    }

    seenCopilotLogLines.add(dedupeKey);
    outputChannel.appendLine(`[copilot-model] ${modelHint}`);
    outputChannel.appendLine(normalizedLine);
    outputChannel.show(true);
  }
}

function findLatestCopilotLog() {
  const appData = process.env.APPDATA;
  if (!appData) {
    return null;
  }

  const logsRoot = path.join(appData, "Code", "logs");
  if (!fs.existsSync(logsRoot)) {
    return null;
  }

  const files = walkLogFiles(logsRoot);
  const copilotFiles = files
    .filter((file) => /copilot/i.test(file.fullPath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return copilotFiles[0] || null;
}

function walkLogFiles(root) {
  const results = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) {
        continue;
      }

      try {
        const stats = fs.statSync(fullPath);
        results.push({
          fullPath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
      } catch {
        continue;
      }
    }
  }

  return results;
}

function readNewLogChunk(filePath, offset) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null;
  }

  const start = stats.size < offset ? 0 : offset;
  if (stats.size === start) {
    return null;
  }

  const buffer = Buffer.alloc(stats.size - start);
  const fd = fs.openSync(filePath, "r");

  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }

  return {
    nextOffset: stats.size,
    lines: buffer.toString("utf8").split(/\r?\n/),
  };
}

function extractModelHint(line) {
  const patterns = [
    /claude[- ]?haiku[ -]?[0-9.]*/i,
    /claude[- ]?sonnet[ -]?[0-9.]*/i,
    /claude[- ]?opus[ -]?[0-9.]*/i,
    /gpt[- ]?[0-9a-z.]*/i,
    /gemini[- ]?[0-9a-z.]*/i,
    /o[0-9][ -]?[a-z0-9]*/i,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

module.exports = {
  activate,
  deactivate,
};
