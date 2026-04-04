import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMGREP_TIMEOUT_MS = 60_000;
const DEFAULT_SEMGREP_CONFIG = process.env.SEMGREP_CONFIG || "p/security-audit";

export async function enrichReceiptWithIntegrations(projectRoot, receipt) {
  const semgrep = await runSemgrep(projectRoot);
  const receiptHash = createReceiptHash(receipt);
  const solana = await buildSolanaAnchorStatus(receiptHash);

  return {
    ...receipt,
    semgrep,
    solana,
    receiptHash,
  };
}

async function runSemgrep(projectRoot) {
  try {
    const semgrepCommand = await resolveSemgrepCommand();
    if (!semgrepCommand) {
      return {
        configured: false,
        available: false,
        findingCount: 0,
        findings: [],
        ranAt: new Date().toISOString(),
        error: "semgrep-cli-not-found",
      };
    }

    const { stdout } = await execFileAsync(
      semgrepCommand.file,
      [...semgrepCommand.args, "scan", "--json", "--config", DEFAULT_SEMGREP_CONFIG, "--metrics", "off", "--quiet"],
      {
        cwd: projectRoot,
        timeout: SEMGREP_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    return buildSemgrepResult(stdout, semgrepCommand);
  } catch (error) {
    if (error?.stdout) {
      try {
        return buildSemgrepResult(error.stdout, await resolveSemgrepCommand());
      } catch {}
    }
    return {
      configured: false,
      available: false,
      findingCount: 0,
      findings: [],
      ranAt: new Date().toISOString(),
      error: error?.code === "ENOENT" ? "semgrep-cli-not-found" : error?.message || String(error),
    };
  }
}

function buildSemgrepResult(stdout, semgrepCommand) {
  const parsed = JSON.parse(stdout || "{}");
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const findings = results.slice(0, 50).map((item) => ({
    rule: item.check_id || "unknown-rule",
    severity: normalizeSeverity(item.extra?.severity),
    message: item.extra?.message || "Semgrep finding",
    path: item.path || "unknown",
    line: item.start?.line || null,
  }));

  return {
    configured: true,
    available: true,
    command: semgrepCommand ? [semgrepCommand.file, ...semgrepCommand.args].join(" ") : null,
    config: DEFAULT_SEMGREP_CONFIG,
    findingCount: results.length,
    findings,
    ranAt: new Date().toISOString(),
  };
}

async function resolveSemgrepCommand() {
  const candidates = [];
  if (process.env.SEMGREP_BIN) {
    candidates.push({ file: process.env.SEMGREP_BIN, args: [] });
  }
  for (const userSemgrep of await findUserSemgrepBinaries()) {
    candidates.push({ file: userSemgrep, args: [] });
  }
  candidates.push({ file: "semgrep", args: [] });

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.file, [...candidate.args, "--version"], { timeout: 10_000 });
      return candidate;
    } catch {}
  }

  return null;
}

async function findUserSemgrepBinaries() {
  const pythonRoot = process.env.APPDATA ? path.join(process.env.APPDATA, "Python") : null;
  if (!pythonRoot) {
    return [];
  }

  try {
    const entries = await fs.readdir(pythonRoot, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries.filter((item) => item.isDirectory() && /^Python\d+$/i.test(item.name))) {
      const scriptsDir = path.join(pythonRoot, entry.name, "Scripts");
      for (const executable of ["pysemgrep.exe", "semgrep.exe"]) {
        const candidate = path.join(scriptsDir, executable);
        try {
          await fs.access(candidate);
          candidates.push(candidate);
        } catch {}
      }
    }
    return candidates;
  } catch {}

  return [];
}

function createReceiptHash(receipt) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`;
}

async function buildSolanaAnchorStatus(receiptHash) {
  const rpcUrl = process.env.SOLANA_RPC_URL || "";
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || "";
  const anchorMode = process.env.SOLANA_ANCHOR_MODE || "disabled";

  if (!rpcUrl || !walletAddress || anchorMode === "disabled") {
    return {
      configured: false,
      anchored: false,
      receiptHash,
      network: rpcUrl || null,
      walletAddress: walletAddress || null,
      status: "not-configured",
    };
  }

  try {
    await execFileAsync("solana", ["--version"], { timeout: 10_000 });
    return {
      configured: true,
      anchored: false,
      receiptHash,
      network: rpcUrl,
      walletAddress,
      status: "ready-for-anchor",
      note: "Solana CLI detected. On-chain submission still requires a funded signer flow.",
    };
  } catch (error) {
    return {
      configured: true,
      anchored: false,
      receiptHash,
      network: rpcUrl,
      walletAddress,
      status: "cli-unavailable",
      error: error?.message || String(error),
    };
  }
}

function normalizeSeverity(value) {
  const severity = String(value || "").toUpperCase();
  if (severity === "ERROR") return "high";
  if (severity === "WARNING") return "medium";
  if (severity === "INFO") return "low";
  if (severity === "HIGH" || severity === "MEDIUM" || severity === "LOW") {
    return severity.toLowerCase();
  }
  return "medium";
}
