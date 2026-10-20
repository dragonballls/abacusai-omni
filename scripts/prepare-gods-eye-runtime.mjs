#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELATIVE = "integrations/gods-eye-view";
const SOURCE = join(ROOT, RELATIVE);
const PIN = "713285b554bbc99c8ae0261fe307beb3cbeb2adf";

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
if (
  process.env.ABACUS_GODS_EYE_PACKAGE === "1" &&
  process.platform !== "win32"
) {
  // The app must run God’s Eye without asking users to install Node separately.
  // Windows reuses the pinned Node executable bundled for OmniRoute; macOS and
  // Linux ship this dedicated runtime beside the app's other resources.
  const runtimeDirectory = join(
    ROOT,
    "apps",
    "desktop",
    "resources",
    "gods-eye-node"
  );
  const runtimeExecutable = join(runtimeDirectory, "node");
  mkdirSync(runtimeDirectory, { recursive: true });
  copyFileSync(process.execPath, runtimeExecutable);
  chmodSync(runtimeExecutable, 0o755);
  const licenseCandidates = [
    join(dirname(process.execPath), "..", "LICENSE"),
    join(dirname(process.execPath), "LICENSE"),
  ];
  const nodeLicense = licenseCandidates.find(existsSync);
  assert(
    nodeLicense,
    "The Node.js distribution license file was not found beside the runtime."
  );
  copyFileSync(nodeLicense, join(runtimeDirectory, "LICENSE"));
}
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
  assert(npmCli, "npm CLI was not found beside the build Node.js runtime.");
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
