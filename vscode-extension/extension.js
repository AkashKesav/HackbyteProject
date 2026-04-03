const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// This extension tracks Copilot-related command usage in VS Code.
// It listens for command execution and text document changes,
// then logs events to a local JSONL file for later inspection.
// The detector is designed to identify Copilot inline suggestions,
// paste-like insertions, and AI extension activation behavior.
// This is intended for diagnostics and awareness, not for data exfiltration.
// The module keeps a lightweight output channel updated with status,
// and uses timers to periodically poll extension activation and logs.
// Most logic is wrapped in safeRun() to prevent one failure from
// disabling the whole extension host integration.
// The command map is used to convert internal command IDs to readable labels.
// This mapping enables the extension to identify and categorize AI-related commands executed in VS Code.

const COPILOT_COMMANDS = {
  "editor.action.inlineSuggest.commit": "Inline Suggestion",
  "editor.action.inlineSuggest.acceptNextLine": "Inline Suggestion (Next Line)",
  "editor.action.inlineSuggest.acceptNextWord": "Inline Suggestion (Next Word)",
  "github.copilot.chat.inlineChat.start": "Inline Chat",
  "github.copilot.chat.inlineChat.accept": "Inline Chat (Accepted)",
  "github.copilot.chat.inlineChat.discard": "Inline Chat (Discarded)",
  "github.copilot.edits.apply": "Copilot Edits",
  "github.copilot.edits.acceptAllEdits": "Copilot Edits (Accept All)",
  "github.copilot.edits.acceptFile": "Copilot Edits (Accept File)",
  "github.copilot.edits.rejectAllEdits": "Copilot Edits (Rejected)",
  "github.copilot.chat.applyInEditor": "Chat -> Apply in Editor",
  "github.copilot.chat.insertIntoNewFile": "Chat -> Insert New File",
  "github.copilot.chat.insertAtCursor": "Chat -> Insert at Cursor",
  "github.copilot.fixes.apply": "Copilot Fix",
  "github.copilot.generateTests.apply": "Copilot Generate Tests",
  "github.copilot.generateDocs.apply": "Copilot Generate Docs",
};

// Global state variables to track extension activation, document changes, and prompt context.
// These track timers, UI output, and contextual information about user and AI interactions.
let outputChannel;
let activationTimer;
let copilotLogTimer;
let lastPromptContext = null;
let lastManualKeystrokeAt = 0;
let pendingTool = null;
let pendingToolTime = 0;
const extensionStates = new Map();
let watchedCopilotLogPath = null;
let watchedCopilotLogSize = 0;
const seenCopilotLogLines = new Set();
const vscodeLogPath = path.join(os.homedir(), ".cc-vscode-log.jsonl");
const TOOL_WINDOW_MS = 3000;

