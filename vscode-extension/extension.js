const vscode = require("vscode");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const LOG_PATH = path.join(os.homedir(), ".cc-vscode-log.jsonl");
const TOOL_WINDOW_MS = 3000;
const COPILOT_LOG_WINDOW_MS = 8000;
const DEFAULT_SESSION_ID = "local-dev";
const COPILOT_COMMANDS = {
  "editor.action.inlineSuggest.commit": "Inline Suggestion",
  "editor.action.inlineSuggest.acceptNextLine": "Inline Suggestion (Next Line)",
  "editor.action.inlineSuggest.acceptNextWord": "Inline Suggestion (Next Word)",
  "github.copilot.chat.inlineChat.start": "Inline Chat",
  "github.copilot.chat.inlineChat.accept": "Inline Chat (Accepted)",
  "github.copilot.edits.apply": "Copilot Edits",
  "github.copilot.chat.applyInEditor": "Chat -> Apply in Editor",
  "github.copilot.chat.insertAtCursor": "Chat -> Insert at Cursor",
  "github.copilot.fixes.apply": "Copilot Fix",
  "github.copilot.generateTests.apply": "Copilot Generate Tests",
  "github.copilot.generateDocs.apply": "Copilot Generate Docs",
};

let outputChannel;
let activationTimer;
let copilotLogTimer;
let pendingTool = null;
let pendingToolTime = 0;
let lastCopilotLogActivityAt = 0;
let lastPromptContext = null;
let watchedCopilotLogPath = null;
let watchedCopilotLogSize = 0;
let commitPollTimer;

const extensionStates = new Map();
const seenCopilotLogLines = new Set();
const narratorSnapshots = new Map();
const narratorPending = new Map();
const repoHeads = new Map();

