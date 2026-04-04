// VS Code Extension: Commit Confessional Detector
// Monitors and logs Copilot command usage for diagnostic analysis and event tracking.
// This VS Code extension module provides the main entry point for the Commit Confessional detector.
// It imports necessary Node.js modules for file system operations, path handling, and cryptography.
// The extension uses VS Code's API to register commands and listen for editor events.
// All module dependencies are imported at the top to ensure they're available throughout the extension.
// The extension is designed to be lightweight and performant with minimal overhead on VS Code.

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

// Global variables to manage extension state and timers
// These track output, timers, context, and user interactions throughout the extension lifecycle

let outputChannel;
let activationTimer;
let copilotLogTimer;
let lastPromptContext = null;
let lastManualKeystrokeAt = 0;

// Track pending tool calls and their timing for correlation with detected commands
let pendingTool = null;
let pendingToolTime = 0;
let lastCopilotLogActivityAt = 0;

// Maintain extension state mappings and monitor Copilot log file for real-time events
const extensionStates = new Map();
let watchedCopilotLogPath = null;
let watchedCopilotLogSize = 0;
const seenCopilotLogLines = new Set();
// Configuration for event logging file location in user home directory
const vscodeLogPath = path.join(os.homedir(), ".cc-vscode-log.jsonl");
const TOOL_WINDOW_MS = 3000;
const COPILOT_LOG_WINDOW_MS = 8000;

