import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMGREP_TIMEOUT_MS = 60_000;
const NPM_AUDIT_TIMEOUT_MS = 120_000;
const DEFAULT_SEMGREP_MAX_FINDINGS = Number(process.env.SEMGREP_MAX_FINDINGS || 100);
const DEFAULT_DEPENDENCY_MAX_FINDINGS = Number(process.env.DEPENDENCY_AUDIT_MAX_FINDINGS || 50);
const SEMGREP_UTF8_ENV = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};
const SEMGREP_EXCLUDES = ["node_modules", "dist", "build", ".git", "backend/data"];
const SCAN_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", "backend/data"]);

export async function enrichReceiptWithIntegrations(projectRoot, receipt, options = {}) {
  const filePaths = normalizeScanFilePaths(options.filePaths);
  const [semgrep, dependencyAudit] = await Promise.all([
    runSemgrep(projectRoot, { filePaths }),
    runDependencyAudit(projectRoot),
  ]);
  const receiptHash = createReceiptHash(receipt);
  const solana = await buildSolanaAnchorStatus(receiptHash);

  return {
    ...receipt,
    semgrep,
    dependencyAudit,
    solana,
    receiptHash,
  };
}

async function runSemgrep(projectRoot, options = {}) {
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

    const semgrepConfigs = await resolveSemgrepConfigs(projectRoot);
    const filePaths = normalizeScanFilePaths(options.filePaths);
    const { stdout } = await execFileAsync(
      semgrepCommand.file,
      buildSemgrepArgs(semgrepCommand.args, semgrepConfigs, filePaths),
      {
        cwd: projectRoot,
        timeout: SEMGREP_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          ...SEMGREP_UTF8_ENV,
        },
      }
    );

    return buildSemgrepResult(stdout, semgrepCommand, semgrepConfigs);
  } catch (error) {
    if (error?.stdout) {
      try {
        return buildSemgrepResult(
          error.stdout,
          await resolveSemgrepCommand(),
          await resolveSemgrepConfigs(projectRoot)
        );
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

function buildSemgrepArgs(baseArgs, semgrepConfigs, filePaths = []) {
  return [
    ...baseArgs,
    "scan",
    "--json",
    "--metrics",
    "off",
    "--quiet",
    ...SEMGREP_EXCLUDES.flatMap((entry) => ["--exclude", entry]),
    ...semgrepConfigs.flatMap((config) => ["--config", config]),
    ...filePaths,
  ];
}

function normalizeScanFilePaths(filePaths) {
  return [...new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map((value) => String(value || "").trim().replace(/\\/g, "/"))
      .filter(Boolean)
  )];
}

function buildSemgrepResult(stdout, semgrepCommand, semgrepConfigs) {
  const parsed = JSON.parse(stdout || "{}");
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const uniqueFindings = dedupeSemgrepFindings(results)
    .sort(compareSemgrepFindings)
    .slice(0, DEFAULT_SEMGREP_MAX_FINDINGS);
  const findings = uniqueFindings.map((item) => ({
    rule: item.check_id || "unknown-rule",
    severity: normalizeSeverity(item.extra?.severity),
    message: item.extra?.message || "Semgrep finding",
    path: item.path || "unknown",
    line: item.start?.line || null,
  }));
  const severityCounts = findings.reduce(
    (counts, finding) => {
      counts[finding.severity] = (counts[finding.severity] || 0) + 1;
      return counts;
    },
    { critical: 0, high: 0, medium: 0, low: 0 }
  );

  return {
    configured: true,
    available: true,
    command: semgrepCommand ? [semgrepCommand.file, ...semgrepCommand.args].join(" ") : null,
    config: semgrepConfigs.length === 1 ? semgrepConfigs[0] : semgrepConfigs.join(", "),
    configs: semgrepConfigs,
    findingCount: uniqueFindings.length,
    findings,
    severityCounts,
    highestSeverity: findHighestSeverity(severityCounts),
    ranAt: new Date().toISOString(),
  };
}

async function resolveSemgrepConfigs(projectRoot) {
  const explicitConfigs = String(process.env.SEMGREP_CONFIGS || process.env.SEMGREP_CONFIG || "")
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const customRulePath = path.join(projectRoot, "backend", "semgrep", "javascript-product-audit.yml");
  const defaults = explicitConfigs.length > 0 ? explicitConfigs : ["p/default"];

  try {
    await fs.access(customRulePath);
    defaults.push(customRulePath);
  } catch {}

  return [...new Set(defaults)];
}

async function runDependencyAudit(projectRoot) {
  const npmRunner = await resolveNpmCommand();
  if (!npmRunner) {
    return {
      configured: false,
      available: false,
      command: null,
      projectCount: 0,
      findingCount: 0,
      affectedPackageCount: 0,
      findings: [],
      projects: [],
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      highestSeverity: "none",
      ranAt: new Date().toISOString(),
      error: "npm-cli-not-found",
    };
  }

  const targets = await findPackageLockTargets(projectRoot);
  if (targets.length === 0) {
    return {
      configured: false,
      available: false,
      command: "npm audit --json",
      projectCount: 0,
      findingCount: 0,
      affectedPackageCount: 0,
      findings: [],
      projects: [],
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      highestSeverity: "none",
      ranAt: new Date().toISOString(),
      error: "package-lock-not-found",
    };
  }

  const projects = [];
  for (const target of targets) {
    projects.push(await runDependencyAuditForTarget(projectRoot, target, npmRunner));
  }

  const severityCounts = projects.reduce(
    (counts, project) => {
      counts.critical += Number(project.severityCounts?.critical || 0);
      counts.high += Number(project.severityCounts?.high || 0);
      counts.medium += Number(project.severityCounts?.medium || 0);
      counts.low += Number(project.severityCounts?.low || 0);
      return counts;
    },
    { critical: 0, high: 0, medium: 0, low: 0 }
  );

  const allFindings = projects
    .flatMap((project) =>
      (project.findings || []).map((finding) => ({
        ...finding,
        project: project.name,
      }))
    );
  const findings = allFindings
    .sort((left, right) => compareNormalizedFindings(left, right))
    .slice(0, DEFAULT_DEPENDENCY_MAX_FINDINGS);

  const availableProjects = projects.filter((project) => project.available);

  return {
    configured: true,
    available: availableProjects.length > 0,
    command: npmRunner.displayCommand,
    projectCount: projects.length,
    findingCount: allFindings.length,
    affectedPackageCount: projects.reduce((sum, project) => sum + Number(project.affectedPackageCount || 0), 0),
    findings,
    projects,
    severityCounts,
    highestSeverity: findHighestSeverity(severityCounts),
    ranAt: new Date().toISOString(),
    error: availableProjects.length > 0 ? null : "npm-audit-failed",
  };
}

async function runDependencyAuditForTarget(projectRoot, target, npmRunner) {
  try {
    const { stdout } = await execFileAsync(
      npmRunner.file,
      npmRunner.auditArgs,
      {
        cwd: target.directory,
        timeout: NPM_AUDIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_loglevel: "error",
        },
      }
    );
    return buildDependencyAuditProjectResult(stdout, projectRoot, target);
  } catch (error) {
    const stdout = error?.stdout || error?.stderr || "";
    if (looksLikeJson(stdout)) {
      return buildDependencyAuditProjectResult(stdout, projectRoot, target, error);
    }

    return {
      name: target.name,
      directory: normalizePath(path.relative(projectRoot, target.directory) || "."),
      lockfilePath: normalizePath(path.relative(projectRoot, target.lockfilePath)),
      available: false,
      findingCount: 0,
      affectedPackageCount: 0,
      findings: [],
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      highestSeverity: "none",
      error: error?.message || String(error),
    };
  }
}

function buildDependencyAuditProjectResult(stdout, projectRoot, target, error = null) {
  const parsed = JSON.parse(stdout || "{}");
  const vulnerabilities = parsed.vulnerabilities && typeof parsed.vulnerabilities === "object"
    ? parsed.vulnerabilities
    : {};
  const allFindings = buildDependencyFindings(vulnerabilities)
    .sort((left, right) => compareNormalizedFindings(left, right));
  const findings = allFindings
    .slice(0, DEFAULT_DEPENDENCY_MAX_FINDINGS);
  const severityCounts = normalizeDependencySeverityCounts(parsed.metadata?.vulnerabilities);

  return {
    name: target.name,
    directory: normalizePath(path.relative(projectRoot, target.directory) || "."),
    lockfilePath: normalizePath(path.relative(projectRoot, target.lockfilePath)),
    available: true,
    findingCount: allFindings.length,
    affectedPackageCount: Object.keys(vulnerabilities).length,
    findings,
    severityCounts,
    highestSeverity: findHighestSeverity(severityCounts),
    error: error && error.code !== 1 ? error?.code || error?.message || null : null,
  };
}

async function resolveNpmCommand() {
  try {
    if (process.platform === "win32") {
      const file = process.env.ComSpec || "cmd.exe";
      const argsPrefix = ["/d", "/s", "/c"];
      await execFileAsync(file, [...argsPrefix, "npm --version"], { timeout: 10_000 });
      return {
        file,
        auditArgs: [...argsPrefix, "npm audit --json"],
        displayCommand: "npm audit --json",
      };
    }

    await execFileAsync("npm", ["--version"], { timeout: 10_000 });
    return {
      file: "npm",
      auditArgs: ["audit", "--json"],
      displayCommand: "npm audit --json",
    };
  } catch {
    return null;
  }
}

async function findPackageLockTargets(projectRoot) {
  const targets = [];
  await walkForPackageLocks(projectRoot, projectRoot, targets);
  return targets.sort((left, right) => left.directory.localeCompare(right.directory));
}

async function walkForPackageLocks(projectRoot, currentDirectory, targets) {
  let entries = [];
  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  const hasPackageLock = entries.some((entry) => entry.isFile() && entry.name === "package-lock.json");
  if (hasPackageLock) {
    const relativeDirectory = normalizePath(path.relative(projectRoot, currentDirectory) || ".");
    targets.push({
      name: relativeDirectory === "." ? "root" : relativeDirectory,
      directory: currentDirectory,
      lockfilePath: path.join(currentDirectory, "package-lock.json"),
    });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = normalizePath(path.relative(projectRoot, absolutePath));
    if (
      SCAN_EXCLUDED_DIRECTORIES.has(entry.name) ||
      relativePath === "frontend/dist" ||
      relativePath.startsWith("backend/data/")
    ) {
      continue;
    }

    await walkForPackageLocks(projectRoot, absolutePath, targets);
  }
}

function buildDependencyFindings(vulnerabilities) {
  const findings = [];
  const dedupe = new Set();

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const viaEntries = Array.isArray(vulnerability?.via) ? vulnerability.via : [vulnerability?.via];
    let addedStructuredFinding = false;

    for (const advisory of viaEntries) {
      if (!advisory || typeof advisory === "string") {
        continue;
      }

      addedStructuredFinding = true;
      const advisoryId = extractAdvisoryId(advisory.url) || extractAdvisoryId(advisory.title) || null;
      const key = [
        packageName,
        advisoryId || advisory.title || "unknown-advisory",
        advisory.severity || vulnerability?.severity || "unknown",
      ].join("|");

      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);

      findings.push({
        package: packageName,
        severity: normalizeSeverity(advisory.severity || vulnerability?.severity),
        advisory: advisoryId,
        title: advisory.title || `Vulnerability in ${packageName}`,
        url: advisory.url || null,
        range: advisory.range || vulnerability?.range || null,
        fixAvailable: normalizeFixAvailable(vulnerability?.fixAvailable),
        direct: Boolean(vulnerability?.isDirect),
      });
    }

    if (addedStructuredFinding) {
      continue;
    }

    const transitives = viaEntries.filter((entry) => typeof entry === "string" && entry.trim());
    const fallbackKey = [packageName, transitives.join(","), vulnerability?.severity || "unknown"].join("|");
    if (dedupe.has(fallbackKey)) {
      continue;
    }
    dedupe.add(fallbackKey);

    findings.push({
      package: packageName,
      severity: normalizeSeverity(vulnerability?.severity),
      advisory: null,
      title:
        transitives.length > 0
          ? `Affected by vulnerable dependency ${transitives.join(", ")}`
          : `Vulnerability in ${packageName}`,
      url: null,
      range: vulnerability?.range || null,
      fixAvailable: normalizeFixAvailable(vulnerability?.fixAvailable),
      direct: Boolean(vulnerability?.isDirect),
    });
  }

  return findings;
}