class SidebarProvider {
  static viewType = "lcn.sidebar";

  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.lastDocsJson = "[]";
    this.pollTimer = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "openFile" && typeof msg.filePath === "string") {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.filePath));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (error) {
          log(`openFile failed: ${error?.message || String(error)}`);
        }
      }
      if (
        msg?.type === "vote" &&
        typeof msg.id === "string" &&
        (msg.direction === "up" || msg.direction === "down")
      ) {
        const cfg = getNarratorConfig();
        try {
          await fetchJson(`${trimSlash(cfg.backendUrl)}/docs/${msg.id}/vote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ direction: msg.direction }),
          });
        } catch (error) {
          log(`vote failed: ${error?.message || String(error)}`);
        }
      }
    });
    this.startPolling();
  }

  notifyDocs(docs) {
    this.lastDocsJson = JSON.stringify(docs);
    this.view?.webview.postMessage({ type: "docs", docs });
  }

  startPolling() {
    const poll = async () => {
      const cfg = getNarratorConfig();
      try {
        const payload = await fetchJson(`${trimSlash(cfg.backendUrl)}/docs?limit=25`);
        const docs = Array.isArray(payload.docs) ? payload.docs : [];
        const next = JSON.stringify(docs);
        if (next !== this.lastDocsJson) {
          this.lastDocsJson = next;
          this.view?.webview.postMessage({ type: "docs", docs });
        }
      } catch {}
    };
    void poll();
    this.pollTimer = setInterval(() => void poll(), 1500);
    this.context.subscriptions.push({ dispose: () => this.pollTimer && clearInterval(this.pollTimer) });
  }

  renderHtml(webview) {
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!doctype html><html><head>
      <meta charset="utf-8"/>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http: https:;">
      <style>
        :root{
          --bg0:#181825;--bg1:#1e1e2e;--bg2:#232634;--bg3:#313244;--line:#45475a;
          --text:#cdd6f4;--muted:#6c7086;--green:#a6e3a1;--blue:#89b4fa;--mauve:#cba6f7;--yellow:#fab387;--pink:#f38ba8;
        }
        *{box-sizing:border-box}
        body{margin:0;background:var(--bg0);color:var(--text);font:12px var(--vscode-font-family)}
        .shell{display:grid;grid-template-rows:auto auto 1fr auto;height:100vh;background:linear-gradient(180deg,rgba(137,180,250,.04),transparent 30%),var(--bg0)}
        .titlebar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);background:rgba(24,24,37,.96)}
        .dot{width:9px;height:9px;border-radius:50%}.d1{background:#ff5f57}.d2{background:#febc2e}.d3{background:#28c840}
        .titlemeta{min-width:0}
        .appname{font-size:11px;font-weight:600;color:var(--text)}
        .apptag{font-size:10px;color:var(--muted)}
        .status{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:10px;color:var(--green)}
        .live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 12px rgba(166,227,161,.65)}
        .tabbar{display:flex;align-items:center;border-bottom:1px solid var(--line);background:var(--bg0)}
        .tab{padding:7px 12px;font-size:10px;color:var(--muted);border-right:1px solid var(--line);cursor:pointer}
        .tab.active{color:var(--text);background:var(--bg1);border-top:1px solid var(--blue)}
        .panel{display:none;height:100%;overflow:auto}
        .panel.active{display:block}
        .frame{display:grid;grid-template-columns:150px 1fr;height:100%}
        .explorer{border-right:1px solid var(--line);background:rgba(24,24,37,.8);padding:8px 0}
        .explabel{padding:0 12px 6px;font-size:9px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
        .file{display:flex;align-items:center;gap:6px;padding:5px 12px;color:var(--muted);cursor:pointer;font-size:10px}
        .file.active,.file:hover{background:var(--bg3);color:var(--text)}
        .editor{padding:12px;background:var(--bg1)}
        .editor-meta{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:10px;color:var(--muted)}
        .editor-chip{padding:2px 7px;border-radius:999px;border:1px solid var(--line);background:rgba(137,180,250,.08);color:var(--blue)}
        pre{margin:0;white-space:pre-wrap;word-break:break-word;border:1px solid var(--line);border-radius:8px;background:#171722;padding:12px;color:var(--text);line-height:1.55}
        .docs-wrap{padding:10px;display:flex;flex-direction:column;gap:8px}
        .voicebar{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg1);padding:8px 10px}
        .vwave{display:flex;align-items:flex-end;gap:2px;height:16px}
        .vbar{width:3px;border-radius:999px;background:var(--mauve);animation:wave var(--d,.45s) ease-in-out infinite alternate}
        @keyframes wave{from{height:3px}to{height:14px}}
        .vtxt{font-size:10px;color:var(--green);line-height:1.4}
        .card{border:1px solid var(--line);border-radius:8px;background:var(--bg1);padding:10px}
        .card.new{border-color:var(--blue);box-shadow:0 0 0 1px rgba(137,180,250,.2) inset}
        .meta{display:flex;align-items:center;gap:6px;margin-bottom:6px}
        .avatar{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bg3);color:var(--mauve);font-size:8px;font-weight:700}
        .name{font-size:10px;color:var(--blue)}
        .time{margin-left:auto;font-size:9px;color:var(--muted)}
        .fileline{font-size:9px;color:var(--yellow);margin-bottom:5px}
        .summary{font-size:11px;line-height:1.55;color:var(--text)}
        .tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
        .tag{padding:2px 6px;border-radius:999px;font-size:9px}
        .tag.pur{background:#2a1f3d;color:var(--mauve)}
        .tag.grn{background:#1a2f1a;color:var(--green)}
        .actions{display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
        .btn{border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--muted);padding:3px 8px;font-size:9px;cursor:pointer}
        .btn.good{border-color:rgba(166,227,161,.35);color:var(--green)}
        .btn.bad{border-color:rgba(243,139,168,.35);color:var(--pink)}
        .empty{padding:14px;border:1px dashed var(--line);border-radius:8px;color:var(--muted);font-size:11px;background:rgba(30,30,46,.55)}
        .statusbar{display:flex;align-items:center;gap:10px;padding:6px 10px;border-top:1px solid var(--line);background:var(--bg3);font-size:9px;color:var(--muted)}
        .statusbar .ok{color:var(--green)}
        .statusbar .strong{color:var(--text)}
      </style></head><body>
      <div class="shell">
        <div class="titlebar">
          <div class="dot d1"></div><div class="dot d2"></div><div class="dot d3"></div>
          <div class="titlemeta">
            <div class="appname">Hackbyte Narrator</div>
            <div class="apptag">merged detector + live docs</div>
          </div>
          <div class="status"><div class="live-dot"></div><span>live</span></div>
        </div>
        <div class="tabbar">
          <div class="tab" data-tab="explorer">Explorer</div>
          <div class="tab" data-tab="editor">Editor</div>
          <div class="tab active" data-tab="docs">Live Docs</div>
        </div>
        <div id="explorer" class="panel"></div>
        <div id="editor" class="panel"></div>
        <div id="docs" class="panel active"></div>
        <div class="statusbar">
          <span class="ok">SpacetimeDB ready</span>
          <span class="strong">VS Code extension active</span>
          <span id="doc-count">0 docs</span>
          <span style="margin-left:auto" id="active-file">waiting for save</span>
        </div>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi(); let docs = []; let active = "docs"; const votes = new Map();
        const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
        const tail = (s) => { s = String(s || ""); const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf(String.fromCharCode(92))); return i >= 0 ? s.slice(i + 1) : s; };
        const initials = (s) => String(s || "?").split(/\\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
        const relTime = (value) => { if(!value) return "just now"; const date = new Date(value); if(Number.isNaN(date.getTime())) return String(value); const diff = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000)); if(diff < 1) return "just now"; if(diff < 60) return diff + " min ago"; if(diff < 1440) return Math.round(diff / 60) + " hr ago"; return Math.round(diff / 1440) + " d ago"; };
        const tagTone = (index) => index % 2 === 0 ? "pur" : "grn";
        function setTab(name){ active = name; document.querySelectorAll(".tab").forEach((b)=>b.classList.toggle("active", b.dataset.tab===name)); document.querySelectorAll(".panel").forEach((p)=>p.classList.toggle("active", p.id===name)); }
        function render(){
          const files = [...new Set(docs.map((d)=>d.filePath).filter(Boolean))];
          const latest = docs[0];
          document.getElementById("doc-count").textContent = docs.length + " docs";
          document.getElementById("active-file").textContent = latest?.filePath ? tail(latest.filePath) : "waiting for save";
          document.getElementById("explorer").innerHTML = '<div class="frame"><div class="explorer"><div class="explabel">Explorer</div>' + (files.map((fp, index)=>'<div class="file'+(index===0?' active':'')+'" data-fp="'+esc(fp)+'">'+esc(tail(fp))+'</div>').join("") || '<div class="empty" style="margin:0 10px">No docs yet</div>') + '</div><div class="editor"><div class="editor-meta"><span>Tracked files</span><span class="editor-chip">'+files.length+' items</span></div><pre>' + esc(files.join("\\n") || "Save a file to populate explorer state.") + '</pre></div></div>';
          document.querySelectorAll(".file").forEach((el)=>el.onclick=()=>vscode.postMessage({type:"openFile", filePath:el.dataset.fp}));
          document.getElementById("editor").innerHTML = latest ? '<div class="frame"><div class="explorer"><div class="explabel">Context</div><div class="file active">'+esc(tail(latest.filePath || "unknown"))+'</div><div class="file">'+esc(latest.language || "text")+'</div><div class="file">'+esc(relTime(latest.createdAt))+'</div></div><div class="editor"><div class="editor-meta"><span>'+esc(latest.language || "text")+'</span><span class="editor-chip">'+esc(tail(latest.filePath || "unknown"))+'</span></div><pre>'+esc(latest.diff || "")+'</pre></div></div>' : '<div class="docs-wrap"><div class="empty">Save a file to generate a diff.</div></div>';
          document.getElementById("docs").innerHTML = '<div class="docs-wrap"><div class="voicebar"><div class="vwave"><div class="vbar" style="--d:.35s"></div><div class="vbar" style="--d:.5s"></div><div class="vbar" style="--d:.25s"></div><div class="vbar" style="--d:.45s"></div><div class="vbar" style="--d:.3s"></div></div><div class="vtxt">' + esc(latest?.summary || "Waiting for the next narrated code update...") + '</div></div>' + (docs.map((d, index)=>'<div class="card'+(index===0?' new':'')+'"><div class="meta"><div class="avatar">'+esc(initials(d.author || "dev"))+'</div><div class="name">'+esc(d.author || "Developer")+'</div><div class="time">'+esc(relTime(d.createdAt))+'</div></div><div class="fileline">'+esc(tail(d.filePath || "unknown"))+' | '+esc(d.language || "text")+'</div><div class="summary">'+esc(d.summary || "")+'</div><div class="tags">'+((d.tags||[]).map((t, tagIndex)=>'<span class="tag '+tagTone(tagIndex)+'">#'+esc(t)+'</span>').join(""))+'</div><div class="actions"><span style="font-size:9px;color:var(--muted)">Accurate?</span><button class="btn good" data-id="'+esc(d.id)+'" data-dir="up">thumbs up</button><button class="btn bad" data-id="'+esc(d.id)+'" data-dir="down">flag</button></div></div>').join("") || '<div class="empty">Waiting for live docs.</div>') + '</div>';
          document.querySelectorAll(".btn[data-id]").forEach((el)=>el.onclick=()=>vscode.postMessage({type:"vote", id:el.dataset.id, direction:el.dataset.dir}));
        }
        window.addEventListener("message",(e)=>{ if(e.data?.type==="docs"){ docs = Array.isArray(e.data.docs) ? e.data.docs : []; render(); } });
        document.querySelectorAll(".tab").forEach((b)=>b.onclick=()=>setTab(b.dataset.tab)); render();
      </script></body></html>`;
  }
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Hackbyte Code Narrator");
  const sidebar = new SidebarProvider(context);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar));

  registerCommands(context);
  registerListeners(context, sidebar);

  activationTimer = setInterval(() => void pollAiExtensionActivation(), 2000);
  copilotLogTimer = setInterval(() => void pollCopilotLogs(), 3000);
  commitPollTimer = setInterval(() => void pollWorkspaceCommits(), 12000);
  context.subscriptions.push({
    dispose() {
      if (activationTimer) clearInterval(activationTimer);
      if (copilotLogTimer) clearInterval(copilotLogTimer);
      if (commitPollTimer) clearInterval(commitPollTimer);
      for (const item of narratorPending.values()) clearTimeout(item.timer);
    },
  });

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file" && !doc.isUntitled) {
      narratorSnapshots.set(doc.uri.fsPath, { text: doc.getText(), version: doc.version });
    }
  }

  log("Merged VS Code extension started.");
  void pollAiExtensionActivation(true);
  void pollCopilotLogs(true);
  void pollWorkspaceCommits(true);
}

