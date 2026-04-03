import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const vscodeLogPath = path.join(os.homedir(), ".cc-vscode-log.jsonl");
const firefoxLogPath = path.join(os.homedir(), ".cc-firefox-log.jsonl");
const MAX_LOG_LINES = 500;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const HASH_TIME_WINDOW_MS = 60 * 1000;
const PREVIEW_EVENT_WINDOW_MS = 3 * 60 * 1000;
const MIN_MEANINGFUL_LINE_LENGTH = 15;
const MIN_DIFF_LINES_FOR_PERCENTAGE = 3;

export async function buildModelEvidenceReceipt(payload = {}) {
  const [vsCodeLog, firefoxLog] = await Promise.all([
    loadJsonLines(payload.vsCodeLog, vscodeLogPath),
    loadJsonLines(payload.firefoxLog, firefoxLogPath),
  ]);

  const mode = payload.receiptUrl === "preview://working-tree" ? "preview" : "commit";
  const diffText = buildDiffText(payload);
  const diffAnalysis = analyzeDiff(diffText);
  const evidence = correlateLogs(vsCodeLog, firefoxLog, diffAnalysis, mode);
  const copilotContribution = buildCopilotContribution(vsCodeLog, diffAnalysis, mode);

  return {
    receiptUrl: payload.receiptUrl || null,
    logPaths: {
      vscodeLogPath,
      firefoxLogPath,
    },
    counts: {
      vsCodeEntries: vsCodeLog.length,
      firefoxEntries: firefoxLog.length,
      diffHashes: diffAnalysis.hashes.size,
      totalChangedLines: diffAnalysis.totalChangedLines,
      meaningfulChangedLines: diffAnalysis.meaningfulChangedLines.length,
    },
    modelEvidence: evidence,
    copilotContribution,
  };
}

async function loadJsonLines(inlineLog, defaultPath) {
  if (Array.isArray(inlineLog)) {
    return inlineLog;
  }

  let raw = "";
  try {
    raw = await fs.readFile(defaultPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_LOG_LINES)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => {
      const ts = Date.parse(entry.ts || entry.timeStamp || 0);
      return !Number.isNaN(ts) && Date.now() - ts <= RECENT_WINDOW_MS;
    });
}

function buildDiffText(payload) {
  if (typeof payload.diffText === "string" && payload.diffText.trim()) {
    return payload.diffText;
  }

  if (Array.isArray(payload.diffFiles)) {
    return payload.diffFiles
      .map((file) => [file.path, file.patch, file.content].filter(Boolean).join("\n"))
      .join("\n");
  }

  return "";
}

function analyzeDiff(diffText) {
  const changedLines = [];
  const meaningfulChangedLines = [];
  const hashes = new Set();

  for (const rawLine of String(diffText || "").split(/\r?\n/)) {
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) {
      continue;
    }

    const normalized = normalizeWhitespace(rawLine.slice(1));
    if (!normalized) {
      continue;
    }

    changedLines.push(normalized);
    if (isMeaningfulLine(normalized)) {
      meaningfulChangedLines.push(normalized);
      hashes.add(hashContent(normalized));
    }
  }

  return {
    changedLines,
    meaningfulChangedLines,
    hashes,
    totalChangedLines: changedLines.length,
  };
}

