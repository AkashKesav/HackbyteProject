import * as vscode from 'vscode';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { nanoid } from 'nanoid';

type Snapshot = {
  text: string;
  version: number;
};

type Pending = {
  timer: NodeJS.Timeout;
  latest: {
    uri: vscode.Uri;
    languageId: string;
    filePath: string;
    diff: string;
    context: string;
    changedLines: number;
  };
};

const DEFAULT_SESSION_ID = 'local-dev';

let output: vscode.OutputChannel | undefined;

function log(msg: string) {
  output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getConfig() {
  // Use the `lcn` section — flat keys like `lcn.backendUrl` are read as section `lcn`, key `backendUrl`.
  const cfg = vscode.workspace.getConfiguration('lcn');
  return {
    backendUrl: cfg.get<string>('backendUrl', 'http://localhost:8787'),
    debounceMs: cfg.get<number>('debounceMs', 5000),
    minChangedLines: cfg.get<number>('minChangedLines', 1),
    ignoreGlobs: cfg.get<string[]>('ignoreGlobs', [])
  };
}

function isIgnored(filePath: string, globs: string[]) {
  return globs.some((g) => minimatch(filePath.replace(/\\/g, '/'), g, { dot: true }));
}

function countChangedLines(unifiedDiff: string) {
  const add = (unifiedDiff.match(/^\+[^+]/gm) ?? []).length;
  const del = (unifiedDiff.match(/^-[-]/gm) ?? []).length;
  return add + del;
}

async function postDelta(payload: unknown, backendUrl: string) {
  const res = await fetch(`${backendUrl.replace(/\/$/, '')}/deltas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as unknown;
}

class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lcn.sidebar';

  private view: vscode.WebviewView | undefined;
  private lastDocsJson: string = '[]';
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'openFile' && typeof msg.filePath === 'string') {
        const uri = vscode.Uri.file(msg.filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          // ignore
        }
      } else if (msg.type === 'vote' && typeof msg.id === 'string' && typeof msg.direction === 'string') {
        const { backendUrl } = getConfig();
        try {
          await fetch(`${backendUrl.replace(/\/$/, '')}/docs/${msg.id}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction: msg.direction })
          });
        } catch {
          // ignore
        }
      }
    });

    this.startPolling();
  }

  public notifyDocFeedChanged(docs: unknown) {
    this.lastDocsJson = JSON.stringify(docs);
    this.view?.webview.postMessage({ type: 'docs', docs });
  }

  private startPolling() {
    const poll = async () => {
      const { backendUrl } = getConfig();
      try {
        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/docs?limit=25`);
        if (!res.ok) {
          log(`Poll /docs failed: ${res.status}`);
          return;
        }
        const json = (await res.json()) as { docs?: unknown };
        const next = JSON.stringify(json.docs ?? []);
        if (next !== this.lastDocsJson) {
          this.lastDocsJson = next;
          log(`Poll /docs ok: ${(json.docs as any[])?.length ?? 0} docs`);
          this.view?.webview.postMessage({ type: 'docs', docs: json.docs ?? [] });
        }
      } catch (e) {
        log(`Poll /docs error: ${String(e)}`);
      }
    };

    void poll();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void poll(), 1500);
    this.ctx.subscriptions.push({ dispose: () => this.pollTimer && clearInterval(this.pollTimer) });
  }

  private renderHtml(webview: vscode.Webview) {
    const nonce = nanoid();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src http: https:`
    ].join('; ');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root{
      --bg:#0f1116; --panel:#151a23; --card:#0f141d; --muted:#9aa4b2; --text:#e6e9ef; --border:rgba(255,255,255,.08); --accent:#7c5cff;
      --vscode-font: var(--vscode-font-family, ui-sans-serif);
    }
    *{box-sizing:border-box}
    body{margin:0; font-family:var(--vscode-font); background:var(--bg); color:var(--text)}
    .titlebar{padding:8px 10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; background:linear-gradient(180deg, rgba(124,92,255,.12), transparent)}
    .title{font-weight:700; font-size:12px}
    .statusDot{width:8px;height:8px;border-radius:999px;background:rgba(255,255,255,.25)}
    .tabs{display:flex; gap:6px; padding:8px 10px; border-bottom:1px solid var(--border)}
    .tab{font-size:11px; color:var(--muted); padding:4px 8px; border:1px solid var(--border); border-radius:8px; background:transparent; cursor:pointer}
    .tab.active{border-color:rgba(124,92,255,.35); color:rgba(230,233,239,.95); background:rgba(124,92,255,.12)}
    .layout{min-height: calc(100vh - 66px); padding:10px}
    .explorer{padding:10px; background:rgba(0,0,0,.15); border:1px solid var(--border); border-radius:12px}
    .explorerTitle{font-size:11px; color:var(--muted); margin-bottom:8px}
    .fileItem{font-size:11px; padding:6px 6px; border-radius:8px; cursor:pointer}
    .fileItem:hover{background:rgba(255,255,255,.06)}
    .main{display:grid; grid-template-columns: 1fr; gap:10px}
    .panel{border:1px solid var(--border); background:var(--panel); border-radius:12px; overflow:hidden}
    .panelHead{padding:8px 10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center}
    .panelHeadTitle{font-size:11px; color:var(--muted)}
    .editor{padding:10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:11px}
    pre{margin:0; white-space:pre-wrap; word-break:break-word}
    .wave{height:42px; background:linear-gradient(90deg, rgba(124,92,255,.25), rgba(124,92,255,.05)); border-bottom:1px solid var(--border)}
    .cards{padding:10px; display:grid; gap:10px}
    .card{border:1px solid var(--border); background:var(--card); border-radius:12px; padding:10px}
    .cardTop{display:flex; justify-content:space-between; gap:8px; align-items:baseline}
    .cardFile{font-weight:650; font-size:12px}
    .chip{font-size:10px; color:var(--muted); border:1px solid var(--border); border-radius:999px; padding:2px 7px}
    .summary{margin-top:6px; font-size:12px; line-height:1.35}
    .tags{margin-top:8px; display:flex; flex-wrap:wrap; gap:6px}
    .tag{font-size:10px; color:rgba(124,92,255,.95)}
    .dcvote{display:flex; align-items:center; gap:6px; margin-top:8px; padding-top:8px; border-top:1px solid var(--border)}
    .vbtn{font-size:10px; padding:2px 8px; border-radius:6px; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--muted)}
    .vbtn.up{border-color:#8fd0a6;color:#8fd0a6}
    .vbtn.down{border-color:#f38ba8;color:#f38ba8}
    .vbtn.active{background:rgba(255,255,255,.06)}
    .statusbar{border-top:1px solid var(--border); padding:7px 10px; font-size:11px; color:var(--muted); display:flex; justify-content:space-between}
    .inputbar{border-top:1px solid var(--border); padding:8px 10px; display:flex; gap:8px; align-items:center}
    input{width:100%; background:rgba(0,0,0,.25); border:1px solid var(--border); border-radius:10px; color:var(--text); padding:8px 10px; font-size:12px}
  </style>
</head>
<body>
  <div class="titlebar">
    <div class="title">Living Codebase Narrator</div>
    <div class="statusDot" title="live"></div>
  </div>
  <div class="tabs">
    <button class="tab" type="button" data-tab="explorer">Explorer</button>
    <button class="tab" type="button" data-tab="editor">Editor</button>
    <button class="tab active" type="button" data-tab="live">Live Docs</button>
  </div>
  <div class="layout" id="layout">
    <div class="explorer" id="explorerPane">
      <div class="explorerTitle">FILES</div>
      <div id="fileList"></div>
    </div>
    <div class="main" id="mainPane">
      <div class="panel" id="editorPane">
        <div class="panelHead"><div class="panelHeadTitle">Editor preview</div><div class="chip" id="editorMeta">waiting…</div></div>
        <div class="editor"><pre id="editorText">// Save a file to generate a diff…</pre></div>
      </div>
      <div class="panel" id="docsPane">
        <div class="panelHead"><div class="panelHeadTitle">Live docs</div><div class="chip" id="docsMeta">0</div></div>
        <div class="wave" title="voice activity"></div>
        <div class="cards" id="cards"></div>
        <div class="inputbar"><button id="speakBtn" style="width:100%; background:rgba(124,92,255,.15); border:1px solid var(--border); border-radius:10px; color:var(--text); padding:8px 10px; font-size:12px; cursor:pointer;">Speak latest</button></div>
        <div class="statusbar"><span id="statusLeft">ready</span><span id="statusRight">polling</span></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let docs = [];
    let lastSpokenId = null;
    const votes = new Map();
    let activeTab = 'live';

    function escapeHtml(s){return String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));}

    async function sendVote(docId, direction){
      vscode.postMessage({ type: 'vote', id: docId, direction });
      votes.set(docId, direction);
      render();
    }

    function speakLatest(){
      const latest = docs[0];
      if (!latest || !latest.summary || lastSpokenId === latest.id) return;
      if (!('speechSynthesis' in window)) return;
      lastSpokenId = latest.id;
      const utterance = new SpeechSynthesisUtterance(latest.summary);
      utterance.rate = 1;
      utterance.pitch = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }

    function pathTail(fp){
      const s = String(fp || '');
      const slash = s.lastIndexOf('/');
      const backslash = s.lastIndexOf(String.fromCharCode(92));
      const idx = Math.max(slash, backslash);
      return idx >= 0 ? s.slice(idx + 1) : s;
    }

    function setActiveTab(tab){
      activeTab = tab;
      document.querySelectorAll('.tab[data-tab]').forEach((el) => {
        const isActive = el.getAttribute('data-tab') === tab;
        el.classList.toggle('active', isActive);
      });

      const explorerPane = document.getElementById('explorerPane');
      const mainPane = document.getElementById('mainPane');
      const editorPane = document.getElementById('editorPane');
      const docsPane = document.getElementById('docsPane');
      if (!explorerPane || !mainPane || !editorPane || !docsPane) return;

      if (tab === 'explorer') {
        explorerPane.style.display = 'block';
        mainPane.style.display = 'none';
        return;
      }

      explorerPane.style.display = 'none';
      mainPane.style.display = 'grid';
      if (tab === 'editor') {
        editorPane.style.display = 'block';
        docsPane.style.display = 'none';
      } else {
        editorPane.style.display = 'none';
        docsPane.style.display = 'block';
      }
    }

    function render(){
      const cards = document.getElementById('cards');
      const fileList = document.getElementById('fileList');
      const docsMeta = document.getElementById('docsMeta');
      const editorText = document.getElementById('editorText');
      const editorMeta = document.getElementById('editorMeta');
      const speakBtn = document.getElementById('speakBtn');
      docsMeta.textContent = String(docs.length);
      if (speakBtn) speakBtn.disabled = docs.length === 0;

      const files = Array.from(new Set(docs.map(d => d.filePath))).slice(0, 20);
      fileList.innerHTML = files.map(fp => '<div class="fileItem" data-fp="'+escapeHtml(fp)+'">'+escapeHtml(pathTail(fp) || fp)+'</div>').join('') || '<div style="color: var(--muted); font-size: 11px;">No docs yet</div>';
      fileList.querySelectorAll('.fileItem').forEach(el => el.addEventListener('click', () => vscode.postMessage({type:'openFile', filePath: el.getAttribute('data-fp')})));

      if (docs[0]) {
        editorText.textContent = docs[0].diff || '';
        editorMeta.textContent = (docs[0].language || 'text');
      }
      cards.innerHTML = docs.map(d => {
        const tags = (d.tags || []).map(t => '<span class="tag">#'+escapeHtml(t)+'</span>').join('');
        const chips = '<span class="chip">'+escapeHtml(d.language || 'text')+'</span><span class="chip">'+escapeHtml(new Date(d.createdAt).toLocaleTimeString())+'</span>';
        const vote = votes.get(d.id);
        return '<div class="card">'
          + '<div class="cardTop"><div class="cardFile">'+escapeHtml(pathTail(d.filePath || '') || d.filePath || 'unknown')+'</div><div style="display:flex; gap:6px">'+chips+'</div></div>'
          + '<div class="summary">'+escapeHtml(d.summary || '')+'</div>'
          + '<div class="tags">'+tags+'</div>'
          + '<div class="dcvote">'
          + '<span style="font-size:10px;color:var(--muted)">Accurate?</span>'
          + '<button class="vbtn up'+(vote==="up"?" active":"")+'" data-id="'+escapeHtml(d.id)+'" data-dir="up">thumbs up</button>'
          + '<button class="vbtn down'+(vote==="down"?" active":"")+'" data-id="'+escapeHtml(d.id)+'" data-dir="down">flag</button>'
          + '</div>'
          + '</div>';
      }).join('') || '<div style="color: var(--muted); font-size: 12px;">Waiting for the first save…</div>';

      cards.querySelectorAll('.vbtn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const el = e.currentTarget;
          const id = el.getAttribute('data-id');
          const dir = el.getAttribute('data-dir');
          if (id && dir) sendVote(id, dir);
        });
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'docs') {
        docs = Array.isArray(msg.docs) ? msg.docs : [];
        render();
        speakLatest();
      }
    });

    document.getElementById('speakBtn')?.addEventListener('click', () => {
      lastSpokenId = null;
      speakLatest();
    });

    document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setActiveTab(btn.getAttribute('data-tab') || 'live');
      });
    });

    render();
    setActiveTab(activeTab);
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Living Codebase Narrator');
  context.subscriptions.push(output);

  const snapshots = new Map<string, Snapshot>();
  const pending = new Map<string, Pending>();
  const provider = new SidebarProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider));

  const author = vscode.env.machineId ? `dev-${vscode.env.machineId.slice(0, 6)}` : 'dev';

  async function handleSave(doc: vscode.TextDocument) {
    if (doc.isUntitled) return;
    if (doc.uri.scheme !== 'file') return;

    const cfg = getConfig();
    const fsPath = doc.uri.fsPath;
    if (isIgnored(fsPath, cfg.ignoreGlobs)) {
      log(`skip (ignored glob): ${fsPath}`);
      return;
    }

    const prev = snapshots.get(fsPath)?.text ?? '';
    const next = doc.getText();
    snapshots.set(fsPath, { text: next, version: doc.version });

    const diff = createTwoFilesPatch(fsPath, fsPath, prev, next, '', '', { context: 3 });
    const changedLines = countChangedLines(diff);
    if (changedLines < cfg.minChangedLines) {
      log(`skip (below minChangedLines=${cfg.minChangedLines}): ${changedLines} lines — ${fsPath}`);
      return;
    }

    const contextText = next.slice(0, 8000);
    const key = fsPath;

    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const latest = {
      uri: doc.uri,
      languageId: doc.languageId,
      filePath: fsPath,
      diff,
      context: contextText,
      changedLines
    };

    log(`queued delta in ${cfg.debounceMs}ms (${changedLines} lines) — ${fsPath}`);

    const timer = setTimeout(async () => {
      pending.delete(key);
      const payload = {
        sessionId: DEFAULT_SESSION_ID,
        author,
        filePath: latest.filePath,
        language: latest.languageId,
        diff: latest.diff,
        context: latest.context,
        changedLines: latest.changedLines,
        source: 'vscode'
      };
      try {
        await postDelta(payload, cfg.backendUrl);
        log(`POST /deltas ok — ${latest.filePath}`);
        void vscode.window.setStatusBarMessage('LCN: doc sent', 2500);
      } catch (e) {
        const msg = String(e);
        log(`POST /deltas failed — ${msg}`);
        vscode.window.setStatusBarMessage(`LCN: failed to send delta (${msg})`, 8000);
        void vscode.window.showErrorMessage(`LCN: ${msg}`, 'Show log').then((c) => {
          if (c === 'Show log') output?.show(true);
        });
      }
    }, cfg.debounceMs);

    pending.set(key, { timer, latest });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('lcn.pingBackend', async () => {
      const { backendUrl } = getConfig();
      try {
        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/health`);
        const text = await res.text();
        log(`GET /health ${res.status} — ${text}`);
        output?.show(true);
        void vscode.window.showInformationMessage(`LCN: backend ${res.status}`);
      } catch (e) {
        log(`GET /health failed — ${String(e)}`);
        output?.show(true);
        void vscode.window.showErrorMessage(`LCN: cannot reach backend (${String(e)})`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lcn.showLog', () => {
      output?.show(true);
    })
  );

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => void handleSave(doc)));

  // seed snapshots for currently opened docs (optional)
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme === 'file' && !d.isUntitled) {
      snapshots.set(d.uri.fsPath, { text: d.getText(), version: d.version });
    }
  }
}

export function deactivate() {}