function normalizeDependencySeverityCounts(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    critical: Number(source.critical || 0),
    high: Number(source.high || 0),
    medium: Number(source.moderate || source.medium || 0),
    low: Number(source.low || source.info || 0),
  };
}

function normalizeFixAvailable(value) {
  if (!value) {
    return null;
  }

  if (value === true) {
    return "fix available";
  }

  if (typeof value === "object") {
    const version = value.version ? ` -> ${value.version}` : "";
    const major = value.isSemVerMajor ? " (semver-major)" : "";
    return `${value.name || "update"}${version}${major}`;
  }

  return String(value);
}

function extractAdvisoryId(value) {
  const text = String(value || "");
  const cve = text.match(/CVE-\d{4}-\d+/i);
  if (cve) {
    return cve[0].toUpperCase();
  }

  const ghsa = text.match(/GHSA-[a-z0-9-]+/i);
  if (ghsa) {
    return ghsa[0].toUpperCase();
  }

  return null;
}

function looksLikeJson(value) {
  return String(value || "").trim().startsWith("{");
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
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

function dedupeSemgrepFindings(results) {
  const unique = new Map();

  for (const item of results) {
    const key = [
      item.check_id || "unknown-rule",
      item.path || "unknown",
      item.start?.line || 0,
      item.extra?.message || "Semgrep finding",
    ].join("|");

    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }

  return [...unique.values()];
}

function compareSemgrepFindings(left, right) {
  const severityDelta = severityRank(right.extra?.severity) - severityRank(left.extra?.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const pathDelta = String(left.path || "").localeCompare(String(right.path || ""));
  if (pathDelta !== 0) {
    return pathDelta;
  }

  return Number(left.start?.line || 0) - Number(right.start?.line || 0);
}

function compareNormalizedFindings(left, right) {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const primaryDelta = String(left.path || left.package || "").localeCompare(String(right.path || right.package || ""));
  if (primaryDelta !== 0) {
    return primaryDelta;
  }

  return String(left.rule || left.title || "").localeCompare(String(right.rule || right.title || ""));
}

function findHighestSeverity(severityCounts) {
  if ((severityCounts.critical || 0) > 0) return "critical";
  if ((severityCounts.high || 0) > 0) return "high";
  if ((severityCounts.medium || 0) > 0) return "medium";
  if ((severityCounts.low || 0) > 0) return "low";
  return "none";
}

function severityRank(value) {
  const severity = normalizeSeverity(value);
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
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
  if (severity === "CRITICAL") return "critical";
  if (severity === "MODERATE") return "medium";
  if (severity === "WARNING") return "medium";
  if (severity === "INFO") return "low";
  if (severity === "HIGH" || severity === "MEDIUM" || severity === "LOW" || severity === "CRITICAL" || severity === "MODERATE") {
    return severity.toLowerCase();
  }
  return "medium";
}
