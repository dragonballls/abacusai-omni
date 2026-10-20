#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELATIVE = "integrations/gods-eye-view";
const SOURCE = join(ROOT, RELATIVE);
const PIN = "de2138e84c1778fd98a48b7c9fd0b9788c318946";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "God's Eye preparation failed: " +
        command +
        " " +
        args.join(" ") +
        "\n" +
        String(result.stdout || "") +
        String(result.stderr || "")
    );
  }
  return String(result.stdout || "").trim();
}

assert(
  existsSync(join(ROOT, ".git")),
  "God's Eye preparation needs a Git checkout."
);
run("git", [
  "submodule",
  "update",
  "--init",
  "--recursive",
  "--force",
  "--",
  RELATIVE,
]);
assert(
  existsSync(join(SOURCE, "package.json")),
  "God's Eye submodule was not initialized."
);
assert(
  existsSync(join(SOURCE, "package-lock.json")),
  "Pinned God’s Eye package-lock.json is missing."
);
const actual = run("git", ["-C", SOURCE, "rev-parse", "HEAD"]);
assert(
  actual === PIN,
  "God's Eye submodule is not at the expected pin " +
    PIN +
    "; found " +
    actual +
    "."
);

const version = process.versions.node.split(".").map(Number);
assert(
  (version[0] === 24 && version[1] >= 14) || version[0] === 26,
  "God's Eye preparation requires Node.js 24.14.x or 26.x."
);
const lockHash = createHash("sha256")
  .update(readFileSync(join(SOURCE, "package.json")))
  .update(readFileSync(join(SOURCE, "package-lock.json")))
  .digest("hex");
const modules = join(SOURCE, "node_modules");
const viteCli = join(modules, "vite", "bin", "vite.js");
const installMarker = join(modules, ".abacus-gods-eye-dependencies");
let installedHash = "";
try {
  installedHash = readFileSync(installMarker, "utf8").trim();
} catch {
  /* Install below. */
}

if (installedHash !== lockHash || !existsSync(viteCli)) {
  const nodeDir = dirname(process.execPath);
  const npmCli = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find(existsSync);
  assert(
    npmCli,
    "npm CLI was not found beside the build Node.js runtime."
  );
  run(process.execPath, [npmCli, "ci", "--no-audit", "--no-fund"], {
    cwd: SOURCE,
    env: {
      ...process.env,
      PUPPETEER_SKIP_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      OMNIROUTE_TELEMETRY: "false",
    },
  });
  assert(
    existsSync(viteCli),
    "God's Eye dependencies did not install correctly; Vite runtime is missing."
  );
  writeFileSync(installMarker, lockHash + "\n", "utf8");
}
console.log("God's Eye source verified at " + PIN);
console.log("God's Eye runtime dependencies are ready for packaging.");
