import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMGREP_TIMEOUT_MS = 60_000;

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
    const { stdout } = await execFileAsync(
      "semgrep",
      ["scan", "--json", "--config", "auto", "--quiet"],
      {
        cwd: projectRoot,
        timeout: SEMGREP_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

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
      findingCount: results.length,
      findings,
      ranAt: new Date().toISOString(),
    };
  } catch (error) {
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
