const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const extensionDir = __dirname;
const manifestDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Mozilla",
  "NativeMessagingHosts"
);
const manifestPath = path.join(manifestDir, "commit_confessional_firefox.json");
const hostLauncherPath = path.join(extensionDir, "native-host.cmd");
const hostScriptPath = path.join(extensionDir, "native-host.js");

fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(
  hostLauncherPath,
  `@echo off\r\n"${process.execPath}" "${hostScriptPath}"\r\n`,
  "utf8"
);

const manifest = {
  name: "commit_confessional_firefox",
  description: "Commit Confessional Firefox native host",
  path: hostLauncherPath,
  type: "stdio",
  allowed_extensions: ["commit-confessional-url-watcher@example.local"],
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
try {
  execFileSync(
    "reg",
    [
      "ADD",
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\commit_confessional_firefox",
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f",
    ],
    { stdio: "ignore" }
  );
  console.log("Firefox native messaging registry key created.");
} catch (error) {
  console.warn(`Registry key creation failed: ${error.message}`);
}
console.log(`Native host manifest written to ${manifestPath}`);
console.log(`Run Firefox after installing. Host launcher: ${hostLauncherPath}`);
