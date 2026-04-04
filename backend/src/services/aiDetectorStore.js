import path from "node:path";
import { promises as fs } from "node:fs";

const AI_DETECTOR_FILE = ".aidetector.json";
const AI_DETECTOR_VERSION = 1;
const MAX_COMMIT_HISTORY = 500;
const DEFAULT_LINEAGE_THRESHOLD = 40;
const MIN_LINES_FOR_LINEAGE = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

export function getAiDetectorPath(projectRoot) {
  return path.join(projectRoot, AI_DETECTOR_FILE);
}

export async function loadAiDetectorState(aiDetectorPath) {
  if (!aiDetectorPath) {
    return createEmptyAiDetectorState();
  }

  const projectRoot = path.dirname(aiDetectorPath);
  const mergedState = createEmptyAiDetectorState();

  for (const detectorPath of collectCandidateDetectorPaths(aiDetectorPath)) {
    try {
      const raw = await fs.readFile(detectorPath, "utf8");
      mergeAiDetectorState(mergedState, normalizeAiDetectorState(JSON.parse(raw)), {
        detectorRoot: path.dirname(detectorPath),
        projectRoot,
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Failed to load AI detector state from ${detectorPath}`, error);
      }
    }
  }

  return mergedState;
}

export async function saveAiDetectorState(aiDetectorPath, state) {
  if (!aiDetectorPath) {
    return;
  }

  const normalized = normalizeAiDetectorState(state);
  await fs.writeFile(aiDetectorPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function calculateTaggedLineCoverage(lineRecords, aiDetectorState, options = {}) {
  const records = Array.isArray(lineRecords) ? lineRecords : [];
  const providerFilter = options.provider ? String(options.provider).toLowerCase() : null;
  const lineageThreshold = Number(options.lineageThreshold || DEFAULT_LINEAGE_THRESHOLD);
  const similarityThreshold = Number(options.similarityThreshold || DEFAULT_SIMILARITY_THRESHOLD);
  const matchedIndexes = new Set();
  const matchedLines = [];
  const dominantFiles = new Map();
  const exactQueues = new Map();
  const signatureQueues = new Map();
  const similarityCandidates = new Map();
  let exactMatchedLines = 0;
  let structuralMatchedLines = 0;
  let similarityMatchedLines = 0;
  let lineageMatchedLines = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const filePath = normalizeTrackedPath(record?.filePath);
    if (!filePath) {
      continue;
    }

    const fileState = aiDetectorState.files[filePath];
    if (!fileState) {
      continue;
    }

    const queueKey = `${providerFilter || "all"}:${filePath}`;
    if (!exactQueues.has(queueKey)) {
      exactQueues.set(queueKey, buildTagQueue(fileState.lineTags, providerFilter));
      signatureQueues.set(queueKey, buildMetadataQueue(fileState.lineTags, "signature", providerFilter));
      similarityCandidates.set(queueKey, buildSimilarityCandidates(fileState.lineTags, providerFilter));
    }

    const exactQueue = exactQueues.get(queueKey);
    if (shiftQueuedEntry(exactQueue, record.hash)) {
      matchedIndexes.add(index);
      exactMatchedLines += 1;
      matchedLines.push(record.text);
      continue;
    }

    const signatureQueue = signatureQueues.get(queueKey);
    if (consumeBestQueuedMatch(signatureQueue, record, similarityThreshold)) {
      matchedIndexes.add(index);
      structuralMatchedLines += 1;
      matchedLines.push(record.text);
      continue;
    }

    const similarCandidate = consumeBestSimilarCandidate(
      similarityCandidates.get(queueKey),
      record,
      similarityThreshold
    );
    if (similarCandidate) {
      matchedIndexes.add(index);
      similarityMatchedLines += 1;
      matchedLines.push(record.text);
      continue;
    }

    const providerShare = calculateProviderAiShare(fileState, providerFilter);
    if (
      providerShare >= lineageThreshold &&
      Number(fileState.totalMeaningfulLines || 0) >= MIN_LINES_FOR_LINEAGE
    ) {
      matchedIndexes.add(index);
      lineageMatchedLines += 1;
      matchedLines.push(record.text);
      dominantFiles.set(filePath, {
        filePath,
        aiShare: providerShare,
        provider: providerFilter || null,
      });
    }
  }

  return {
    totalChangedLines: records.length,
    aiMatchedLines: matchedIndexes.size,
    exactMatchedLines,
    structuralMatchedLines,
    similarityMatchedLines,
    lineageMatchedLines,
    matchedIndexes,
    matchedLines: matchedLines.slice(0, 20),
    estimatedAiPercentage: records.length > 0 ? Math.round((matchedIndexes.size / records.length) * 100) : 0,
    dominantFiles: [...dominantFiles.values()],
  };
}

export async function recordCommitInAiDetector(projectRoot, receipt, diffText = "") {
  const commitHash = normalizeCommitHash(receipt?.commitHash);
  if (!commitHash) {
    return;
  }

  const detectorPath = getAiDetectorPath(projectRoot);
  const detector = await loadAiDetectorState(detectorPath);
  const files = extractChangedFiles(diffText);
  const entry = {
    commitHash,
    shortHash: commitHash.slice(0, 7),
    updatedAt: receipt?.updatedAt || new Date().toISOString(),
    aiPercentage: Number(receipt?.modelEvidence?.contribution?.estimatedAiPercentage || 0),
    aiMatchedLines: Number(receipt?.modelEvidence?.contribution?.aiMatchedLines || 0),
    totalChangedLines: Number(receipt?.modelEvidence?.contribution?.totalChangedLines || 0),
    copilotPercentage: Number(receipt?.copilotContribution?.estimatedAiPercentage || receipt?.modelEvidence?.copilotContribution?.estimatedAiPercentage || 0),
    certainty: receipt?.modelEvidence?.certainty || "NONE",
    method: receipt?.modelEvidence?.method || "none",
    semgrepFindingCount: Number(receipt?.semgrep?.findingCount || 0),
    files,
  };

  detector.commits = [
    entry,
    ...detector.commits.filter((item) => normalizeCommitHash(item?.commitHash) !== commitHash),
  ].slice(0, MAX_COMMIT_HISTORY);
  detector.updatedAt = new Date().toISOString();

  await saveAiDetectorState(detectorPath, detector);
}

function createEmptyAiDetectorState() {
  return {
    version: AI_DETECTOR_VERSION,
    updatedAt: null,
    files: {},
    commits: [],
  };
}

function normalizeAiDetectorState(value) {
  const parsed = value && typeof value === "object" ? value : {};
  return {
    version: AI_DETECTOR_VERSION,
    updatedAt: parsed.updatedAt || null,
    files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
    commits: Array.isArray(parsed.commits) ? parsed.commits : [],
  };
}

function collectCandidateDetectorPaths(aiDetectorPath) {
  const paths = [];
  let current = path.resolve(path.dirname(aiDetectorPath));

  while (current) {
    paths.push(path.join(current, AI_DETECTOR_FILE));
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return paths;
}

function mergeAiDetectorState(target, incoming, options) {
  if (!incoming || typeof incoming !== "object") {
    return;
  }

  target.updatedAt = pickLatestTimestamp(target.updatedAt, incoming.updatedAt);

  for (const [filePath, fileState] of Object.entries(incoming.files || {})) {
    const normalizedPath = remapTrackedPathToProject(filePath, options);
    if (!normalizedPath || target.files[normalizedPath]) {
      continue;
    }
    target.files[normalizedPath] = normalizeImportedFileState(fileState);
  }

  for (const commit of incoming.commits || []) {
    const commitHash = normalizeCommitHash(commit?.commitHash);
    if (!commitHash || target.commits.some((item) => normalizeCommitHash(item?.commitHash) === commitHash)) {
      continue;
    }
    target.commits.push(commit);
  }
}

function remapTrackedPathToProject(filePath, { detectorRoot, projectRoot }) {
  const rawPath = String(filePath || "").trim();
  if (!rawPath) {
    return null;
  }

  const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(detectorRoot, rawPath);
  const relativePath = normalizeTrackedPath(path.relative(projectRoot, absolutePath));
  return isProjectRelativePath(relativePath) ? relativePath : null;
}

function isProjectRelativePath(value) {
  const normalized = normalizeTrackedPath(value);
  return Boolean(normalized) && !normalized.startsWith("..") && !path.isAbsolute(normalized);
}

function normalizeImportedFileState(fileState) {
  const lineTags = Array.isArray(fileState?.lineTags) ? fileState.lineTags.map(normalizeLineTag) : [];
  const totalMeaningfulLines = lineTags.length > 0 ? lineTags.length : Number(fileState?.totalMeaningfulLines || 0);
  const aiTaggedLines = lineTags.length > 0
    ? lineTags.filter((tag) => tag?.ai).length
    : Number(fileState?.aiTaggedLines || 0);
  const aiShare = totalMeaningfulLines > 0
    ? Math.round((aiTaggedLines / totalMeaningfulLines) * 100)
    : Number(fileState?.aiShare || 0);

  return {
    languageId: fileState?.languageId || "unknown",
    updatedAt: fileState?.updatedAt || null,
    totalMeaningfulLines,
    aiTaggedLines,
    aiShare,
    dominantOrigin: aiShare >= DEFAULT_LINEAGE_THRESHOLD ? "ai-majority" : aiTaggedLines > 0 ? "mixed" : "human",
    lineTags,
  };
}

function pickLatestTimestamp(left, right) {
  const leftTime = Date.parse(left || 0);
  const rightTime = Date.parse(right || 0);
  if (Number.isNaN(leftTime)) {
    return right || left || null;
  }
  if (Number.isNaN(rightTime)) {
    return left || right || null;
  }
  return rightTime >= leftTime ? right : left;
}

function calculateProviderAiShare(fileState, providerFilter) {
  if (!providerFilter) {
    return Number(fileState.aiShare || 0);
  }

  const lineTags = Array.isArray(fileState.lineTags) ? fileState.lineTags : [];
  if (lineTags.length === 0) {
    return 0;
  }

  const aiTaggedLines = lineTags.filter(
    (tag) => tag?.ai && String(tag.provider || "").toLowerCase() === providerFilter
  ).length;
  return Math.round((aiTaggedLines / lineTags.length) * 100);
}

function buildTagQueue(lineTags, providerFilter) {
  const queue = new Map();
  for (const tag of Array.isArray(lineTags) ? lineTags : []) {
    const hash = String(tag?.hash || "");
    if (!hash || !tag?.ai) {
      continue;
    }
    if (providerFilter && String(tag.provider || "").toLowerCase() !== providerFilter) {
      continue;
    }
    if (!queue.has(hash)) {
      queue.set(hash, []);
    }
    queue.get(hash).push(tag);
  }
  return queue;
}

function buildMetadataQueue(lineTags, keyName, providerFilter) {
  const queue = new Map();
  for (const tag of Array.isArray(lineTags) ? lineTags : []) {
    const normalizedTag = normalizeLineTag(tag);
    if (!normalizedTag?.ai) {
      continue;
    }
    if (providerFilter && String(normalizedTag.provider || "").toLowerCase() !== providerFilter) {
      continue;
    }
    const key = String(normalizedTag?.[keyName] || "");
    if (!key) {
      continue;
    }
    if (!queue.has(key)) {
      queue.set(key, []);
    }
    queue.get(key).push(normalizedTag);
  }
  return queue;
}

function buildSimilarityCandidates(lineTags, providerFilter) {
  return (Array.isArray(lineTags) ? lineTags : [])
    .filter((tag) => tag?.ai)
    .filter((tag) => !providerFilter || String(tag.provider || "").toLowerCase() === providerFilter)
    .map((tag) => normalizeLineTag(tag))
    .filter((tag) => tag.hash || tag.signature || tag.normalized);
}

function consumeBestQueuedMatch(queue, record, minScore) {
  const key = String(record?.signature || "");
  const items = queue.get(key);
  if (!items || items.length === 0) {
    return null;
  }

  let bestIndex = -1;
  let bestScore = minScore;
  for (let index = 0; index < items.length; index += 1) {
    const score = calculateLineSimilarity(record, items[index]);
    if (score >= bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex < 0) {
    return null;
  }

  const [entry] = items.splice(bestIndex, 1);
  if (items.length === 0) {
    queue.delete(key);
  }
  return entry;
}

function consumeBestSimilarCandidate(candidates, record, minScore) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  let bestIndex = -1;
  let bestScore = minScore;
  for (let index = 0; index < candidates.length; index += 1) {
    const score = calculateLineSimilarity(record, candidates[index]);
    if (score >= bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex < 0) {
    return null;
  }

  return candidates.splice(bestIndex, 1)[0];
}

function normalizeLineTag(tag) {
  const normalized = normalizeLineText(tag?.normalized || tag?.preview || "");
  return {
    ...tag,
    hash: String(tag?.hash || "") || hashNormalizedContent(normalized),
    normalized,
    signature: String(tag?.signature || "") || createStructuralSignature(normalized),
    fingerprint: String(tag?.fingerprint || "") || createTokenFingerprint(normalized),
  };
}

function normalizeLineRecord(record) {
  const normalized = normalizeLineText(record?.normalized || record?.text || "");
  return {
    ...record,
    text: normalized,
    normalized,
    hash: String(record?.hash || "") || hashNormalizedContent(normalized),
    signature: String(record?.signature || "") || createStructuralSignature(normalized),
    fingerprint: String(record?.fingerprint || "") || createTokenFingerprint(normalized),
  };
}

function calculateLineSimilarity(left, right) {
  const leftRecord = normalizeLineRecord(left);
  const rightRecord = normalizeLineTag(right);
  if (leftRecord.hash && rightRecord.hash && leftRecord.hash === rightRecord.hash) {
    return 1;
  }

  const exactSignatureMatch =
    leftRecord.signature &&
    rightRecord.signature &&
    leftRecord.signature === rightRecord.signature;
  const exactFingerprintMatch =
    leftRecord.fingerprint &&
    rightRecord.fingerprint &&
    leftRecord.fingerprint === rightRecord.fingerprint;
  const tokenScore = calculateTokenOverlap(leftRecord.fingerprint, rightRecord.fingerprint);
  const charScore = calculateCharacterOverlap(leftRecord.normalized, rightRecord.normalized);
  const weightedScore = (tokenScore * 0.7) + (charScore * 0.3);

  if (exactSignatureMatch && (tokenScore >= 0.5 || charScore >= 0.55)) {
    return Math.max(weightedScore, 0.92);
  }

  if (exactFingerprintMatch && charScore >= 0.45) {
    return Math.max(weightedScore, 0.84);
  }

  return weightedScore;
}

function calculateTokenOverlap(leftFingerprint, rightFingerprint) {
  const left = new Set(String(leftFingerprint || "").split("|").filter(Boolean));
  const right = new Set(String(rightFingerprint || "").split("|").filter(Boolean));
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(left.size, right.size);
}

function calculateCharacterOverlap(leftValue, rightValue) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }

  const shortestLength = Math.min(left.length, right.length);
  let samePrefix = 0;
  while (samePrefix < shortestLength && left[samePrefix] === right[samePrefix]) {
    samePrefix += 1;
  }

  let sameSuffix = 0;
  while (
    sameSuffix < shortestLength &&
    left[left.length - 1 - sameSuffix] === right[right.length - 1 - sameSuffix]
  ) {
    sameSuffix += 1;
  }

  return (samePrefix + sameSuffix) / (left.length + right.length);
}

function normalizeLineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hashNormalizedContent(value) {
  const normalized = normalizeLineText(value);
  return normalized ? `line:${normalized}` : "";
}

function createStructuralSignature(value) {
  return normalizeLineText(value)
    .toLowerCase()
    .replace(/\b0x[a-f0-9]+\b/gi, "<num>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<num>")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "<str>");
}

function createTokenFingerprint(value) {
  return [...new Set(
    createStructuralSignature(value).match(/[a-z_][a-z0-9_$]*/gi) || []
  )]
    .map((token) => token.toLowerCase())
    .sort()
    .slice(0, 24)
    .join("|");
}

function shiftQueuedEntry(queue, hash) {
  const items = queue.get(hash);
  if (!items || items.length === 0) {
    return null;
  }
  const entry = items.shift();
  if (items.length === 0) {
    queue.delete(hash);
  }
  return entry;
}

function extractChangedFiles(diffText) {
  const files = new Set();
  for (const rawLine of String(diffText || "").split(/\r?\n/)) {
    if (!rawLine.startsWith("+++ ")) {
      continue;
    }
    const normalized = normalizeDiffPath(rawLine.slice(4));
    if (normalized) {
      files.add(normalized);
    }
  }
  return [...files];
}

function normalizeDiffPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/dev/null") {
    return null;
  }
  return normalizeTrackedPath(trimmed.replace(/^a\//, "").replace(/^b\//, ""));
}

function normalizeTrackedPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeCommitHash(value) {
  return String(value || "").trim().toLowerCase();
}