function deactivate() {
  if (activationTimer) clearInterval(activationTimer);
  if (copilotLogTimer) clearInterval(copilotLogTimer);
  if (commitPollTimer) clearInterval(commitPollTimer);
}

function registerCommands(context) {
  context.subscriptions.push(vscode.commands.registerCommand("commitConfessional.showOutput", () => outputChannel.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand("lcn.showLog", () => outputChannel.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand("commitConfessional.inspectAiExtensions", () => {
    const snapshot = getWatchedExtensions().map((id) => {
      const ext = vscode.extensions.getExtension(id);
      return `${id}: ${ext ? (ext.isActive ? "active" : "installed-inactive") : "not-installed"}`;
    });
    outputChannel.appendLine(snapshot.join("\n"));
    outputChannel.show(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("commitConfessional.listMatchingExtensions", () => {
    const matches = vscode.extensions.all.map((ext) => ext.id).filter((id) => /(copilot|codex|openai|chatgpt)/i.test(id)).sort();
    outputChannel.appendLine(matches.length ? matches.join("\n") : "No matching extensions found.");
    outputChannel.show(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("commitConfessional.debugStatus", async () => {
    outputChannel.clear();
    outputChannel.appendLine(`Detector log: ${LOG_PATH}`);
    outputChannel.appendLine(`Commit backend: ${getCommitConfig("backendUrl") || "NOT SET"}`);
    outputChannel.appendLine(`Narrator backend: ${getNarratorConfig().backendUrl}`);
    outputChannel.appendLine(`Current tool: ${currentTool()}`);
    outputChannel.appendLine(`Clipboard length: ${(await readClipboardSafe()).length}`);
    outputChannel.show(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("lcn.pingBackend", async () => {
    const cfg = getNarratorConfig();
    try {
      const response = await fetch(`${trimSlash(cfg.backendUrl)}/health`);
      log(`LCN /health ${response.status}`);
      void vscode.window.showInformationMessage(`LCN backend ${response.status}`);
    } catch (error) {
      log(`LCN health failed: ${error?.message || String(error)}`);
      void vscode.window.showErrorMessage(`LCN backend unavailable`);
    }
  }));
}

function registerListeners(context, sidebar) {
  const onWillExecuteCommand = vscode.commands.onWillExecuteCommand;
  if (typeof onWillExecuteCommand === "function") {
    context.subscriptions.push(onWillExecuteCommand((event) => {
      const toolName = COPILOT_COMMANDS[event?.command];
      if (!toolName) return;
      pendingTool = toolName;
      pendingToolTime = Date.now();
      appendJsonLine({ label: "copilot-command", provider: "copilot", command: event.command, tool: toolName });
      log(`copilot-command: ${event.command} -> ${toolName}`);
    }));
  }
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => void handleDocumentChange(event)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => void handleNarratorSave(doc, sidebar)));
}

async function handleDocumentChange(event) {
  if (!event?.contentChanges?.length || shouldIgnoreDocument(event.document)) return;
  const change = event.contentChanges[0];
  const insertedText = String(change.text || "");
  if (!insertedText.trim()) return;

  const now = Date.now();
  const documentPath = event.document?.uri?.fsPath || event.document?.uri?.toString() || "unknown";
  const promptPreview = buildPreview(insertedText);
  const looksTyped = insertedText.length === 1 && !insertedText.includes("\n");
  if (looksTyped) return;

  const clipboardText = await readClipboardSafe();
  const isPaste = detectPaste(insertedText, clipboardText);
  const source = classifyInsertionSource(now, isPaste, insertedText);
  if (source === "typed") return;

  lastPromptContext = {
    source,
    createdAt: now,
    preview: buildPreview(isPaste ? clipboardText : insertedText),
    documentPath,
  };

  await emitCommitEvent(source === "paste-event" ? "paste-detected" : "inline-suggestion", {
    appName: "vscode",
    provider: source === "inline-suggestion" ? "copilot" : "editor",
    extensionId: "vscode.editor",
    documentPath,
    method: source === "inline-suggestion" ? "SUGGESTION" : "PASTE",
    eventType: source,
    clipboardPreview: buildPreview(clipboardText),
    promptPreview,
    contentHash: hashContent(isPaste ? clipboardText : insertedText),
    lineCount: insertedText.split(/\r?\n/).length,
    contentText: isPaste ? clipboardText : insertedText,
    tool: currentTool(),
  });
}

async function handleNarratorSave(doc, sidebar) {
  if (doc.isUntitled || doc.uri.scheme !== "file") return;
  const cfg = getNarratorConfig();
  const fsPath = doc.uri.fsPath;
  if (isIgnoredByNarrator(fsPath, cfg.ignoreGlobs)) return;

  const previous = narratorSnapshots.get(fsPath)?.text ?? "";
  const next = doc.getText();
  narratorSnapshots.set(fsPath, { text: next, version: doc.version });

  const diff = createUnifiedDiff(fsPath, previous, next);
  const changedLines = countChangedLines(diff);
  if (changedLines < cfg.minChangedLines) return;

  const existing = narratorPending.get(fsPath);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    narratorPending.delete(fsPath);
    const payload = {
      sessionId: DEFAULT_SESSION_ID,
      author: vscode.env.machineId ? `dev-${vscode.env.machineId.slice(0, 6)}` : "dev",
      filePath: fsPath,
      language: doc.languageId,
      diff,
      context: next.slice(0, 8000),
      changedLines,
      source: "vscode",
    };
    try {
      const response = await fetchJson(`${trimSlash(cfg.backendUrl)}/deltas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response?.doc) sidebar.notifyDocs([response.doc]);
      log(`LCN delta sent: ${fsPath}`);
    } catch (error) {
      log(`LCN delta failed: ${error?.message || String(error)}`);
    }
  }, cfg.debounceMs);

  narratorPending.set(fsPath, { timer });
}

async function pollAiExtensionActivation(initial = false) {
  const now = Date.now();
  for (const extensionId of getWatchedExtensions()) {
    const extension = vscode.extensions.getExtension(extensionId);
    const isActive = Boolean(extension?.isActive);
    const previous = extensionStates.get(extensionId);
    extensionStates.set(extensionId, isActive);
    if (initial || !extension || !isActive || previous === isActive) continue;
    const recentPrompt = getRecentPromptContext(now);
    await emitCommitEvent("ai-activated", {
      appName: "vscode",
      provider: detectProviderFromExtensionId(extensionId),
      extensionId,
      eventType: "ai-activated",
      method: "ACTIVATE",
      documentPath: recentPrompt?.documentPath || getActiveDocumentPath(),
      promptPreview: recentPrompt?.preview || "none",
      clipboardPreview: recentPrompt?.source === "paste-event" ? recentPrompt.preview : "none",
      endpoint: `vscode-extension://${extensionId}`,
      tabTitle: vscode.window.activeTextEditor?.document?.fileName || "",
    });
  }
}

async function pollWorkspaceCommits(initial = false) {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const repoRoot = folder.uri.fsPath;
    let headSha = "";
    try {
      headSha = (await runGit(["rev-parse", "HEAD"], repoRoot)).trim();
    } catch {
      continue;
    }

    const previousHead = repoHeads.get(repoRoot);
    repoHeads.set(repoRoot, headSha);
    if (initial || !previousHead || previousHead === headSha) {
      continue;
    }

    try {
      const diffText = await runGit(["show", "--format=", "--unified=0", headSha], repoRoot);
      const latestCommit = await runGit(["show", "-s", "--format=%s", headSha], repoRoot);
      await fetch(`${trimSlash(getCommitConfig("backendUrl") || "http://127.0.0.1:4000/api/extension/events").replace(/\/api\/extension\/events$/, "")}/api/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitHash: headSha,
          diffText,
          receiptUrl: `commit://${headSha}`,
          commitMessage: latestCommit.trim(),
        }),
      });
      log(`Commit receipt published for ${headSha.slice(0, 8)}`);
    } catch (error) {
      log(`Commit receipt publish failed: ${error?.message || String(error)}`);
    }
  }
}

async function emitCommitEvent(label, payload) {
  appendJsonLine({ label, source: payload.eventType || label, ...payload });
  const backendUrl = getCommitConfig("backendUrl");
  if (!backendUrl) return;
  try {
    await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, userAgent: "vscode-extension" }),
    });
  } catch (error) {
    log(`commit backend failed: ${error?.message || String(error)}`);
  }
}

