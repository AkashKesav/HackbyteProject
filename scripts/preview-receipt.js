const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const backendUrl = process.env.COMMIT_CONFESSIONAL_RECEIPT_URL || "http://127.0.0.1:4000/api/receipt";
const UNTRACKED_PREVIEW_MAX_BYTES = 256 * 1024;

async function main() {
  const repoRoot = process.cwd();
  // Optional single-file mode keeps the preview scoped to one changed file.
  const targetPath = resolveRequestedFile(repoRoot, process.argv.slice(2));
  const diffText = buildPreviewDiff(repoRoot, targetPath);
  const hasDiff = Boolean(diffText.trim());
  const scanMode = targetPath && !hasDiff ? "clean-file-scan" : "diff-preview";

  if (!hasDiff && !targetPath) {
    console.log(
      "No staged or working-tree diff found."
    );
    return;
  }

  if (targetPath) {
    console.log(`Preview scope: file=${targetPath}`);
    if (!hasDiff) {
      console.log("Preview mode: clean-file-scan (no git diff found, scanning the file directly)");
    }
  }

  const payload = {
    diffText: hasDiff ? diffText : "",
    receiptUrl: scanMode === "clean-file-scan" ? "preview://file-scan" : "preview://working-tree",
    targetPath: targetPath || null,
    filePaths: targetPath ? [targetPath] : null,
    scanMode,
  };

  try {
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.message || `Receipt request failed with ${response.status}`);
    }

    const evidence = body.modelEvidence || {};
    const contribution = evidence.contribution || {};
    const copilotContribution = body.copilotContribution || evidence.copilotContribution || {};

    console.log(
      `Preview receipt: certainty=${evidence.certainty || "NONE"} model=${evidence.model || "unknown"} method=${evidence.method || "none"}`
    );
    console.log(
      `Copilot contribution: matched=${copilotContribution.aiMatchedLines || 0}/${copilotContribution.totalChangedLines || 0} percentage=${copilotContribution.estimatedAiPercentage || 0}% confidence=${copilotContribution.confidenceLevel || "LOW"} events=${copilotContribution.eventCount || 0}`
    );
    if (copilotContribution.sampleTooSmall) {
      console.log("Copilot contribution sample is too small for a stable percentage.");
    }
    console.log(
      `AI contribution: matched=${contribution.aiMatchedLines || 0}/${contribution.totalChangedLines || 0} percentage=${contribution.estimatedAiPercentage || 0}% confidence=${contribution.confidenceLevel || "LOW"}`
    );
    if (contribution.sampleTooSmall) {
      console.log("AI contribution sample is too small for a stable percentage.");
    }
    printSemgrepSummary(body.semgrep);
    printDependencyAuditSummary(body.dependencyAudit);

    if (Array.isArray(evidence.evidence) && evidence.evidence.length) {
      for (const line of evidence.evidence) {
        console.log(`- ${line}`);
      }
    }
  } catch (error) {
    console.error(`Preview receipt failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function execGit(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

function buildPreviewDiff(repoRoot, targetPath = null) {
  const diffArgs = targetPath ? ["--", targetPath] : [];
  const stagedDiff = execGit(["diff", "--cached", "--unified=0", ...diffArgs], repoRoot);
  const workingDiff = execGit(["diff", "--unified=0", ...diffArgs], repoRoot);
  // Untracked files need a synthetic diff because git diff omits them by default.
  const untrackedDiffs = readUntrackedFileDiffs(repoRoot, targetPath ? [targetPath] : null);
  return [stagedDiff, workingDiff, ...untrackedDiffs].filter(Boolean).join("\n");
}

function readUntrackedFileDiffs(repoRoot, onlyPaths = null) {
  const output = execGit(["ls-files", "--others", "--exclude-standard"], repoRoot);
  const filePaths = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const filterPaths = onlyPaths ? new Set(onlyPaths.map(normalizeRepoPath)) : null;
  const diffs = [];

  for (const relativePath of filePaths) {
    const normalizedPath = normalizeRepoPath(relativePath);
    if (filterPaths && !filterPaths.has(normalizedPath)) {
      continue;
    }

    const fullPath = path.join(repoRoot, relativePath);
    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (!stats.isFile() || stats.size > UNTRACKED_PREVIEW_MAX_BYTES) {
      continue;
    }

    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    if (content.includes("\u0000")) {
      continue;
    }

    diffs.push(createUntrackedFileDiff(normalizedPath, content));
  }

  return diffs;
}

function createUntrackedFileDiff(filePath, content) {
  const normalizedPath = normalizeRepoPath(filePath);
  const lines = String(content || "").replace(/\r/g, "").split("\n");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function resolveRequestedFile(repoRoot, args) {
  if (!Array.isArray(args) || args.length === 0) {
    return null;
  }

  if (args.length > 1) {
    throw new Error("Pass only one file path or file name. Quote the path if it contains spaces.");
  }

  const request = String(args[0] || "").trim();
  if (!request) {
    return null;
  }

  if (request === "--help" || request === "-h") {
    printUsage();
    process.exit(0);
  }

  const exactPath = resolveExactFileTarget(repoRoot, request);
  if (exactPath) {
    return exactPath;
  }

  const repoFiles = listRepoFiles(repoRoot);
  const normalizedRequest = normalizeRepoPath(request).toLowerCase();
  const exactRepoMatch = repoFiles.find((filePath) => filePath.toLowerCase() === normalizedRequest);
  if (exactRepoMatch) {
    return exactRepoMatch;
  }

  if (request.includes("/") || request.includes("\\") || path.isAbsolute(request)) {
    throw new Error(`Could not find "${request}" in this repository.`);
  }

  const baseName = path.basename(request).toLowerCase();
  const baseNameMatches = repoFiles.filter((filePath) => path.basename(filePath).toLowerCase() === baseName);

  if (baseNameMatches.length === 1) {
    return baseNameMatches[0];
  }

  if (baseNameMatches.length > 1) {
    throw new Error(
      `File name "${request}" is ambiguous. Use one of: ${baseNameMatches.join(", ")}`
    );
  }

  throw new Error(`Could not find "${request}" in this repository.`);
}

function resolveExactFileTarget(repoRoot, request) {
  const candidatePath = path.resolve(repoRoot, request);
  if (!isFileWithinRepo(repoRoot, candidatePath)) {
    return null;
  }
  return normalizeRepoPath(path.relative(repoRoot, candidatePath));
}

function isFileWithinRepo(repoRoot, candidatePath) {
  try {
    const stats = fs.statSync(candidatePath);
    if (!stats.isFile()) {
      return false;
    }

    const relativePath = path.relative(repoRoot, candidatePath);
    return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  } catch {
    return false;
  }
}

function listRepoFiles(repoRoot) {
  const output = execGit(["ls-files", "--cached", "--others", "--exclude-standard"], repoRoot);
  return [...new Set(output.split(/\r?\n/).map((value) => normalizeRepoPath(value)).filter(Boolean))];
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function printUsage() {
  console.log("Usage: node scripts/preview-receipt.js [file-path-or-file-name]");
  console.log("Examples:");
  console.log("  node scripts/preview-receipt.js");
  console.log("  node scripts/preview-receipt.js backend/src/server.js");
  console.log("  node scripts/preview-receipt.js demo-vulnerabilities.js");
}

function printSemgrepSummary(semgrep) {
  if (!semgrep) {
    return;
  }

  const configs = Array.isArray(semgrep.configs) && semgrep.configs.length > 0
    ? semgrep.configs.join(", ")
    : semgrep.config || "unknown";
  console.log(
    `Semgrep: findings=${semgrep.findingCount || 0} highest=${semgrep.highestSeverity || "none"} configs=${configs}`
  );

  for (const finding of Array.isArray(semgrep.findings) ? semgrep.findings.slice(0, 3) : []) {
    console.log(
      `- [${finding.severity || "unknown"}] ${finding.rule || "unknown-rule"} ${finding.path || "unknown"}${finding.line ? `:${finding.line}` : ""}`
    );
  }
}

function printDependencyAuditSummary(dependencyAudit) {
  if (!dependencyAudit) {
    return;
  }

  console.log(
    `Dependency CVEs: findings=${dependencyAudit.findingCount || 0} packages=${dependencyAudit.affectedPackageCount || 0} highest=${dependencyAudit.highestSeverity || "none"}`
  );

  for (const finding of Array.isArray(dependencyAudit.findings) ? dependencyAudit.findings.slice(0, 3) : []) {
    console.log(
      `- [${finding.severity || "unknown"}] ${finding.package || "unknown-package"} ${finding.advisory || finding.title || "unknown-advisory"}${finding.project ? ` (${finding.project})` : ""}`
    );
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  buildPreviewDiff,
  listRepoFiles,
  normalizeRepoPath,
  resolveRequestedFile,
};
