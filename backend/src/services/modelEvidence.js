import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { calculateTaggedLineCoverage, loadAiDetectorState } from "./aiDetectorStore.js";

const vscodeLogPath = path.join(os.homedir(), ".cc-vscode-log.jsonl");
const firefoxLogPath = path.join(os.homedir(), ".cc-firefox-log.jsonl");
const MAX_LOG_LINES = 500;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const HASH_TIME_WINDOW_MS = 60 * 1000;
const PREVIEW_EVENT_WINDOW_MS = 3 * 60 * 1000;
const MIN_MEANINGFUL_LINE_LENGTH = 15;
const MIN_DIFF_LINES_FOR_PERCENTAGE = 3;

export async function buildModelEvidenceReceipt(payload = {}) {
  const [vsCodeLog, firefoxLog, aiDetectorState] = await Promise.all([
    loadJsonLines(payload.vsCodeLog, vscodeLogPath),
    loadJsonLines(payload.firefoxLog, firefoxLogPath),
    loadAiDetectorState(payload.aiDetectorPath),
  ]);

  const mode = payload.receiptUrl === "preview://working-tree" ? "preview" : "commit";
  const diffText = buildDiffText(payload);
  const diffAnalysis = analyzeDiff(diffText);
  const evidence = correlateLogs(vsCodeLog, firefoxLog, diffAnalysis, mode, aiDetectorState);
  const copilotContribution = buildCopilotContribution(vsCodeLog, diffAnalysis, mode, aiDetectorState);

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
      taggedFiles: Object.keys(aiDetectorState.files || {}).length,
      taggedCommits: Array.isArray(aiDetectorState.commits) ? aiDetectorState.commits.length : 0,
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
  const meaningfulLineRecords = [];
  const hashes = new Set();
  let currentFilePath = null;

  for (const rawLine of String(diffText || "").split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      currentFilePath = normalizeDiffPath(rawLine.split(" ").at(-1));
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      currentFilePath = normalizeDiffPath(rawLine.slice(4));
      continue;
    }

    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) {
      continue;
    }

    const normalized = normalizeWhitespace(rawLine.slice(1));
    if (!normalized) {
      continue;
    }

    changedLines.push(normalized);
    if (isMeaningfulLine(normalized)) {
      const hash = hashContent(normalized);
      meaningfulChangedLines.push(normalized);
      meaningfulLineRecords.push({
        filePath: currentFilePath,
        text: normalized,
        hash,
      });
      hashes.add(hash);
    }
  }

  return {
    changedLines,
    meaningfulChangedLines,
    meaningfulLineRecords,
    hashes,
    totalChangedLines: changedLines.length,
  };
}

function correlateLogs(vsCodeLog, firefoxLog, diffAnalysis, mode, aiDetectorState) {
  const recentVsCodeLog = filterRecentEntries(vsCodeLog, mode);
  const recentFirefoxLog = filterRecentEntries(firefoxLog, mode);
  const firefoxCopies = recentFirefoxLog.filter((entry) => entry.eventType === "copy" || entry.type === "copy");
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
  const coverage = calculateAiCoverage(diffAnalysis.meaningfulLineRecords, aiSnippets);
  const copilotCoverage = calculateAiCoverage(
    diffAnalysis.meaningfulLineRecords,
    [...vscodePastes, ...vscodeSuggestions]
      .filter((entry) => (entry.provider || "").toLowerCase() === "copilot" || isExplicitTool(entry.tool))
      .map((entry) => entry.contentText)
      .filter((value) => typeof value === "string" && value.trim())
  );
  const taggedCoverage = calculateTaggedLineCoverage(diffAnalysis.meaningfulLineRecords, aiDetectorState);
  const taggedCopilotCoverage = calculateTaggedLineCoverage(diffAnalysis.meaningfulLineRecords, aiDetectorState, {
    provider: "copilot",
  });
  const combinedCoverage = combineCoverage(diffAnalysis.meaningfulLineRecords, coverage, taggedCoverage);
  const combinedCopilotCoverage = combineCoverage(diffAnalysis.meaningfulLineRecords, copilotCoverage, taggedCopilotCoverage);
  const tagEvidence = buildTagEvidenceLines(taggedCoverage);
  const copilotTagEvidence = buildTagEvidenceLines(taggedCopilotCoverage);

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
        contribution: buildContributionSummary(combinedCoverage, "HIGH", mode),
        copilotContribution: buildContributionSummary(combinedCopilotCoverage, "MEDIUM", mode),
        evidence: [
          `Firefox copy at ${copy.ts} from ${copy.provider || "unknown"}`,
          `VS Code paste at ${matchingPaste.ts} into ${matchingPaste.documentPath || "unknown"}`,
          `Matching content hash ${copy.contentHash}`,
          ...tagEvidence,
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
        contribution: buildContributionSummary(combinedCoverage, "HIGH", mode),
        copilotContribution: buildContributionSummary(combinedCopilotCoverage, "MEDIUM", mode),
        evidence: [
          `Firefox copy at ${copy.ts} from ${copy.provider || "unknown"}`,
          `Copied content hash appears in commit diff`,
          `Matching content hash ${copy.contentHash}`,
          ...tagEvidence,
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
        contribution: buildContributionSummary(combinedCoverage, "MEDIUM", mode),
        copilotContribution: buildContributionSummary(combinedCopilotCoverage, "MEDIUM", mode),
        evidence: [
          `Firefox copy at ${copy.ts}`,
          `VS Code ${nearbySuggestion.source || nearbySuggestion.eventType} at ${nearbySuggestion.ts}`,
          `Time delta ${Math.abs(Date.parse(nearbySuggestion.ts) - Date.parse(copy.ts))}ms`,
          ...tagEvidence,
        ],
      };
    }
  }

  if (combinedCopilotCoverage.aiMatchedLines > 0) {
    const usedStoredTags = taggedCopilotCoverage.aiMatchedLines > 0;
    return {
      certainty:
        copilotCoverage.aiMatchedLines > 0
          ? "PROBABLE"
          : taggedCopilotCoverage.exactMatchedLines > 0
            ? "HIGH"
            : "PROBABLE",
      method:
        copilotCoverage.aiMatchedLines > 0
          ? "copilot-diff-coverage"
          : taggedCopilotCoverage.lineageMatchedLines > 0
            ? "copilot-tag-lineage"
            : "copilot-tag-match",
      provider: "copilot",
      model: latestModel(modelQueries),
      contribution: buildContributionSummary(combinedCopilotCoverage, "MEDIUM", mode),
      copilotContribution: buildContributionSummary(combinedCopilotCoverage, "MEDIUM", mode),
      evidence: [
        ...(copilotCoverage.aiMatchedLines > 0
          ? [
              `Copilot-attributed VS Code insertions matched ${copilotCoverage.aiMatchedLines} changed lines`,
              `Estimated Copilot coverage ${copilotCoverage.estimatedAiPercentage}% of changed lines`,
            ]
          : []),
        ...(usedStoredTags ? copilotTagEvidence : []),
      ],
    };
  }

  if (taggedCoverage.aiMatchedLines > 0) {
    return {
      certainty: taggedCoverage.exactMatchedLines > 0 ? "HIGH" : "PROBABLE",
      method: taggedCoverage.lineageMatchedLines > 0 ? "stored-ai-lineage" : "stored-ai-tags",
      provider: null,
      model: latestModel(modelQueries),
      contribution: buildContributionSummary(combinedCoverage, taggedCoverage.exactMatchedLines > 0 ? "MEDIUM" : "LOW", mode),
      copilotContribution: buildContributionSummary(combinedCopilotCoverage, taggedCopilotCoverage.aiMatchedLines > 0 ? "MEDIUM" : "LOW", mode),
      evidence: tagEvidence,
    };
  }

  return {
    certainty: "NONE",
    method: "none",
    provider: null,
    model: null,
    contribution: buildContributionSummary(combinedCoverage, "LOW", mode),
    copilotContribution: buildContributionSummary(combinedCopilotCoverage, "LOW", mode),
    evidence: [],
  };
}