// Activates the extension when VS Code loads
// Sets up the output channel for logging events and user notifications
// Registers command handlers for inspecting extensions and viewing logs
// Establishes watchers for command execution and document changes
// Initializes timers to monitor Copilot activity periodically
// Primary entry point that initializes all extension components and event listeners
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
    vscode.commands.registerCommand("commitConfessional.debugStatus", async () => {
      outputChannel.clear();
      outputChannel.appendLine("===== COMMIT CONFESSIONAL DEBUG STATUS =====");
      outputChannel.appendLine(`Timestamp: ${new Date().toISOString()}`);
      outputChannel.appendLine(`Log file: ${vscodeLogPath}`);
      outputChannel.appendLine(`Log exists: ${fs.existsSync(vscodeLogPath)}`);
      
      const appData = process.env.APPDATA;
      const logsRoot = appData ? path.join(appData, "Code", "logs") : "APPDATA not set";
      outputChannel.appendLine(`\nVS Code Logs Root: ${logsRoot}`);
      outputChannel.appendLine(`Logs directory exists: ${fs.existsSync(logsRoot)}`);
      
      const latestLog = findLatestCopilotLog();
      outputChannel.appendLine(`Copilot log found: ${latestLog ? latestLog.fullPath : "NO"}`);
      
      outputChannel.appendLine(`\nWatched Extensions Status:`);
      getWatchedExtensions().forEach((id) => {
        const ext = vscode.extensions.getExtension(id);
        const status = ext ? (ext.isActive ? "🟢 ACTIVE" : "🟡 INSTALLED") : "🔴 NOT INSTALLED";
        outputChannel.appendLine(`  ${id}: ${status}`);
      });
      
      outputChannel.appendLine(`\nCommand API Status:`);
      outputChannel.appendLine(`  onWillExecuteCommand available: ${typeof vscode.commands.onWillExecuteCommand === "function" ? "YES" : "NO"}`);
      
      outputChannel.appendLine(`\nLast Prompt Context: ${lastPromptContext ? JSON.stringify(lastPromptContext, null, 2) : "NONE"}`);
      outputChannel.appendLine(`Current Tool: ${currentTool()}`);
      outputChannel.appendLine(`Tool Window MS: ${TOOL_WINDOW_MS}`);
      
      outputChannel.appendLine(`\nBackend Configuration:`);
      outputChannel.appendLine(`  Backend URL: ${getConfig("backendUrl") || "NOT SET"}`);
      outputChannel.appendLine(`  AI Extensions Config: ${JSON.stringify(getConfig("aiExtensions"))}`);
      outputChannel.appendLine(`  Paste Min Length: ${getConfig("pasteMinLength") || "default (12)"}`);
      outputChannel.appendLine(`  Prompt Window MS: ${getConfig("promptWindowMs") || "default (60000)"}`);
      
      outputChannel.appendLine(`\nTesting clipboard access...`);
      const clipboardText = await readClipboardSafe();
      outputChannel.appendLine(`  Clipboard readable: ${clipboardText ? "YES" : "NO"}`);
      outputChannel.appendLine(`  Clipboard length: ${clipboardText.length} chars`);
      
      outputChannel.appendLine(`\n===== END DEBUG STATUS =====`);
      outputChannel.show(true);
    })
  );
  const onWillExecuteCommand = vscode.commands.onWillExecuteCommand;
  if (typeof onWillExecuteCommand === "function") {
    outputChannel.appendLine("✓ Command execution monitoring enabled");
    context.subscriptions.push(
      onWillExecuteCommand((event) => {
        safeRun("onWillExecuteCommand", () => {
          const commandName = event && typeof event.command === "string" ? event.command : "";
          const toolName = COPILOT_COMMANDS[commandName];
          
          // Debug: Log all commands for diagnostics
          if (commandName && commandName.startsWith("github.copilot")) {
            outputChannel.appendLine(`[DEBUG] Raw Copilot command detected: ${commandName}`);
          }
          
          if (!toolName) {
            return;
          }

          markTool(toolName);
          outputChannel.appendLine(`[${new Date().toISOString()}] ✓ copilot-command: ${commandName} -> ${toolName}`);
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
    outputChannel.appendLine("✗ onWillExecuteCommand is NOT available in this VS Code host.");
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

// Cleans up resources when the extension is deactivated or VS Code shuts down
function deactivate() {
  if (activationTimer) {
    clearInterval(activationTimer);
  }
  if (copilotLogTimer) {
    clearInterval(copilotLogTimer);
  }
}

// Monitors text document changes to detect AI-generated content and paste operations
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
  // Identify prompt-like text by checking length and keywords suggesting user instructions
  const isPromptLike = insertedText.trim().length >= 20 && /[?]|review|explain|fix|generate|write|debug|refactor/i.test(insertedText);
  const looksTyped = insertedText.length === 1 && !insertedText.includes("\n");
  const isNonTrivialInsertion = insertedText.length > 20 || insertedText.includes("\n");
  
  // Debug logging for document changes
  if (isNonTrivialInsertion) {
    outputChannel.appendLine(`[DEBUG] Document change detected: ${insertedText.length} chars, file: ${path.basename(documentPath)}`);
  }

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
    clearPendingTool();
    return;
  }

  // Retrieve clipboard content to compare with inserted text for paste detection
  const clipboardText = await readClipboardSafe();
  const isPaste = detectPaste(insertedText, clipboardText);
  const activeTool = currentTool();
  const inferredSource = classifyInsertionSource(insertedText, now, isPaste, activeTool, isNonTrivialInsertion);
  const contentHash = hashContent(isPaste ? clipboardText : insertedText);

  // Debug logging for insertion analysis
  if (isNonTrivialInsertion) {
    outputChannel.appendLine(`[DEBUG] Analysis: isPaste=${isPaste}, activeTool=${activeTool}, source=${inferredSource}`);
    if (isPaste) {
      outputChannel.appendLine(`[DEBUG] Paste detected - clipboard matches inserted text`);
    } else if (activeTool !== "Human / Unknown") {
      outputChannel.appendLine(`[DEBUG] Tool active: ${activeTool}`);
    }
  }

  if (inferredSource === "typed") {
    if (insertedText.length <= 8) {
      clearPendingTool();
    }
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

async function pollAiExtensionActivation(initial = false) {
  const now = Date.now();

  // Iterate through all tracked AI extensions and check their activation state
  for (const extensionId of getWatchedExtensions()) {
    const extension = vscode.extensions.getExtension(extensionId);
    const isActive = Boolean(extension?.isActive);
    const previousState = extensionStates.get(extensionId);
    extensionStates.set(extensionId, isActive);

    // Debug: Log extension status on initial check
    if (initial) {
      const status = extension ? (isActive ? "active" : "installed-inactive") : "not-installed";
      outputChannel.appendLine(`[DEBUG] Extension status: ${extensionId} = ${status}`);
    }

    if (initial || !extension || !isActive || previousState === isActive) {
      continue;
    }
    
    outputChannel.appendLine(`[DEBUG] Extension activated: ${extensionId}`);

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
      clipboardPreview: recentPrompt?.source === "paste-event" ? recentPrompt.preview : "none",
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

function buildPreview(value) {
  const text = normalizeWhitespace(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

async function readClipboardSafe() {
  try {
    return await vscode.env.clipboard.readText();
  } catch (error) {
    outputChannel.appendLine(`[DEBUG] Clipboard read failed: ${error?.message || String(error)}`);
    return "";
  }
}

function getConfig(key) {
  return vscode.workspace.getConfiguration("commitConfessional").get(key);
}

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
      const appData = process.env.APPDATA;
      const logsRoot = appData ? path.join(appData, "Code", "logs") : "APPDATA not set";
      outputChannel.appendLine(`✗ No Copilot log file found. Searched: ${logsRoot}`);
    }
    return;
  }

  if (watchedCopilotLogPath !== latestLog.fullPath) {
    watchedCopilotLogPath = latestLog.fullPath;
    watchedCopilotLogSize = 0;
    seenCopilotLogLines.clear();
    outputChannel.appendLine(`✓ Watching Copilot log: ${watchedCopilotLogPath} (${latestLog.size} bytes)`);
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
    lastCopilotLogActivityAt = Date.now();
    const inferredTool = inferToolFromCopilotLogLine(normalizedLine);
    if (inferredTool) {
      markTool(inferredTool);
    }
    outputChannel.appendLine(`✓ [copilot-model] ${modelHint}`);
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

function classifyInsertionSource(insertedText, now, isPaste, activeTool, isNonTrivialInsertion) {
  if (isPaste) {
    return "paste-event";
  }

  if (activeTool !== "Human / Unknown" && isNonTrivialInsertion) {
    return "inline-suggestion";
  }

  if (isNonTrivialInsertion && hadRecentCopilotLogActivity(now)) {
    return "inline-suggestion";
  }

  return "typed";
}

function inferToolFromCopilotLogLine(line) {
  const normalized = String(line || "").toLowerCase();

  if (normalized.includes("[panel/editagent]")) {
    return "Copilot Chat Edit";
  }

  if (normalized.includes("[copilotlanguagemodelwrapper]")) {
    return "Copilot Inline Suggestion";
  }

  if (normalized.includes("[title]")) {
    return "Copilot Chat";
  }

  if (normalized.includes("[progressmessages]")) {
    return "Copilot Chat";
  }

  return null;
}

function hadRecentCopilotLogActivity(now = Date.now()) {
  return Boolean(lastCopilotLogActivityAt) && now - lastCopilotLogActivityAt < COPILOT_LOG_WINDOW_MS;
}

function hashContent(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

function appendJsonLine(filePath, payload) {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    outputChannel.appendLine(`Log write failed: ${error?.message || String(error)}`);
  }
}

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

  if (hadRecentCopilotLogActivity()) {
    return "Copilot (log activity)";
  }

  return "Human / Unknown";
}

function clearPendingTool() {
  pendingTool = null;
  pendingToolTime = 0;
}

module.exports = {
  activate,
  deactivate,
};
