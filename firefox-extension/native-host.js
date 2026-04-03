#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputPath = path.join(os.homedir(), ".cc-firefox-log.jsonl");
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) {
      return;
    }

    const body = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);

    try {
      const message = JSON.parse(body.toString("utf8"));
      fs.appendFileSync(outputPath, `${JSON.stringify(message)}\n`, "utf8");
    } catch {}
  }
});