function latestModel(entries) {
  return entries.at(-1)?.model || null;
}

function hashContent(value) {
  return `sha256:${crypto.createHash("sha256").update(normalizeWhitespace(value)).digest("hex")}`;
}

function calculateAiCoverage(changedLineRecords, snippets) {
  const changedLines = changedLineRecords.map((record) => (typeof record === "string" ? record : record.text));
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
    aiMatchedLines: matchedIndexes.size,
    matchedIndexes,
    matchedLines: matchedLines.slice(0, 20),
    estimatedAiPercentage:
      changedLines.length > 0 ? Math.round((matchedIndexes.size / changedLines.length) * 100) : 0,
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

function buildCopilotContribution(vsCodeLog, diffAnalysis, mode, aiDetectorState) {
  const recentVsCodeLog = filterRecentEntries(vsCodeLog, mode);
  const copilotEntries = recentVsCodeLog.filter((entry) => {
    const provider = String(entry.provider || "").toLowerCase();
    const tool = String(entry.tool || "");
    return provider === "copilot" || isExplicitTool(tool);
  });

  const coverage = calculateAiCoverage(
    diffAnalysis.meaningfulLineRecords,
    copilotEntries.map((entry) => entry.contentText).filter((value) => typeof value === "string" && value.trim())
  );
  const taggedCoverage = calculateTaggedLineCoverage(diffAnalysis.meaningfulLineRecords, aiDetectorState, {
    provider: "copilot",
  });
  const combinedCoverage = combineCoverage(diffAnalysis.meaningfulLineRecords, coverage, taggedCoverage);

  return {
    ...buildContributionSummary(
      combinedCoverage,
      combinedCoverage.aiMatchedLines > 0 ? "MEDIUM" : "LOW",
      mode
    ),
    eventCount: copilotEntries.length,
  };
}

function combineCoverage(lineRecords, ...coverages) {
  const matchedIndexes = new Set();
  for (const coverage of coverages) {
    for (const index of coverage?.matchedIndexes || []) {
      matchedIndexes.add(index);
    }
  }

  const matchedLines = [...matchedIndexes]
    .sort((left, right) => left - right)
    .map((index) => lineRecords[index]?.text)
    .filter(Boolean)
    .slice(0, 20);

  return {
    totalChangedLines: lineRecords.length,
    aiMatchedLines: matchedIndexes.size,
    matchedIndexes,
    matchedLines,
    estimatedAiPercentage:
      lineRecords.length > 0 ? Math.round((matchedIndexes.size / lineRecords.length) * 100) : 0,
  };
}

function buildTagEvidenceLines(taggedCoverage) {
  const lines = [];

  if (taggedCoverage.exactMatchedLines > 0) {
    lines.push(`Stored AI tags matched ${taggedCoverage.exactMatchedLines} changed lines from earlier saves`);
  }

  if (taggedCoverage.lineageMatchedLines > 0) {
    lines.push(`AI-majority file lineage attributed ${taggedCoverage.lineageMatchedLines} additional changed lines`);
  }

  for (const file of taggedCoverage.dominantFiles.slice(0, 3)) {
    lines.push(`${file.filePath} is ${file.aiShare}% AI-tagged in the local lineage store`);
  }

  return lines;
}

function normalizeDiffPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/dev/null") {
    return null;
  }
  return trimmed.replace(/^a\//, "").replace(/^b\//, "").replace(/\\/g, "/");
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
