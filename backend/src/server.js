import express from "express";
import cors from "cors";
import morgan from "morgan";
import { Proxy } from "http-mitm-proxy";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRepoContext,
  createLatestCommitSnapshot,
  createRecentCommitSnapshots,
  summarizeEventForStorage,
} from "./services/repoContext.js";
import { analyzeProxyEvent, createMockProxyEvent } from "./services/proxyAnalysis.js";
import { buildModelEvidenceReceipt } from "./services/modelEvidence.js";
import { enrichReceiptWithIntegrations } from "./services/receiptIntegrations.js";
import { upsertReceiptHistory } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const dataDir = path.resolve(projectRoot, "backend/data");
const eventLogPath = path.join(dataDir, "proxy-events.json");
const receiptLogPath = path.join(dataDir, "latest-receipt.json");
const receiptHistoryPath = path.join(dataDir, "receipt-history.json");
const githubSessionPath = path.join(dataDir, "github-session.json");
const mitmCaDir = path.join(dataDir, ".http-mitm-proxy");
const PORT = Number(process.env.PORT || 4000);
const SIM_PROXY_PORT = Number(process.env.SIM_PROXY_PORT || 8877);
const REAL_PROXY_PORT = Number(process.env.REAL_PROXY_PORT || 8877);
const ENABLE_LOCAL_PROXY = process.env.ENABLE_LOCAL_PROXY === "true";
const REPO_CONTEXT_REFRESH_MS = 60 * 1000;
let FRONTEND_URL = "http://localhost:5173";
let GITHUB_CLIENT_ID = "";
let GITHUB_CLIENT_SECRET = "";
let GITHUB_OAUTH_CALLBACK_URL = `http://localhost:${PORT}/api/github/callback`;
const GITHUB_STATE_TTL_MS = 10 * 60 * 1000;

await loadEnvFiles();
FRONTEND_URL = process.env.FRONTEND_URL || FRONTEND_URL;
GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
GITHUB_OAUTH_CALLBACK_URL = process.env.GITHUB_OAUTH_CALLBACK_URL || GITHUB_OAUTH_CALLBACK_URL;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(mitmCaDir, { recursive: true });

const state = {
  proxy: {
    configured: false,
    healthy: false,
    lastEventAt: null,
    totalEvents: 0,
    eventSource: "simulation",
    lastHealthCheckAt: null,
  },
  repoContext: await buildRepoContext(projectRoot),
  repoContextUpdatedAt: Date.now(),
  latestCommit: await createLatestCommitSnapshot(projectRoot),
  recentCommits: await createRecentCommitSnapshots(projectRoot, 12),
  captures: await loadStoredCaptures(),
  latestReceipt: await loadStoredReceipt(),
  receiptHistory: await loadReceiptHistory(),
  github: await loadGithubSession(),
  githubStates: new Map(),
};

state.proxy.totalEvents = state.captures.length;
state.proxy.lastEventAt = state.captures[0]?.capturedAt ?? null;
state.proxy.healthy = state.captures.length > 0;

app.get("/api/health", async (_req, res) => {
  await refreshRepoContextIfNeeded(true);
  state.latestCommit = await createLatestCommitSnapshot(projectRoot);
  state.recentCommits = await buildRecentCommitFeed();
  state.proxy.lastHealthCheckAt = new Date().toISOString();

  res.json({
    ok: true,
    now: new Date().toISOString(),
    proxy: state.proxy,
    simulationProxy: {
      enabled: true,
      port: SIM_PROXY_PORT,
      baseUrl: `http://localhost:${PORT}/proxy`,
    },
    browserProxy: {
      enabled: ENABLE_LOCAL_PROXY,
      port: REAL_PROXY_PORT,
      host: "127.0.0.1",
      caCertPath: path.join(mitmCaDir, "certs", "ca.pem"),
    },
    firefoxExtension: {
      enabled: true,
      ingestUrl: `http://127.0.0.1:${PORT}/api/extension/events`,
    },
    repo: state.repoContext.summary,
    latestCommit: state.latestCommit,
    recentCommits: state.recentCommits,
    latestReceipt: state.latestReceipt,
    latestCommitReceipt: findReceiptForCommit(state.latestCommit),
    github: buildGithubStatus(),
    captureCount: state.captures.length,
  });
});

