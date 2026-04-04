// backend/src/db.js

export function upsertReceiptHistory(receipt) {
  if (!receipt) return;
  // Add your actual logic here — e.g., write to a DB, file, or in-memory store
  console.log('Upserting receipt into history:', receipt);
}