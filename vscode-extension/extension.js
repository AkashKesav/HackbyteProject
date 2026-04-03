const vscode = require("vscode");

let outputChannel;
let activationTimer;
let lastPromptContext = null;
const extensionStates = new Map();

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Commit Confessional");
  outputChannel.appendLine("Commit Confessional detector started.");

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
    vscode.workspace.onDidChangeTextDocument((event) => {
      void handleDocumentChange(event);
    })
  );

  activationTimer = setInterval(() => {
    void pollAiExtensionActivation();
  }, 2000);

  context.subscriptions.push({
    dispose() {
      if (activationTimer) {
        clearInterval(activationTimer);
      }
    },
  });

  void pollAiExtensionActivation(true);
}

function deactivate() {
  if (activationTimer) {
    clearInterval(activationTimer);
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

module.exports = {
  activate,
  deactivate,
};