// Main activation function called when the extension is loaded by VS Code.
// Registers commands, sets up event listeners, and initializes polling timers for monitoring AI extensions.
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
  const onWillExecuteCommand = vscode.commands.onWillExecuteCommand;
  if (typeof onWillExecuteCommand === "function") {
    context.subscriptions.push(
      onWillExecuteCommand((event) => {
        safeRun("onWillExecuteCommand", () => {
          const commandName = event && typeof event.command === "string" ? event.command : "";
          const toolName = COPILOT_COMMANDS[commandName];
          if (!toolName) {
            return;
          }

          markTool(toolName);
          outputChannel.appendLine(`[${new Date().toISOString()}] copilot-command: ${commandName} -> ${toolName}`);
          appendJsonLine(vscodeLogPath, {
            ts: new Date().toISOString(),
            label: "copilot-command",
            source: "copilot-command",
            provider: "copilot",
            command: commandName,
            tool: toolName,
          });
        });
      })
    );
  } else {
    outputChannel.appendLine("onWillExecuteCommand is not available in this VS Code host.");
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      safeRun("onDidChangeTextDocument", () => {
        void handleDocumentChange(event);
      });
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

// Monitors text document changes to detect paste events and inline suggestions from AI providers.
// Classifies the source of text insertions and logs them as events for analysis.
async function handleDocumentChange(event) {
  if (!event?.contentChanges?.length) {
    return;
  }

  if (shouldIgnoreDocument(event.document)) {
    return;
  }

  const change = event.contentChanges[0];
  const insertedText = String(change.text || "");
  if (!insertedText.trim()) {
    return;
  }

  const now = Date.now();
  const documentPath = event.document?.uri?.fsPath || event.document?.uri?.toString() || "unknown";
  const promptPreview = buildPreview(insertedText);
  const isPromptLike = insertedText.trim().length >= 20 && /[?]|review|explain|fix|generate|write|debug|refactor/i.test(insertedText);
  const looksTyped = insertedText.length === 1 && !insertedText.includes("\n");

  if (isPromptLike) {
    lastPromptContext = {
      source: "text-edit",
      createdAt: now,
      preview: promptPreview,
      documentPath,
    };
  }

  if (looksTyped) {
    lastManualKeystrokeAt = now;
    return;
  }

  const clipboardText = await readClipboardSafe();
  const isPaste = detectPaste(insertedText, clipboardText);
  const activeTool = currentTool();
  const inferredSource = classifyInsertionSource(insertedText, now, isPaste, activeTool);
  const contentHash = hashContent(isPaste ? clipboardText : insertedText);

  if (inferredSource === "typed") {
    return;
  }

  lastPromptContext = {
    source: inferredSource,
    createdAt: now,
    preview: buildPreview(isPaste ? clipboardText : insertedText),
    documentPath,
  };

  await emitEvent(inferredSource === "paste-event" ? "paste-detected" : "inline-suggestion", {
    appName: "vscode",
    provider: inferredSource === "inline-suggestion" ? "copilot" : "editor",
    extensionId: "vscode.editor",
    documentPath,
    method: inferredSource === "inline-suggestion" ? "SUGGESTION" : "PASTE",
    eventType: inferredSource,
    clipboardPreview: buildPreview(clipboardText),
    promptPreview,
    contentHash,
    lineCount: insertedText.split(/\r?\n/).length,
    contentText: isPaste ? clipboardText : insertedText,
    tool: activeTool,
  });
}

// Periodically polls the activation status of AI-related extensions and emits events when they activate.
// Tracks extension state transitions and correlates activations with user prompt context.
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
  appendJsonLine(vscodeLogPath, {
    ts: new Date().toISOString(),
    label,
    source: payload.eventType || label,
    ...payload,
  });

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

// Detects if the inserted text matches the clipboard content to identify paste events.
// Uses normalized whitespace comparison and respects the configured minimum paste length.
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

// Safely retrieves clipboard content without throwing errors if clipboard access fails.
// Returns empty string on failure to prevent extension crashes.
function shouldIgnoreDocument(document) {
  const fileName = String(document?.fileName || "");
  const uriString = String(document?.uri?.toString?.() || "");
  const scheme = String(document?.uri?.scheme || "");

  return (
    scheme === "output" ||
    scheme === "extension-output" ||
    fileName.includes("Commit Confessional") ||
    uriString.includes("Commit Confessional") ||
    uriString.includes("extension-output") ||
    fileName.endsWith(".log")
  );
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
    appendJsonLine(vscodeLogPath, {
      ts: new Date().toISOString(),
      label: "model-query",
      source: "copilot-log",
      provider: "copilot",
      model: modelHint,
      rawLine: normalizedLine,
      logPath: watchedCopilotLogPath,
    });
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

// Reads new content from a log file starting at the specified offset, handling file size growth.
// Returns the new log lines and updates the offset for the next read cycle.
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

function classifyInsertionSource(insertedText, now, isPaste, activeTool) {
  if (isPaste) {
    return "paste-event";
  }

  if (activeTool !== "Human / Unknown") {
    return "inline-suggestion";
  }

  const isLargeInsertion = insertedText.length > 80 || insertedText.includes("\n");
  if (isLargeInsertion && now - lastManualKeystrokeAt > 300) {
    return "inline-suggestion";
  }

  return "typed";
}

function hashContent(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

// Persists event data to a JSONL file for offline analysis and audit trail of detected AI interactions.
function appendJsonLine(filePath, payload) {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    outputChannel.appendLine(`Log write failed: ${error?.message || String(error)}`);
  }
}

// Wraps all action execution in try-catch to prevent unhandled errors from disabling the entire extension.
// Logs failures to the output channel for debugging and diagnostics.
function safeRun(label, action) {
  try {
    action();
  } catch (error) {
    outputChannel.appendLine(`${label} failed: ${error?.message || String(error)}`);
  }
}

function markTool(name) {
  pendingTool = name;
  pendingToolTime = Date.now();
}

function currentTool() {
  if (pendingTool && Date.now() - pendingToolTime < TOOL_WINDOW_MS) {
    return pendingTool;
  }

  return "Human / Unknown";
}

module.exports = {
  activate,
  deactivate,
};