function correlateLogs(vsCodeLog, firefoxLog, diffAnalysis, mode) {
  const recentVsCodeLog = filterRecentEntries(vsCodeLog, mode);
  const recentFirefoxLog = filterRecentEntries(firefoxLog, mode);
  const firefoxCopies = recentFirefoxLog.filter((entry) => entry.eventType === "copy" || entry.type === "copy");
  const firefoxRequests = firefoxLog.filter(
    (entry) => entry.eventType === "network-request" || entry.eventType === "tab-visit"
  );
  const vscodePastes = recentVsCodeLog.filter(
    (entry) => entry.eventType === "paste-event" || entry.source === "paste-event" || entry.label === "paste-detected"
  );
  const vscodeSuggestions = recentVsCodeLog.filter(
    (entry) => entry.eventType === "inline-suggestion" || entry.source === "inline-suggestion"
  );
  const modelQueries = recentVsCodeLog.filter(
    (entry) => entry.label === "model-query" || entry.source === "copilot-log"
  );
  const aiSnippets = [...firefoxCopies, ...vscodePastes, ...vscodeSuggestions]
    .map((entry) => entry.contentText)
    .filter((value) => typeof value === "string" && value.trim());
  const coverage = calculateAiCoverage(diffAnalysis.meaningfulChangedLines, aiSnippets);
  const copilotCoverage = calculateAiCoverage(
    diffAnalysis.meaningfulChangedLines,
    [...vscodePastes, ...vscodeSuggestions]
      .filter((entry) => (entry.provider || "").toLowerCase() === "copilot" || isExplicitTool(entry.tool))
      .map((entry) => entry.contentText)
      .filter((value) => typeof value === "string" && value.trim())
  );

  for (const copy of firefoxCopies) {
    const matchingPaste = vscodePastes.find((paste) => {
      return (
        paste.contentHash &&
        copy.contentHash &&
        paste.contentHash === copy.contentHash &&
        Math.abs(Date.parse(paste.ts) - Date.parse(copy.ts)) <= HASH_TIME_WINDOW_MS
      );
    });

    if (matchingPaste) {
      return {
        certainty: "HIGH",
        method: "hash-correlation",
        provider: copy.provider || "unknown",
        model: latestModel(modelQueries),
        contribution: buildContributionSummary(coverage, "HIGH", mode),
        copilotContribution: buildContributionSummary(copilotCoverage, "MEDIUM", mode),
        evidence: [
          `Firefox copy at ${copy.ts} from ${copy.provider || "unknown"}`,
          `VS Code paste at ${matchingPaste.ts} into ${matchingPaste.documentPath || "unknown"}`,
          `Matching content hash ${copy.contentHash}`,
        ],
      };
    }
  }

  for (const copy of firefoxCopies) {
    if (copy.contentHash && diffAnalysis.hashes.has(copy.contentHash)) {
      return {
        certainty: "HIGH",
        method: "diff-hash-match",
        provider: copy.provider || "unknown",
        model: latestModel(modelQueries),
        contribution: buildContributionSummary(coverage, "HIGH", mode),
        copilotContribution: buildContributionSummary(copilotCoverage, "MEDIUM", mode),
        evidence: [
          `Firefox copy at ${copy.ts} from ${copy.provider || "unknown"}`,
          `Copied content hash appears in commit diff`,
          `Matching content hash ${copy.contentHash}`,
        ],
      };
    }
  }

  for (const copy of firefoxCopies) {
    const nearbySuggestion = [...vscodePastes, ...vscodeSuggestions].find((entry) => {
      return Math.abs(Date.parse(entry.ts) - Date.parse(copy.ts)) <= HASH_TIME_WINDOW_MS;
    });

    if (nearbySuggestion) {
      return {
        certainty: "PROBABLE",
        method: "time-correlation",
        provider: copy.provider || "unknown",
        model: latestModel(modelQueries),
        contribution: buildContributionSummary(coverage, "MEDIUM", mode),
        copilotContribution: buildContributionSummary(copilotCoverage, "MEDIUM", mode),
        evidence: [
          `Firefox copy at ${copy.ts}`,
          `VS Code ${nearbySuggestion.source || nearbySuggestion.eventType} at ${nearbySuggestion.ts}`,
          `Time delta ${Math.abs(Date.parse(nearbySuggestion.ts) - Date.parse(copy.ts))}ms`,
        ],
      };
    }
  }

  if (copilotCoverage.aiMatchedLines > 0) {
    return {
      certainty: "PROBABLE",
      method: "copilot-diff-coverage",
      provider: "copilot",
      model: latestModel(modelQueries),
      contribution: buildContributionSummary(copilotCoverage, "MEDIUM", mode),
      copilotContribution: buildContributionSummary(copilotCoverage, "MEDIUM", mode),
      evidence: [
        `Copilot-attributed VS Code insertions matched ${copilotCoverage.aiMatchedLines} changed lines`,
        `Estimated Copilot coverage ${copilotCoverage.estimatedAiPercentage}% of changed lines`,
      ],
    };
  }

  return {
    certainty: "NONE",
    method: "none",
    provider: null,
    model: null,
    contribution: buildContributionSummary(coverage, "LOW", mode),
    copilotContribution: buildContributionSummary(copilotCoverage, "LOW", mode),
    evidence: [],
  };
}

function latestModel(entries) {
  return entries.at(-1)?.model || null;
}

function hashContent(value) {
  return `sha256:${crypto.createHash("sha256").update(normalizeWhitespace(value)).digest("hex")}`;
}