async function pollCopilotLogs(initial = false) {
  const latestLog = findLatestCopilotLog();
  if (!latestLog) {
    if (initial) log("No Copilot log file found.");
    return;
  }
  if (watchedCopilotLogPath !== latestLog.fullPath) {
    watchedCopilotLogPath = latestLog.fullPath;
    watchedCopilotLogSize = 0;
    seenCopilotLogLines.clear();
  }
  const chunk = readNewLogChunk(watchedCopilotLogPath, watchedCopilotLogSize);
  if (!chunk) return;
  watchedCopilotLogSize = chunk.nextOffset;
  for (const line of chunk.lines) {
    const normalizedLine = String(line || "").trim();
    const model = extractModelHint(normalizedLine);
    const dedupeKey = `${watchedCopilotLogPath}|${normalizedLine}`;
    if (!model || seenCopilotLogLines.has(dedupeKey)) continue;
    seenCopilotLogLines.add(dedupeKey);
    lastCopilotLogActivityAt = Date.now();
    const tool = inferToolFromCopilotLogLine(normalizedLine);
    if (tool) {
      pendingTool = tool;
      pendingToolTime = Date.now();
    }
    appendJsonLine({ label: "model-query", source: "copilot-log", provider: "copilot", model, rawLine: normalizedLine });
  }
}

