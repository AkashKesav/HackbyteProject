import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function buildRepoContext(projectRoot) {
  const summary = await readGitSummary(projectRoot);
  const fileIndex = await readFileIndex(projectRoot);
  const keywords = buildKeywordIndex(summary, fileIndex);

  return {
    summary,
    fileIndex,
    keywords,
  };
}

export async function createLatestCommitSnapshot(projectRoot) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--pretty=format:%H%n%an%n%ae%n%s%n%ai"],
      { cwd: projectRoot }
    );
    const [hash, authorName, authorEmail, subject, authoredAt] = stdout.split("\n");

    return {
      hash,
      shortHash: hash?.slice(0, 7) ?? null,
      authorName,
      authorEmail,
      subject,
      authoredAt,
      classification: "unknown",
      note: "Classification becomes meaningful once proxy events are matched to commits.",
    };
  } catch {
    return {
      hash: null,
      shortHash: null,
      authorName: null,
      authorEmail: null,
      subject: "No git commits found yet",
      authoredAt: null,
      classification: "unknown",
      note: "Initialize the repository or make a commit to populate commit metadata.",
    };
  }
}

export async function createRecentCommitSnapshots(projectRoot, limit = 10) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        `-${Math.max(1, limit)}`,
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%s%x1f%ai",
      ],
      { cwd: projectRoot }
    );

    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, authorName, authorEmail, subject, authoredAt] = line.split("\u001f");
        return {
          hash,
          shortHash,
          authorName,
          authorEmail,
          subject,
          authoredAt,
          classification: "unknown",
          note: "Classification becomes meaningful once proxy events are matched to commits.",
        };
      });
  } catch {
    return [];
  }
}

export function summarizeEventForStorage(event, analysis) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    capturedAt: new Date().toISOString(),
    author: normalizeAuthor(event.author),
    client: analysis.client,
    provider: analysis.provider,
    model: analysis.model,
    method: analysis.method,
    endpoint: event.url || `${event.host || "unknown"}${event.path || ""}`,
    relatedToRepo: analysis.relatedToRepo,
    correlationScore: analysis.correlationScore,
    correlationReasons: analysis.reasons,
    promptText: analysis.promptText,
    excerpt: analysis.excerpt,
    host: event.host || null,
    repoGuess: analysis.repoGuess,
    vulnerabilities: analysis.vulnerabilities,
    requestBody: event.body || null,
    rawHints: {
      headersPresent: Object.keys(event.headers || {}),
      payloadSize: JSON.stringify(event.body || {}).length,
    },
  };
}

async function readGitSummary(projectRoot) {
  try {
    const [{ stdout: remote }, { stdout: branch }, { stdout: topLevel }] =
      await Promise.all([
        execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd: projectRoot }),
        execFileAsync("git", ["branch", "--show-current"], { cwd: projectRoot }),
        execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot }),
      ]);

    const repoName = path.basename(topLevel.trim());
    const remoteText = remote.trim();
    const fullName = extractRepoFullName(remoteText);

    return {
      projectRoot: topLevel.trim(),
      repoName,
      remoteUrl: remoteText || null,
      branch: branch.trim() || null,
      fullName,
    };
  } catch {
    return {
      projectRoot,
      repoName: path.basename(projectRoot),
      remoteUrl: null,
      branch: null,
      fullName: null,
    };
  }
}

async function readFileIndex(projectRoot) {
  const files = [];
  await walk(projectRoot, projectRoot, files);
  return files.slice(0, 200);
}

async function walk(root, current, files) {
  const entries = await fs.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, files);
      continue;
    }

    const relativePath = path.relative(root, absolute).replaceAll("\\", "/");
    files.push(relativePath);
  }
}

function buildKeywordIndex(summary, fileIndex) {
  const keywords = new Set();
  const addToken = (value) => {
    if (!value) return;
    for (const part of value.split(/[^a-zA-Z0-9_-]+/)) {
      const normalized = part.trim().toLowerCase();
      if (normalized.length >= 3) {
        keywords.add(normalized);
      }
    }
  };

  addToken(summary.repoName);
  addToken(summary.fullName);
  addToken(summary.branch);

  for (const filePath of fileIndex.slice(0, 80)) {
    addToken(filePath);
  }

  return [...keywords];
}

function extractRepoFullName(remoteUrl) {
  if (!remoteUrl) return null;
  const cleaned = remoteUrl.replace(/\.git$/, "");
  const match = cleaned.match(/[:/]([^/:]+\/[^/]+)$/);
  return match ? match[1] : null;
}

function normalizeAuthor(author) {
  if (!author) {
    return {
      login: "unknown",
      name: "Unknown contributor",
    };
  }

  return {
    login: author.login || author.username || "unknown",
    name: author.name || author.login || "Unknown contributor",
    email: author.email || null,
  };
}