app.get("/api/proxy/status", async (_req, res) => {
  await refreshRepoContextIfNeeded(true);
  state.latestCommit = await createLatestCommitSnapshot(projectRoot);
  state.recentCommits = await buildRecentCommitFeed();

  res.json({
    proxy: state.proxy,
    simulationProxy: {
      enabled: true,
      port: SIM_PROXY_PORT,
      baseUrl: `http://localhost:${PORT}/proxy`,
    },
    browserProxy: {
      enabled: ENABLE_LOCAL_PROXY,
      port: REAL_PROXY_PORT,
      host: "127.0.0.1",
      caCertPath: path.join(mitmCaDir, "certs", "ca.pem"),
    },
    firefoxExtension: {
      enabled: true,
      ingestUrl: `http://127.0.0.1:${PORT}/api/extension/events`,
    },
    repo: state.repoContext.summary,
    latestCommit: state.latestCommit,
    recentCommits: state.recentCommits,
    latestReceipt: state.latestReceipt,
    latestCommitReceipt: findReceiptForCommit(state.latestCommit),
    github: buildGithubStatus(),
    captures: state.captures,
    analytics: {
      contributors: buildContributorSummary(state.captures),
      vulnerabilities: buildVulnerabilitySummary(state.captures),
      aiAssistedCommits: state.captures.filter(
        (capture) => capture.relatedToRepo && capture.model
      ).length,
      unsupportedCapabilities: [
        "GitHub OAuth does not expose a reliable API for device-by-device active session locations.",
        "HTTPS prompt inspection requires the local proxy to terminate TLS with a trusted certificate.",
      ],
    },
  });
});

app.all("/proxy/:provider/*", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const host = mapProviderToHost(provider);

  if (!host) {
    return res.status(400).json({
      ok: false,
      message: "Unsupported provider for simulation proxy",
    });
  }

  const pathSuffix = req.originalUrl.replace(`/proxy/${provider}`, "") || "/";
  const stored = await captureProxyEvent(
    {
      provider,
      host,
      path: pathSuffix,
      method: req.method,
      headers: req.headers,
      body: req.body,
      author: normalizeProxyAuthor(req),
      source: "simulation-proxy",
    },
    "simulation-proxy"
  );

  return res.json(buildMockProviderResponse(provider, stored));
});

app.get("/api/dashboard", async (_req, res) => {
  await refreshRepoContextIfNeeded(true);
  state.latestCommit = await createLatestCommitSnapshot(projectRoot);
  state.recentCommits = await buildRecentCommitFeed();

  res.json({
    proxy: state.proxy,
    repo: state.repoContext.summary,
    latestCommit: state.latestCommit,
    recentCommits: state.recentCommits,
    latestReceipt: state.latestReceipt,
    latestCommitReceipt: findReceiptForCommit(state.latestCommit),
    github: buildGithubStatus(),
    captures: state.captures,
    analytics: {
      contributors: buildContributorSummary(state.captures),
      vulnerabilities: buildVulnerabilitySummary(state.captures),
      aiAssistedCommits: state.captures.filter(
        (capture) => capture.relatedToRepo && capture.model
      ).length,
      unsupportedCapabilities: [
        "GitHub OAuth does not expose a reliable API for device-by-device active session locations.",
        "HTTPS prompt inspection requires the local proxy to terminate TLS with a trusted certificate.",
      ],
    },
  });
});

app.get("/api/proxy/events", (_req, res) => {
  res.json({
    ok: true,
    total: state.captures.length,
    events: state.captures,
  });
});