function getWatchedExtensions() {
  const configured = getCommitConfig("aiExtensions");
  return Array.isArray(configured) ? configured : [];
}

function getRecentPromptContext(now) {
  if (!lastPromptContext) return null;
  return now - lastPromptContext.createdAt <= Number(getCommitConfig("promptWindowMs") || 60000)
    ? lastPromptContext
    : null;
}

function getActiveDocumentPath() {
  return vscode.window.activeTextEditor?.document?.uri?.fsPath || "unknown";
}

function currentTool() {
  if (pendingTool && Date.now() - pendingToolTime < TOOL_WINDOW_MS) return pendingTool;
  if (Date.now() - lastCopilotLogActivityAt < COPILOT_LOG_WINDOW_MS) return "Copilot (log activity)";
  return "Human / Unknown";
}

function classifyInsertionSource(now, isPaste, insertedText) {
  if (isPaste) return "paste-event";
  if ((currentTool() !== "Human / Unknown" || now - lastCopilotLogActivityAt < COPILOT_LOG_WINDOW_MS) && insertedText.length > 20) {
    return "inline-suggestion";
  }
  return "typed";
}

function detectPaste(insertedText, clipboardText) {
  const minLength = Number(getCommitConfig("pasteMinLength") || 12);
  return normalizeWhitespace(insertedText).length >= minLength && normalizeWhitespace(insertedText) === normalizeWhitespace(clipboardText);
}

