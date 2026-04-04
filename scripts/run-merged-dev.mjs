import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const narratorRoot = path.join(
  projectRoot,
  "living-codebase-narrator",
  "living-codebase-narrator",
  "living-codebase-narrator"
);

const modes = {
  narrator: [
    { name: "narrator-backend", cwd: path.join(narratorRoot, "apps", "backend"), color: "\u001b[36m" },
    { name: "narrator-web", cwd: path.join(narratorRoot, "apps", "web"), color: "\u001b[35m" },
  ],
  all: [
    { name: "hackbyte-backend", cwd: path.join(projectRoot, "backend"), color: "\u001b[32m" },
    { name: "hackbyte-frontend", cwd: path.join(projectRoot, "frontend"), color: "\u001b[33m" },
    { name: "narrator-backend", cwd: path.join(narratorRoot, "apps", "backend"), color: "\u001b[36m" },
    { name: "narrator-web", cwd: path.join(narratorRoot, "apps", "web"), color: "\u001b[35m" },
  ],
};

const mode = process.argv[2] || "narrator";
const services = modes[mode];

if (!services) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

for (const service of services) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: service.cwd,
    shell: true,
    stdio: "pipe",
    env: process.env,
  });

  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line) {
          process.stdout.write(`${service.color}[${service.name}]\u001b[0m ${line}\n`);
        }
      }
    });
  }

  child.on("exit", (code, signal) => {
    if (!shuttingDown && ((code && code !== 0) || signal)) {
      shutdown(code || 1);
    }
  });

  children.push(child);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(exitCode);
}