app.get("/api/proxy/events/:id", (req, res) => {
  const capture = state.captures.find((item) => item.id === req.params.id);

  if (!capture) {
    return res.status(404).json({
      ok: false,
      message: "Capture not found",
    });
  }

  return res.json({
    ok: true,
    capture,
  });
});

app.post("/api/proxy/events", async (req, res) => {
  const stored = await captureProxyEvent(req.body ?? {}, "local-proxy");

  res.status(201).json({
    ok: true,
    message: "Proxy event captured",
    capture: stored,
  });
});

app.post("/api/proxy/capture", async (req, res) => {
  const stored = await captureProxyEvent(req.body ?? {}, "local-proxy");

  res.status(201).json({
    ok: true,
    message: "Proxy request content captured",
    capture: stored,
  });
});

app.post("/api/proxy/simulate", async (req, res) => {
  const provider = req.body?.provider || "openai";
  const mockEvent = createMockProxyEvent(provider, state.repoContext);
  const stored = await captureProxyEvent(mockEvent, "simulation");

  res.status(201).json({
    ok: true,
    message: `Simulated ${provider} proxy capture`,
    capture: stored,
  });
});

app.delete("/api/proxy/events", async (_req, res) => {
  state.captures = [];
  state.proxy.healthy = false;
  state.proxy.totalEvents = 0;
  state.proxy.lastEventAt = null;
  await persistCaptures(state.captures);
  res.json({ ok: true });
});

app.post("/api/proxy/test-request", async (req, res) => {
  const input = req.body ?? {};
  const stored = await captureProxyEvent(input, "manual-test");

  res.status(201).json({
    ok: true,
    message: "Manual proxy test request captured",
    capture: stored,
  });
});

app.post("/api/extension/events", async (req, res) => {
  const input = req.body ?? {};
  const event = normalizeExtensionEvent(input);
  const source = input.appName ? `${input.appName}-extension` : "extension";
  const stored = await captureProxyEvent(event, source);

  res.status(201).json({
    ok: true,
    message: "Extension event captured",
    capture: stored,
  });
});

app.post("/api/receipt", async (req, res) => {
  const receipt = await buildModelEvidenceReceipt(req.body ?? {});
  const enrichedReceipt = await enrichReceiptWithIntegrations(projectRoot, receipt);
  state.latestReceipt = {
    ...enrichedReceipt,
    updatedAt: new Date().toISOString(),
    commitHash: req.body?.commitHash || null,
  };
  await persistReceipt(state.latestReceipt);
  upsertReceiptHistory(state.latestReceipt);
  await persistReceiptHistory(state.receiptHistory);
  res.status(201).json({
    ok: true,
    ...state.latestReceipt,
  });
});

app.get("/api/github/status", (_req, res) => {
  res.json({
    ok: true,
    github: buildGithubStatus(),
  });
});

app.post("/api/github/connect", (_req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.status(400).json({
      ok: false,
      configured: false,
      message: "GitHub OAuth is not configured. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env.",
    });
  }

  const stateToken = crypto.randomBytes(24).toString("hex");
  cleanupGithubStates();
  state.githubStates.set(stateToken, Date.now() + GITHUB_STATE_TTL_MS);

  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", GITHUB_OAUTH_CALLBACK_URL);
  authorizationUrl.searchParams.set("scope", "read:user user:email repo");
  authorizationUrl.searchParams.set("state", stateToken);

  res.json({
    ok: true,
    configured: true,
    authorizationUrl: authorizationUrl.toString(),
  });
});