function detectProviderFromExtensionId(extensionId) {
  const value = String(extensionId || "").toLowerCase();
  if (value.includes("copilot")) return "copilot";
  if (value.includes("codex")) return "codex";
  if (value.includes("openai") || value.includes("chatgpt")) return "openai";
  return "unknown";
}

function shouldIgnoreDocument(document) {
  const scheme = String(document?.uri?.scheme || "");
  const fileName = String(document?.fileName || "");
  return scheme === "output" || scheme === "extension-output" || fileName.endsWith(".log");
}

function getCommitConfig(key) {
  return vscode.workspace.getConfiguration("commitConfessional").get(key);
}

function getNarratorConfig() {
  const cfg = vscode.workspace.getConfiguration("lcn");
  return {
    backendUrl: cfg.get("backendUrl", "http://localhost:8787"),
    debounceMs: cfg.get("debounceMs", 5000),
    minChangedLines: cfg.get("minChangedLines", 1),
    ignoreGlobs: cfg.get("ignoreGlobs", ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/*.map", "**/*lock*.json"]),
  };
}

function isIgnoredByNarrator(filePath, globs) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function globToRegExp(glob) {
  let pattern = String(glob || "").replace(/\\/g, "/").replace(/[|{}()[\]^$+?.]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`, "i");
}

function createUnifiedDiff(filePath, beforeText, afterText) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const max = Math.max(before.length, after.length);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`, `@@ -1,${before.length} +1,${after.length} @@`];
  for (let i = 0; i < max; i += 1) {
    if (before[i] === after[i]) {
      if (before[i] !== undefined) lines.push(` ${before[i]}`);
      continue;
    }
    if (before[i] !== undefined) lines.push(`-${before[i]}`);
    if (after[i] !== undefined) lines.push(`+${after[i]}`);
  }
  return lines.join("\n");
}

function countChangedLines(diff) {
  return (diff.match(/^\+[^+]/gm) || []).length + (diff.match(/^-[^-]/gm) || []).length;
}

function splitLines(value) {
  return value ? String(value).replace(/\r/g, "").split("\n") : [];
}

function findLatestCopilotLog() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const logsRoot = path.join(appData, "Code", "logs");
  if (!fs.existsSync(logsRoot)) return null;
  return walkLogFiles(logsRoot).filter((file) => /copilot/i.test(file.fullPath)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

function walkLogFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".log")) {
        try {
          const stats = fs.statSync(fullPath);
          results.push({ fullPath, mtimeMs: stats.mtimeMs, size: stats.size });
        } catch {}
      }
    }
  }
  return results;
}

