#!/usr/bin/env node

/**
 * Check that the packaged app carries the files it spawns at runtime.
 *
 * Everything here is code the app runs out of `Contents/Resources` rather than
 * out of the asar, which means nothing in the build (not typecheck, not the
 * test suite, not electron-builder itself) notices when a piece stops being
 * copied. The failure lands on the user instead, as a runtime "Cannot find
 * package" the moment the app spawns what did not travel. Dev never shows it,
 * because dev runs everything from the repo.
 *
 * The trap is specific and repeatable: electron-builder's walker skips any
 * `node_modules` it meets inside a source tree, so a `from:` entry silently
 * ships everything except the dependencies. The agent hit it first. This asserts
 * the result rather than the config, so it holds whatever the config does next.
 *
 * Usage (after `pnpm package:dir`):
 *   node scripts/check-packaged-resources.js
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.platform === "win32" ? ".exe" : "";

/** Paths that must exist under the packaged app's resources directory. */
const REQUIRED = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "LICENSES.chromium.html",
  "agent/main.js",
  "agent/package.json",
  // Left out of the agent bundle because it loads a native addon, so it has to
  // be resolvable from beside the bundle at run time.
  "agent/node_modules/@ast-grep/napi",
  // The agent's `grep` and `find` spawn these. Shipped because the alternative
  // is downloading them from GitHub the first time the model searches, which
  // fails outright on a machine that cannot reach it.
  `agent/vendor/rg${EXE}`,
  `agent/vendor/fd${EXE}`,
  // The POSIX shell `bash` runs under on Windows; without it every command
  // the model writes fails on a machine with no Git Bash.
  ...(process.platform === "win32" ? ["agent/vendor/busybox.exe"] : []),
  // The Windows sandbox runner (packages/agent/src/sandbox/mxc.ts); without it
  // every confined command is refused on a Windows 11 24H2 machine.
  ...(process.platform === "win32" ? ["agent/vendor/mxc/wxc-exec.exe"] : []),
  // The terminal's ConPTY, which node-pty's addon opens by a path relative to
  // itself. Inside the asar it is a header entry rather than a file, and the
  // terminal fails to start with no clue as to why, so it is asserted where
  // the unpacking puts it.
  ...(process.platform === "win32"
    ? [
        `app.asar.unpacked/node_modules/@lydell/node-pty-win32-${process.arch}/prebuilds/win32-${process.arch}/conpty/conpty.dll`,
      ]
    : []),
  "vendor/scrcpy-server.jar",
  // The llama.cpp server local models run on; without it the local option
  // is offered and fails on the first request.
  `vendor/llama/llama-server${EXE}`,
  "skills",
  ...(process.platform === "win32" ? ["omniroute-seed.zip"] : []),
];

/**
 * Paths that must NOT exist. Historically the licence trap: the retired
 * WhatsApp bridge's GPL-3.0 dependency tree once shipped inside this MIT
 * artifact, and asserting on the built app is what caught it. Kept (empty)
 * so the next entry has somewhere obvious to go.
 */
const FORBIDDEN = [];

/** Where electron-builder --dir leaves the resources, per platform. */
function resourcesDir() {
  const dist = path.resolve(
    process.argv[2] ?? path.join(import.meta.dirname, "..", "release")
  );
  if (!fs.existsSync(dist)) {
    throw new Error("No release/ directory. Run `pnpm package:dir` first.");
  }

  const candidates = [];
  for (const entry of fs.readdirSync(dist)) {
    const base = path.join(dist, entry);
    // macOS: dist/mac-arm64/AbacusAI-Bot.app/Contents/Resources
    if (entry.startsWith("mac")) {
      for (const inner of fs.existsSync(base) ? fs.readdirSync(base) : []) {
        if (inner.endsWith(".app"))
          candidates.push(path.join(base, inner, "Contents", "Resources"));
      }
    }
    // Windows and Linux: dist/<name>-unpacked/resources
    if (entry.endsWith("unpacked"))
      candidates.push(path.join(base, "resources"));
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found == null) {
    throw new Error(
      `No unpacked app found under ${dist}. Looked for: ${candidates.join(", ") || "(nothing)"}`
    );
  }

  return found;
}


/**
 * Validate the actual Windows seed archive after electron-builder has copied
 * it. Presence alone is insufficient: an incomplete ZIP would strand users
 * without Node.js and defeat the offline-install promise.
 */