app.get("/api/github/callback", async (req, res) => {
  const { code, state: stateToken } = req.query;
  cleanupGithubStates();
  const hasState = typeof stateToken === "string" && state.githubStates.has(stateToken);

  if (!code || !stateToken || !hasState) {
    return res.redirect(`${FRONTEND_URL}?github=error&reason=state`);
  }
  state.githubStates.delete(stateToken);

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.redirect(`${FRONTEND_URL}?github=error&reason=config`);
  }

  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_OAUTH_CALLBACK_URL,
        state: stateToken,
      }),
    });

    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenPayload.access_token) {
      throw new Error(tokenPayload.error_description || `GitHub token exchange failed with ${tokenResponse.status}`);
    }

    const [userResponse, emailResponse] = await Promise.all([
      fetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenPayload.access_token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
      fetch("https://api.github.com/user/emails", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenPayload.access_token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
    ]);

    const user = await userResponse.json();
    const emails = emailResponse.ok ? await emailResponse.json() : [];
    const primaryEmail = Array.isArray(emails)
      ? emails.find((item) => item.primary)?.email || emails[0]?.email || null
      : null;

    state.github = {
      connectedAt: new Date().toISOString(),
      accessToken: tokenPayload.access_token,
      scope: tokenPayload.scope || null,
      tokenType: tokenPayload.token_type || "bearer",
      user: {
        login: user.login || null,
        name: user.name || user.login || null,
        avatarUrl: user.avatar_url || null,
        profileUrl: user.html_url || null,
        email: primaryEmail,
      },
    };
    await persistGithubSession(state.github);
    return res.redirect(`${FRONTEND_URL}/?github=connected`);
  } catch (error) {
    return res.redirect(
      `${FRONTEND_URL}/?github=error&reason=${encodeURIComponent(error?.message || String(error))}`
    );
  }
});

app.post("/api/github/logout", async (_req, res) => {
  state.github = null;
  await persistGithubSession(null);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Commit Confessional backend listening on http://localhost:${PORT}`);
  console.log(`Firefox extension ingest available at http://127.0.0.1:${PORT}/api/extension/events`);
  console.log(`Simulation proxy available at http://localhost:${PORT}/proxy/<provider>/...`);
  if (ENABLE_LOCAL_PROXY) {
    console.log(`Browser proxy listening on http://127.0.0.1:${REAL_PROXY_PORT}`);
    console.log(`Import CA certificate from ${path.join(mitmCaDir, "certs", "ca.pem")}`);
  } else {
    console.log("Local MITM proxy disabled. Set ENABLE_LOCAL_PROXY=true to start it.");
  }
});

if (ENABLE_LOCAL_PROXY) {
  startBrowserProxy();
}