function readNewLogChunk(filePath, offset) {
  let stats;
  try { stats = fs.statSync(filePath); } catch { return null; }
  const start = stats.size < offset ? 0 : offset;
  if (stats.size === start) return null;
  const buffer = Buffer.alloc(stats.size - start);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  return { nextOffset: stats.size, lines: buffer.toString("utf8").split(/\r?\n/) };
}

function extractModelHint(line) {
  for (const pattern of [/claude[- ]?[a-z0-9.]*/i, /gpt[- ]?[0-9a-z.]*/i, /gemini[- ]?[0-9a-z.]*/i, /o[0-9][ -]?[a-z0-9]*/i]) {
    const match = String(line || "").match(pattern);
    if (match) return match[0];
  }
  return null;
}

function inferToolFromCopilotLogLine(line) {
  const value = String(line || "").toLowerCase();
  if (value.includes("[panel/editagent]")) return "Copilot Chat Edit";
  if (value.includes("[copilotlanguagemodelwrapper]")) return "Copilot Inline Suggestion";
  if (value.includes("[title]") || value.includes("[progressmessages]")) return "Copilot Chat";
  return null;
}

function appendJsonLine(payload) {
  try { fs.appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`, "utf8"); } catch {}
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildPreview(value) {
  const text = normalizeWhitespace(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function hashContent(value) {
  const normalized = normalizeWhitespace(value);
  return normalized ? `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}` : null;
}

async function readClipboardSafe() {
  try { return await vscode.env.clipboard.readText(); } catch { return ""; }
}

function log(message) {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

module.exports = { activate, deactivate };