function calculateAiCoverage(changedLines, snippets) {
  const snippetLineSet = new Set();
  const snippetBlocks = [];

  for (const snippet of snippets) {
    const snippetLines = String(snippet)
      .split(/\r?\n/)
      .map(normalizeWhitespace)
      .filter(isMeaningfulLine);

    if (snippetLines.length >= 2) {
      snippetBlocks.push(snippetLines);
    }

    for (const line of snippetLines) {
      snippetLineSet.add(line);
    }
  }

  let matchedLineCount = 0;
  const matchedLines = [];
  const matchedIndexes = new Set();
  for (let index = 0; index < changedLines.length; index += 1) {
    const changedLine = changedLines[index];
    if (snippetLineSet.has(changedLine)) {
      matchedLineCount += 1;
      matchedLines.push(changedLine);
      matchedIndexes.add(index);
    }
  }

  const blockMatches = findBlockMatches(changedLines, snippetBlocks);
  for (const block of blockMatches) {
    for (const index of block.indexes) {
      if (matchedIndexes.has(index)) {
        continue;
      }

      matchedIndexes.add(index);
      matchedLineCount += 1;
      matchedLines.push(changedLines[index]);
    }
  }

  return {
    totalChangedLines: changedLines.length,
    aiMatchedLines: matchedLineCount,
    matchedLines: matchedLines.slice(0, 20),
    estimatedAiPercentage:
      changedLines.length > 0 ? Math.round((matchedLineCount / changedLines.length) * 100) : 0,
  };
}

function buildContributionSummary(coverage, confidenceLevel, mode) {
  const sampleTooSmall = mode === "preview" && coverage.totalChangedLines < MIN_DIFF_LINES_FOR_PERCENTAGE;

  return {
    aiMatchedLines: coverage.aiMatchedLines,
    totalChangedLines: coverage.totalChangedLines,
    estimatedAiPercentage: sampleTooSmall ? 0 : coverage.estimatedAiPercentage,
    confidenceLevel: sampleTooSmall ? "LOW" : confidenceLevel,
    matchedLineSamples: coverage.matchedLines,
    sampleTooSmall,
  };
}

function buildCopilotContribution(vsCodeLog, diffAnalysis, mode) {
  const recentVsCodeLog = filterRecentEntries(vsCodeLog, mode);
  const copilotEntries = recentVsCodeLog.filter((entry) => {
    const provider = String(entry.provider || "").toLowerCase();
    const tool = String(entry.tool || "");
    return provider === "copilot" || isExplicitTool(tool);
  });

  const coverage = calculateAiCoverage(
    diffAnalysis.meaningfulChangedLines,
    copilotEntries.map((entry) => entry.contentText).filter((value) => typeof value === "string" && value.trim())
  );

  return {
    ...buildContributionSummary(coverage, coverage.aiMatchedLines > 0 ? "MEDIUM" : "LOW", mode),
    eventCount: copilotEntries.length,
  };
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isMeaningfulLine(line) {
  const value = normalizeWhitespace(line);
  if (value.length < MIN_MEANINGFUL_LINE_LENGTH) {
    return false;
  }

  if (/^[{}()[\];,]+$/.test(value)) {
    return false;
  }

  if (/^(import|export|from|return|const|let|var|module\.exports)\b\s*[^=;]*;?$/i.test(value) && value.length < 30) {
    return false;
  }

  return true;
}

function filterRecentEntries(entries, mode) {
  if (mode !== "preview") {
    return entries;
  }

  const cutoff = Date.now() - PREVIEW_EVENT_WINDOW_MS;
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts || 0);
    return !Number.isNaN(ts) && ts >= cutoff;
  });
}

function isExplicitTool(tool) {
  const value = String(tool || "");
  return value !== "" && value !== "Human / Unknown";
}

function findBlockMatches(changedLines, snippetBlocks) {
  const matches = [];

  for (const block of snippetBlocks) {
    for (let start = 0; start <= changedLines.length - block.length; start += 1) {
      let matchesBlock = true;
      for (let offset = 0; offset < block.length; offset += 1) {
        if (changedLines[start + offset] !== block[offset]) {
          matchesBlock = false;
          break;
        }
      }

      if (matchesBlock) {
        matches.push({
          indexes: Array.from({ length: block.length }, (_, i) => start + i),
        });
      }
    }
  }

  return matches;
}
