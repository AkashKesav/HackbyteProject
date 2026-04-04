export function upsertReceiptHistory(history = [], receipt, limit = 100) {
  const nextHistory = Array.isArray(history) ? history.filter(isCommitReceipt) : [];

  if (!isCommitReceipt(receipt)) {
    return nextHistory.slice(0, Math.max(1, limit));
  }

  const deduped = nextHistory.filter((entry) => !commitHashesMatch(entry.commitHash, receipt.commitHash));
  deduped.push(receipt);
  deduped.sort(compareReceiptsByUpdatedAt);

  return deduped.slice(0, Math.max(1, limit));
}

function isCommitReceipt(receipt) {
  return Boolean(normalizeCommitHash(receipt?.commitHash));
}

function compareReceiptsByUpdatedAt(left, right) {
  return parseReceiptTime(right) - parseReceiptTime(left);
}

function parseReceiptTime(receipt) {
  const timestamp = Date.parse(receipt?.updatedAt || receipt?.createdAt || 0);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function commitHashesMatch(left, right) {
  const normalizedLeft = normalizeCommitHash(left);
  const normalizedRight = normalizeCommitHash(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft)
  );
}

function normalizeCommitHash(value) {
  return String(value || "").trim().toLowerCase();
}