async function loadStoredCaptures() {
  try {
    const raw = await fs.readFile(eventLogPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    console.warn("Failed to load stored captures", error);
    return [];
  }
}

async function persistCaptures(captures) {
  await fs.writeFile(eventLogPath, JSON.stringify(captures, null, 2));
}

async function loadStoredReceipt() {
  try {
    const raw = await fs.readFile(receiptLogPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    console.warn("Failed to load latest receipt", error);
    return null;
  }
}

async function persistReceipt(receipt) {
  await fs.writeFile(receiptLogPath, JSON.stringify(receipt, null, 2));
}

async function loadReceiptHistory() {
  try {
    const raw = await fs.readFile(receiptHistoryPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.warn("Failed to load receipt history", error);
    return [];
  }
}

async function persistReceiptHistory(receipts) {
  await fs.writeFile(receiptHistoryPath, JSON.stringify(receipts, null, 2));
}

async function loadGithubSession() {
  try {
    const raw = await fs.readFile(githubSessionPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    console.warn("Failed to load GitHub session", error);
    return null;
  }
}

async function persistGithubSession(session) {
  await fs.writeFile(githubSessionPath, JSON.stringify(session, null, 2));
}

async function captureProxyEvent(input, source) {
  await refreshRepoContextIfNeeded();
  const analysis = analyzeProxyEvent(input, state.repoContext);
  const stored = summarizeEventForStorage(input, analysis);

  state.captures = [stored, ...state.captures].slice(0, 100);
  state.proxy.configured = true;
  state.proxy.healthy = true;
  state.proxy.eventSource = source;
  state.proxy.totalEvents += 1;
  state.proxy.lastEventAt = stored.capturedAt;

  await persistCaptures(state.captures);
  logCaptureToTerminal(stored, source);
  return stored;
}

async function refreshRepoContextIfNeeded(force = false) {
  if (!force && Date.now() - state.repoContextUpdatedAt < REPO_CONTEXT_REFRESH_MS) {
    return;
  }

  try {
    state.repoContext = await buildRepoContext(projectRoot);
    state.repoContextUpdatedAt = Date.now();
  } catch (error) {
    console.warn("Failed to refresh repo context", error?.message || error);
  }
}

async function buildRecentCommitFeed() {
  const localCommits = await createRecentCommitSnapshots(projectRoot, 12);
  const githubCommits = await fetchGithubRepoCommits(12);
  const sourceCommits = githubCommits.length > 0 ? githubCommits : localCommits;

  return sourceCommits.map((commit) => {
    const receipt = matchReceiptToCommit(commit);
    const contribution = receipt?.modelEvidence?.contribution ?? null;
    const copilot = receipt?.copilotContribution ?? receipt?.modelEvidence?.copilotContribution ?? null;

    return {
      ...commit,
      ai: contribution
        ? {
            estimatedAiPercentage: contribution.estimatedAiPercentage,
            aiMatchedLines: contribution.aiMatchedLines,
            totalChangedLines: contribution.totalChangedLines,
            certainty: receipt?.modelEvidence?.certainty ?? "UNKNOWN",
            method: receipt?.modelEvidence?.method ?? null,
            updatedAt: receipt?.updatedAt ?? null,
          }
        : null,
      copilot: copilot
        ? {
            estimatedAiPercentage: copilot.estimatedAiPercentage,
          }
        : null,
    };
  });
}

function mapProviderToHost(provider) {
  const map = {
    openai: "api.openai.com",
    anthropic: "api.anthropic.com",
    google: "generativelanguage.googleapis.com",
    gemini: "generativelanguage.googleapis.com",
    xai: "api.x.ai",
  };

  return map[provider] || null;
}

function buildGithubStatus() {
  if (!state.github?.user) {
    return {
      configured: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
      connected: false,
      user: null,
      connectedAt: null,
    };
  }

  return {
    configured: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
    connected: true,
    user: state.github.user,
    connectedAt: state.github.connectedAt || null,
  };
}

async function fetchGithubRepoCommits(limit = 12) {
  if (!state.github?.accessToken || !state.repoContext.summary.fullName) {
    return [];
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${state.repoContext.summary.fullName}/commits?per_page=${Math.max(1, limit)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${state.github.accessToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      return [];
    }

    const commits = await response.json();
    if (!Array.isArray(commits)) {
      return [];
    }

    return commits.map((entry) => ({
      hash: entry.sha || null,
      shortHash: entry.sha?.slice(0, 7) ?? null,
      authorName: entry.commit?.author?.name || entry.author?.login || null,
      authorEmail: entry.commit?.author?.email || null,
      subject: entry.commit?.message?.split("\n")[0] || "Untitled commit",
      authoredAt: entry.commit?.author?.date || null,
      classification: "unknown",
      note: "GitHub commit synced from the connected repository.",
      htmlUrl: entry.html_url || null,
    }));
  } catch {
    return [];
  }
}

function matchReceiptToCommit(commit) {
  if (!state.latestReceipt || !commit?.hash) {
    return null;
  }

  const receiptHash = String(state.latestReceipt.commitHash || "").toLowerCase();
  const commitHash = String(commit.hash || "").toLowerCase();
  if (!receiptHash || !commitHash) {
    return null;
  }

  return commitHash === receiptHash || commitHash.startsWith(receiptHash) || receiptHash.startsWith(commitHash)
    ? state.latestReceipt
    : null;
}

function findReceiptForCommit(commit) {
  return matchReceiptToCommit(commit);
}

function cleanupGithubStates() {
  const now = Date.now();
  for (const [token, expiresAt] of state.githubStates.entries()) {
    if (expiresAt <= now) {
      state.githubStates.delete(token);
    }
  }
}

async function loadEnvFiles() {
  const envFiles = [
    path.resolve(projectRoot, ".env"),
    path.resolve(projectRoot, ".env.local"),
    path.resolve(projectRoot, "backend", ".env"),
    path.resolve(projectRoot, "backend", ".env.local"),
  ];

  for (const filePath of envFiles) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          continue;
        }
        const separator = line.indexOf("=");
        if (separator === -1) {
          continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Failed to load env file ${filePath}`, error);
      }
    }
  }
}

function normalizeProxyAuthor(req) {
  return {
    login: req.headers["x-github-user"] || req.headers["x-user-login"] || "simulated-user",
    name: req.headers["x-user-name"] || req.headers["x-github-user"] || "Simulated User",
  };
}

function normalizeExtensionEvent(event) {
  const rawUrl = String(event.url || event.endpoint || "");
  let parsedUrl = null;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    parsedUrl = null;
  }

  const host = event.host || parsedUrl?.hostname || "";
  const pathValue = parsedUrl ? `${parsedUrl.pathname}${parsedUrl.search}` : event.path || "/";
  const sourceApp = event.appName || event.browser || "extension";
  const promptLines = [
    `App: ${sourceApp}`,
    `Event type: ${event.eventType || "request"}`,
    `Provider: ${event.provider || "unknown"}`,
    `Extension: ${event.extensionId || "unknown"}`,
    `Tab title: ${event.tabTitle || "unknown"}`,
    `Document: ${event.documentPath || "unknown"}`,
    `Method: ${event.method || "GET"}`,
    `URL: ${rawUrl || "<unknown>"}`,
    `Referrer: ${event.referrer || event.originUrl || "none"}`,
    `Prompt preview: ${event.promptPreview || "none"}`,
    `Clipboard preview: ${event.clipboardPreview || "none"}`,
  ];

  return {
    provider: event.provider || null,
    host,
    path: pathValue,
    url: rawUrl || `${host}${pathValue}`,
    method: event.method || "GET",
    headers: {
      "user-agent": event.userAgent || `${sourceApp}-extension`,
      "x-extension-event-type": event.eventType || "request",
      "x-extension-tab-title": event.tabTitle || "",
      "x-extension-id": event.extensionId || "",
    },
    body: {
      prompt: promptLines.join("\n"),
      metadata: event,
    },
    author: {
      login: sourceApp,
      name: sourceApp,
    },
  };
}

function buildMockProviderResponse(provider, stored) {
  if (provider === "anthropic") {
    return {
      id: `msg_${stored.id}`,
      type: "message",
      role: "assistant",
      model: stored.model || "claude-3-7-sonnet",
      content: [
        {
          type: "text",
          text: "Simulated Anthropic response captured by Commit Confessional.",
        },
      ],
      usage: {
        input_tokens: estimateTokenCount(stored.promptText),
        output_tokens: 12,
      },
    };
  }

  if (provider === "google" || provider === "gemini") {
    return {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "Simulated Gemini response captured by Commit Confessional.",
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: estimateTokenCount(stored.promptText),
        candidatesTokenCount: 10,
      },
    };
  }

  return {
    id: `chatcmpl_${stored.id}`,
    object: "chat.completion",
    model: stored.model || "gpt-4.1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Simulated OpenAI response captured by Commit Confessional.",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: estimateTokenCount(stored.promptText),
      completion_tokens: 10,
      total_tokens: estimateTokenCount(stored.promptText) + 10,
    },
  };
}

function estimateTokenCount(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function startBrowserProxy() {
  const proxy = new Proxy();
  const requestBodies = new WeakMap();

  proxy.onError((ctx, err, errorKind) => {
    const url = ctx?.clientToProxyRequest?.url || "unknown-url";
    console.error(`[browser-proxy:${errorKind}] ${url}`);
    console.error(err?.message || err);
  });

  proxy.onRequest((ctx, callback) => {
    requestBodies.set(ctx, []);
    return callback();
  });

  proxy.onRequestData((ctx, chunk, callback) => {
    const bodyChunks = requestBodies.get(ctx) || [];
    bodyChunks.push(Buffer.from(chunk));
    requestBodies.set(ctx, bodyChunks);
    return callback(null, chunk);
  });

  proxy.onRequestEnd(async (ctx, callback) => {
    try {
      const eventInput = buildProxyEventFromContext(ctx, requestBodies.get(ctx) || []);
      if (eventInput) {
        await captureProxyEvent(eventInput, "browser-proxy");
      }
    } catch (error) {
      console.error("[browser-proxy:capture-error]", error?.message || error);
    } finally {
      requestBodies.delete(ctx);
      return callback();
    }
  });

  proxy.listen({
    port: REAL_PROXY_PORT,
    host: "127.0.0.1",
    sslCaDir: mitmCaDir,
    forceSNI: true,
  });
}

function buildProxyEventFromContext(ctx, chunks) {
  const headers = ctx.clientToProxyRequest?.headers || {};
  const hostHeader = headers.host || "";
  const hostname = hostHeader.split(":")[0].toLowerCase();

  if (!isSupportedAiHost(hostname)) {
    return null;
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  const parsedBody = parseProxyBody(rawBody, headers["content-type"]);

  return {
    host: hostname,
    path: ctx.clientToProxyRequest?.url || "/",
    method: ctx.clientToProxyRequest?.method || "GET",
    headers,
    body: parsedBody,
    author: {
      login: "browser-user",
      name: "Browser User",
    },
  };
}

function isSupportedAiHost(hostname) {
  return [
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.x.ai",
  ].includes(hostname);
}

function parseProxyBody(rawBody, contentType) {
  if (!rawBody) {
    return null;
  }

  if ((contentType || "").includes("application/json")) {
    try {
      return JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
  }

  return rawBody;
}

function logCaptureToTerminal(capture, source) {
  const divider = "=".repeat(72);
  console.log(divider);
  console.log(`[proxy-capture] ${capture.capturedAt}`);
  console.log(`source      : ${source}`);
  console.log(`provider    : ${capture.provider}`);
  console.log(`client      : ${capture.client || "unknown-client"}`);
  console.log(`model       : ${capture.model || "unknown"}`);
  console.log(`endpoint    : ${capture.endpoint}`);
  console.log(`author      : ${capture.author?.name || "Unknown"} (${capture.author?.login || "unknown"})`);
  console.log(`repo-match  : ${capture.relatedToRepo} (score=${capture.correlationScore})`);
  console.log(`host        : ${capture.host || "unknown"}`);
  console.log(`prompt      :`);
  console.log(capture.promptText || "<no prompt text extracted>");
  console.log(`vuln-hints  : ${capture.vulnerabilities.map((item) => `${item.severity}:${item.title}`).join(" | ")}`);
  console.log(divider);
}

function buildVulnerabilitySummary(captures) {
  const counts = captures.reduce(
    (acc, capture) => {
      for (const vuln of capture.vulnerabilities) {
        acc[vuln.severity] = (acc[vuln.severity] || 0) + 1;
      }
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 }
  );

  return ["critical", "high", "medium", "low"].map((severity) => ({
    severity,
    count: counts[severity] || 0,
  }));
}

function buildContributorSummary(captures) {
  const byAuthor = new Map();

  for (const capture of captures) {
    const key = capture.author?.login || "unknown";
    const current = byAuthor.get(key) || {
      login: key,
      name: capture.author?.name || "Unknown contributor",
      events: 0,
      relatedEvents: 0,
      aiEvents: 0,
    };

    current.events += 1;
    current.relatedEvents += capture.relatedToRepo ? 1 : 0;
    current.aiEvents += capture.model ? 1 : 0;
    byAuthor.set(key, current);
  }

  return [...byAuthor.values()].sort((a, b) => b.events - a.events);
}