function checkBundledOmniRouteSeed(resources) {
  if (process.platform !== "win32") return;

  const archive = path.join(resources, "omniroute-seed.zip");
  if (fs.statSync(archive).size < 5 * 1024 * 1024) {
    throw new Error("The bundled OmniRoute seed archive is unexpectedly small.");
  }

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "abacus-omniroute-seed-check-")
  );
  try {
    const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
    const command =
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath " +
      quote(archive) +
      " -DestinationPath " +
      quote(temporary) +
      " -Force";
    const expanded = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true, timeout: 180_000 }
    );
    if (expanded.error || expanded.status !== 0) {
      throw new Error(
        "The bundled OmniRoute seed could not be extracted: " +
          (expanded.error?.message ?? expanded.stderr ?? "unknown error")
      );
    }

    const metadata = JSON.parse(
      fs.readFileSync(path.join(temporary, "seed-manifest.json"), "utf8")
    );
    if (
      metadata.platform !== process.platform ||
      metadata.arch !== process.arch ||
      metadata.omnirouteVersion !== "3.8.50"
    ) {
      throw new Error(
        "The bundled OmniRoute seed is for the wrong platform, architecture, or version."
      );
    }

    const node = path.join(temporary, "node.exe");
    const npmCli = path.join(
      temporary,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );
    const omniManifest = path.join(
      temporary,
      "node_modules",
      "omniroute",
      "package.json"
    );
    const esbuildManifest = path.join(
      temporary,
      "node_modules",
      "@esbuild",
      process.platform + "-" + process.arch,
      "package.json"
    );
    for (const required of [node, npmCli, omniManifest, esbuildManifest]) {
      if (!fs.existsSync(required)) {
        throw new Error("The bundled OmniRoute seed is missing " + required);
      }
    }

    const nodeVersion = spawnSync(node, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (nodeVersion.status !== 0 || nodeVersion.stdout.trim() !== metadata.nodeVersion) {
      throw new Error("The bundled Node.js executable did not pass its version check.");
    }

    const runtime = JSON.parse(fs.readFileSync(omniManifest, "utf8"));
    if (runtime.version !== "3.8.50") {
      throw new Error("The bundled OmniRoute package version is not 3.8.50.");
    }

    const esbuildPath = path.join(
      temporary,
      "node_modules",
      "@esbuild",
      process.platform + "-" + process.arch,
      "esbuild.exe"
    );
    const esbuild = spawnSync(esbuildPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (esbuild.status !== 0) {
      throw new Error("The bundled esbuild platform executable did not run.");
    }

    console.log(
      "[packaged-resources] offline OmniRoute seed verified: Node " +
        metadata.nodeVersion +
        ", OmniRoute " +
        runtime.version +
        ", esbuild " +
        esbuild.stdout.trim()
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function main() {
  const resources = resourcesDir();
  const missing = REQUIRED.filter(
    (relative) => !fs.existsSync(path.join(resources, relative))
  );
  const shipped = FORBIDDEN.filter((relative) =>
    fs.existsSync(path.join(resources, relative))
  );

  const agentPackage = path.join(resources, "agent", "package.json");
  if (fs.existsSync(agentPackage)) {
    const manifest = JSON.parse(fs.readFileSync(agentPackage, "utf8"));
    if (manifest.type !== "module") {
      throw new Error(
        `The packaged agent must declare type=module in ${agentPackage}`
      );
    }
  }

  if (shipped.length > 0) {
    console.error(
      `[packaged-resources] shipped and must not be, in ${resources}:`
    );
    for (const relative of shipped) console.error(`  - ${relative}`);
    console.error(
      `\nWhatever put these paths back into the build, the entry in FORBIDDEN ` +
        `above says why they must not ship. Fix the build, not the list.`
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(`[packaged-resources] missing from ${resources}:`);
    for (const relative of missing) console.error(`  - ${relative}`);
    console.error(
      `\nA path that exists in the repo but not here is usually electron-builder's ` +
        `walker skipping a nested node_modules. Give that directory its own ` +
        `\`from:\` entry in electron-builder.yml.`
    );
    process.exit(1);
  }

  checkBundledOmniRouteSeed(resources);

  // Present is not the same as usable. A binary that lost its executable bit on
  // the way into the bundle, or that was packaged for another architecture,
  // exists at exactly the right path and still cannot answer a search. That
  // failure would reach the user as `grep` reporting itself unavailable.
  const dead = [];
  for (const tool of ["rg", "fd"]) {
    const binary = path.join(resources, "agent", "vendor", tool + EXE);
    const probe = spawnSync(binary, ["--version"], { encoding: "utf8" });

    if (probe.status !== 0) {
      dead.push(
        `${tool}: ${(probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`).trim()}`
      );
    } else {
      console.log(
        `[packaged-resources] ${tool}: ${probe.stdout.trim().split("\n")[0]}`
      );
    }
  }

  if (process.platform === "win32") {
    const binary = path.join(resources, "agent", "vendor", "busybox.exe");
    const probe = spawnSync(binary, ["sh", "-c", "printf ok"], {
      encoding: "utf8",
    });

    if (probe.status !== 0 || probe.stdout !== "ok") {
      dead.push(
        `busybox: ${(probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`).trim()}`
      );
    } else {
      console.log(`[packaged-resources] busybox: sh -c works`);
    }
  }

  if (dead.length > 0) {
    console.error(`[packaged-resources] shipped but not runnable:`);
    for (const line of dead) console.error(`  - ${line}`);
    process.exit(1);
  }

  console.log(
    `[packaged-resources] all ${REQUIRED.length} required paths present in ${resources}`
  );
}

main();
