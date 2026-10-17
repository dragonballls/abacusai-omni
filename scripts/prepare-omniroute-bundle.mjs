#!/usr/bin/env node
/**
 * Prepare an offline, platform-matched OmniRoute seed for the desktop app.
 *
 * This runs only in the Windows packaging job. The archive contains a private
 * copy of Node.js plus the pinned OmniRoute API gateway and its runtime
 * dependencies, so the downloaded portable app does not require system
 * Node.js/npm or a first-run npm download. User data and secrets are never
 * bundled.
 */
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = "3.8.50";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const resources = join(desktopRoot, "resources");
const archivePath = join(resources, "omniroute-seed.zip");
const timeout = 15 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function npmCliPath() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim()
      .split(/\r?\n/)
      .slice(-55)
      .join("\n");
    throw new Error(
      (result.error ? result.error.message + "\n" : "") +
        command +
        " exited with " +
        String(result.status) +
        (output ? "\n" + output : "")
    );
  }
  return (result.stdout ?? "").trim();
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function randomUrlSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function installNpm(args, npmCli, cwd, env) {
  return run(process.execPath, [npmCli, ...args], { cwd, env });
}

function main() {
  assert(
    process.platform === "win32",
    "The offline OmniRoute seed is prepared only for Windows portable builds."
  );
  assert(
    process.arch === "x64",
    "The Windows offline seed must be built on x64 for the matching portable app."
  );

  const npmCli = npmCliPath();
  assert(
    npmCli !== null,
    "npm's JavaScript CLI was not found alongside this Node.js installation."
  );
  const npmRoot = dirname(dirname(npmCli));
  const nodeVersion = run(process.execPath, ["--version"]);
  console.info(
    "[omniroute-bundle] Preparing offline OmniRoute " +
      VERSION +
      " for " +
      process.platform +
      "/" +
      process.arch +
      " using Node " +
      nodeVersion
  );

  const workRoot = mkdtempSync(join(tmpdir(), "abacus-omniroute-bundle-"));
  const installRoot = join(workRoot, "install");
  const modulesRoot = join(installRoot, "node_modules");
  const stageRoot = join(workRoot, "seed");
  const installEnv = {
    ...process.env,
    OMNIROUTE_SKIP_POSTINSTALL: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
  };

  try {
    mkdirSync(installRoot, { recursive: true });
    // Give the temporary installer the same fresh-install setup as the app.
    // This file stays in workRoot and is never copied into the shipping seed.
    writeFileSync(
      join(installRoot, ".env"),
      [
        "JWT_SECRET=" + randomUrlSecret(48),
        "API_KEY_SECRET=" + randomHex(32),
        "OMNIROUTE_CLI_SALT=" + randomHex(32),
        "INITIAL_PASSWORD=" + randomUrlSecret(32),
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );

    installNpm(
      [
        "install",
        "--loglevel=warn",
        "--no-progress",
        "--prefix",
        installRoot,
        "--no-fund",
        "--no-audit",
        "--fetch-retries=1",
        "--fetch-timeout=120000",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=optional",
        "omniroute@" + VERSION,
      ],
      npmCli,
      installRoot,
      installEnv
    );

    const packageManifestPath = join(
      modulesRoot,
      "omniroute",
      "package.json"
    );
    assert(
      existsSync(packageManifestPath),
      "npm completed but the OmniRoute package manifest is missing."
    );
    const packageManifest = JSON.parse(
      readFileSync(packageManifestPath, "utf8")
    );
    assert(
      packageManifest.version === VERSION,
      "Expected OmniRoute " + VERSION + ", got " + packageManifest.version
    );

    // The upstream postinstall is intentionally skipped for a lightweight API
    // gateway. Restore the same standalone JS fallbacks used by the smoke test.
    const standaloneRoot = join(
      modulesRoot,
      "omniroute",
      "dist",
      "node_modules"
    );
    for (const packageName of ["@swc/helpers", "sql.js", "node-machine-id"]) {
      const source = join(modulesRoot, packageName);
      assert(
        existsSync(source),
        "The install is missing required runtime package " + packageName
      );
      const destination = join(standaloneRoot, packageName);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, force: true });
    }

    const esbuildPath = join(modulesRoot, "esbuild", "package.json");
    assert(existsSync(esbuildPath), "The esbuild runtime package is missing.");
    const esbuild = JSON.parse(readFileSync(esbuildPath, "utf8"));
    const platformPackage = "@esbuild/" + process.platform + "-" + process.arch;
    const platformVersion = esbuild.optionalDependencies?.[platformPackage];
    assert(
      typeof platformVersion === "string",
      "esbuild does not declare " + platformPackage
    );

    const binaryRoot = join(workRoot, "esbuild-binary");
    installNpm(
      [
        "install",
        "--loglevel=warn",
        "--prefix",
        binaryRoot,
        "--no-fund",
        "--no-audit",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-save",
        platformPackage + "@" + platformVersion,
      ],
      npmCli,
      workRoot,
      {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PUPPETEER_SKIP_DOWNLOAD: "1",
      }
    );

    const [scope, packageName] = platformPackage.split("/");
    const binarySource = join(binaryRoot, "node_modules", scope, packageName);
    assert(
      existsSync(join(binarySource, "package.json")),
      "npm did not install the platform esbuild binary " + platformPackage
    );
    const binaryDestination = join(modulesRoot, scope, packageName);
    mkdirSync(dirname(binaryDestination), { recursive: true });
    cpSync(binarySource, binaryDestination, { recursive: true, force: true });

    const entry = join(modulesRoot, "omniroute", "bin", "omniroute.mjs");
    const runtimeVersion = run(process.execPath, [entry, "--version"], {
      cwd: installRoot,
      env: {
        ...installEnv,
        DATA_DIR: installRoot,
        PORT: "20128",
        OMNIROUTE_PORT: "20128",
        OMNIROUTE_SERVER_HOST: "127.0.0.1",
        REQUIRE_API_KEY: "true",
        NODE_ENV: "production",
      },
    });
    assert(
      runtimeVersion.split(/\r?\n/).some((line) => line.trim() === VERSION),
      "The installed runtime did not report the pinned version: " + runtimeVersion
    );

    mkdirSync(stageRoot, { recursive: true });
    cpSync(process.execPath, join(stageRoot, "node.exe"));
    cpSync(modulesRoot, join(stageRoot, "node_modules"), {
      recursive: true,
      force: true,
    });
    // npm is bundled beside node.exe so offline repairs can still use its CLI.
    const seedNpm = join(stageRoot, "node_modules", "npm");
    cpSync(npmRoot, seedNpm, { recursive: true, force: true });
    writeFileSync(
      join(stageRoot, "seed-manifest.json"),
      JSON.stringify(
        {
          format: 1,
          platform: process.platform,
          arch: process.arch,
          nodeVersion,
          omnirouteVersion: VERSION,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    mkdirSync(resources, { recursive: true });
    const psQuote = (value) => "'" + value.replace(/'/g, "''") + "'";
    const psCommand =
      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
      "Compress-Archive -Path (Join-Path " +
      psQuote(stageRoot) +
      " '*') -DestinationPath " +
      psQuote(archivePath) +
      " -CompressionLevel Optimal -Force";
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psCommand,
      ],
      { cwd: repoRoot, timeout }
    );

    const size = requireStat(archivePath);
    assert(size > 5 * 1024 * 1024, "The bundled OmniRoute ZIP is unexpectedly small.");
    console.info(
      "[omniroute-bundle] Created " +
        archivePath +
        " (" +
        Math.round(size / 1024 / 1024) +
        " MiB). No provider keys or user data were included."
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function requireStat(file) {
  return (awaitStat(file)).size;
}

function awaitStat(file) {
  return (globalThis.__unusedStatShim ?? (() => {
    // Dynamic import is unnecessary for stat; the shim keeps this helper sync.
    return { size: readFileSync(file).byteLength };
  }))();
}

main();
