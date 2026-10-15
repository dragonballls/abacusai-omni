import { spawn, spawnSync, type ChildProcess } from "node:child_process";
/**
 * Local OmniRoute gateway integration for AbacusAI Bot.
 *
 * Matches Brahma Evo's pinned OmniRoute 3.8.50 runtime and shared Windows
 * data directory. Upstream provider credentials are entered in OmniRoute's
 * own dashboard and are never copied into AbacusAI Bot settings.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { CustomProviderEntry } from "@abacus-ai/contract/settings";
import { app, BrowserWindow, shell } from "electron";

import { isSafeExternalUrl } from "../../external-links.js";
import { setDefaultModel, upsertCustomProvider } from "../config/settings.js";

const OMNIROUTE_VERSION = "3.8.50";
const OMNIROUTE_PORT = 20128;
const OMNIROUTE_ORIGIN = `http://127.0.0.1:${OMNIROUTE_PORT}`;
const OMNIROUTE_BASE_URL = `${OMNIROUTE_ORIGIN}/v1`;
const DEFAULT_MODEL = "omniroute/auto";
const PROVIDER_ID = "omniroute";

/**
 * Share the same per-user runtime/data folder Brahma Evo uses on Windows.
 * Other platforms keep OmniRoute inside AbacusAI Bot's own user-data folder.
 */
const omniRouteDataDir =
  process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA ||
          join(app.getPath("home"), "AppData", "Local"),
        "BrahmaAI",
        "OmniRoute"
      )
    : join(app.getPath("userData"), "OmniRoute");
const omniRouteEntry = join(
  omniRouteDataDir,
  "node_modules",
  "omniroute",
  "bin",
  "omniroute.mjs"
);
const omniRouteClientKeyPath = join(
  omniRouteDataDir,
  "abacusai-bot-client-api-key"
);

let gatewayProcess: ChildProcess | null = null;
let dashboardWindow: BrowserWindow | null = null;
let ensurePromise: Promise<string> | null = null;

type CommandResult = { code: number | null; output: string; stdout: string };

function pathEntries(): string[] {
  return (process.env.PATH || "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function findExecutable(names: string[]): string | null {
  const candidates: string[] = [];
  for (const entry of pathEntries()) {
    for (const name of names) candidates.push(join(entry, name));
  }
  if (process.env.BRAHMA_NODE_COMMAND) {
    candidates.unshift(process.env.BRAHMA_NODE_COMMAND);
  }
  if (process.env.PROGRAMFILES) {
    candidates.push(join(process.env.PROGRAMFILES, "nodejs", "node.exe"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function nodeAndNpm(): { node: string; npmArgs: string[] } {
  const node = findExecutable(
    process.platform === "win32" ? ["node.exe", "node"] : ["node"]
  );
  if (!node) {
    throw new Error(
      "OmniRoute needs Node.js installed on this computer. " +
        "Install Node.js 24, reopen AbacusAI Bot, and try again."
    );
  }

  const versionResult = spawnSync(node, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const version = String(versionResult.stdout ?? "").trim();
  const versionMatch = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number(versionMatch?.[1]);
  const minor = Number(versionMatch?.[2]);
  const patch = Number(versionMatch?.[3]);
  const supported22 =
    major === 22 && (minor > 22 || (minor === 22 && patch >= 2));
  const supported24Plus = major >= 24 && major < 27;
  const supported = supported22 || supported24Plus;
  if (
    versionResult.error ||
    versionResult.status !== 0 ||
    !versionMatch ||
    !supported
  ) {
    throw new Error(
      "OmniRoute 3.8.50 requires Node.js >=22.22.2 <23 or >=24 <27. " +
        `Found ${version || "an unreadable version"}. Install Node.js 24, ` +
        "reopen AbacusAI Bot, and try again."
    );
  }

  if (process.platform === "win32") {
    // Prefer npm's JavaScript entrypoint over npm.cmd, which requires a shell
    // and can incorrectly quote paths that contain spaces.
    const npmCli = join(
      dirname(node),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );
    if (!existsSync(npmCli)) {
      throw new Error(
        "The Node.js installation was found, but npm's CLI is missing. " +
          "Repair/reinstall Node.js with npm, then retry OmniRoute."
      );
    }
    return { node, npmArgs: [npmCli] };
  }

  const npm = findExecutable(["npm"]);
  if (!npm) {
    throw new Error(
      "npm was not found. Install Node.js with npm, then retry OmniRoute."
    );
  }
  return { node, npmArgs: [npm] };
}

function runtimeEnvironment(requireApiKey = true): NodeJS.ProcessEnv {
  const initialPassword = readInitialManagementPassword();
  const environment = { ...process.env };
  // OmniRoute treats these as an opt-in split-port configuration. Never inherit
  // them from the parent app shell when this gateway expects one shared port.
  delete environment.API_PORT;
  delete environment.DASHBOARD_PORT;
  return {
    ...environment,
    ...(initialPassword ? { INITIAL_PASSWORD: initialPassword } : {}),
    DATA_DIR: omniRouteDataDir,
    PORT: String(OMNIROUTE_PORT),
    OMNIROUTE_PORT: String(OMNIROUTE_PORT),
    OMNIROUTE_SERVER_HOST: "127.0.0.1",
    OMNIROUTE_TELEMETRY: "false",
    NODE_ENV: "production",
    // Requests from Abacus use a generated, persisted OmniRoute client key.
    // App-owned gateways always start with API-key enforcement enabled; key
    // provisioning uses OmniRoute's loopback-only CLI management token. No
    // unauthenticated bootstrap listener is opened.
    REQUIRE_API_KEY: requireApiKey ? "true" : "false",
  };
}

/**
 * The local OpenAI-compatible gateway does not need Playwright/Puppeteer
 * browser downloads for ordinary API providers. Avoid adding hundreds of MB
 * and a potentially slow CDN transfer to first-run startup. Browser-driven
 * provider workflows need their browser binaries installed separately.
 */
function runtimeInstallEnvironment(): NodeJS.ProcessEnv {
  return {
    ...runtimeEnvironment(),
    OMNIROUTE_SKIP_POSTINSTALL: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
  };
}

/**
 * Install only the API-gateway dependency set without executing upstream
 * postinstall download/build scripts. OmniRoute's bundled dist uses native
 * SQLite when compatible, then node:sqlite (available in supported Node 22+
 * versions), then sql.js. Restore the three regular JS runtime packages that
 * upstream normally copies into its standalone dist tree during postinstall.
 */
async function ensureRuntimeFallbackPackages(
  node: string,
  npmArgs: string[]
): Promise<void> {
  const modulesRoot = join(omniRouteDataDir, "node_modules");
  const standaloneRoot = join(modulesRoot, "omniroute", "dist", "node_modules");
  for (const packageName of ["@swc/helpers", "sql.js", "node-machine-id"]) {
    const source = join(modulesRoot, packageName);
    if (!existsSync(source)) {
      throw new Error(
        `The OmniRoute install is missing required runtime package ${packageName}.`
      );
    }
    const destination = join(standaloneRoot, packageName);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }

  // esbuild treats its OS/CPU binary as optional. Omitting the full optional
  // dependency set speeds the first install substantially, so install just
  // this one small package separately and put it where normal Node resolution
  // expects it. No install scripts are run for this native binary package.
  const esbuildManifest = join(modulesRoot, "esbuild", "package.json");
  if (!existsSync(esbuildManifest)) {
    throw new Error("The OmniRoute install is missing esbuild's runtime package.");
  }
  const esbuild = JSON.parse(readFileSync(esbuildManifest, "utf8")) as {
    version?: string;
    optionalDependencies?: Record<string, string>;
  };
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const platformVersion = esbuild.optionalDependencies?.[platformPackage];
  if (!esbuild.version || !platformVersion) {
    throw new Error(
      `esbuild ${esbuild.version ?? "(unknown)"} does not declare ${platformPackage}.`
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), "abacus-omniroute-esbuild-"));
  try {
    const result = await runCommand(
      node,
      [
        ...npmArgs,
        "install",
        "--prefix",
        tempDir,
        "--no-fund",
        "--no-audit",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-save",
        `${platformPackage}@${platformVersion}`,
      ],
      120_000,
      {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PUPPETEER_SKIP_DOWNLOAD: "1",
      },
      tempDir
    );
    if (result.code !== 0) {
      throw new Error(
        `Could not install ${platformPackage}@${platformVersion}: ${result.output}`
      );
    }
    const [scope, packageName] = platformPackage.split("/");
    const binarySource = join(tempDir, "node_modules", scope!, packageName!);
    const binaryManifest = join(binarySource, "package.json");
    if (!existsSync(binaryManifest)) {
      throw new Error(`npm did not install the required package ${platformPackage}.`);
    }
    const binaryDestination = join(modulesRoot, scope!, packageName!);
    mkdirSync(dirname(binaryDestination), { recursive: true });
    cpSync(binarySource, binaryDestination, { recursive: true, force: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = runtimeEnvironment(),
  cwd = omniRouteDataDir
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stdout = "";
    let settled = false;
    const append = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-5000);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-5000);
      append(chunk);
    });
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error("OmniRoute setup timed out. Check Node.js/npm and try again.")
      );
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start the OmniRoute setup command: ${error.message}`
        )
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, stdout });
    });
  });
}

async function installedVersion(node: string): Promise<string | null> {
  if (!existsSync(omniRouteEntry)) return null;
  const result = await runCommand(node, [omniRouteEntry, "--version"], 15_000);
  if (result.code !== 0) return null;
  return result.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null;
}

/**
 * On a truly empty data directory, create the required persistent secrets
 * before npm's postinstall can copy the package's publicly known CHANGEME
 * starter password. A random INITIAL_PASSWORD enables management
 * authentication, and the embedded dashboard logs in with it automatically.
 * Existing data
 * directories are deliberately left alone so we cannot rotate secrets for a
 * database that already has keys.
 */
function prepareFreshOmniRouteEnvironment(): void {
  const envPath = join(omniRouteDataDir, ".env");
  try {
    if (readdirSync(omniRouteDataDir).length !== 0 || existsSync(envPath)) {
      return;
    }
  } catch {
    return;
  }

  const contents = [
    `JWT_SECRET=${randomBytes(48).toString("base64url")}`,
    `API_KEY_SECRET=${randomBytes(32).toString("hex")}`,
    // A per-install salt prevents unrelated local accounts from deriving the
    // management token; OmniRoute 3.8.50's bundled CLI honors this variable.
    `OMNIROUTE_CLI_SALT=${randomBytes(32).toString("hex")}`,
    // Keep first-run management endpoints authenticated without requiring the
    // user to manually type a password in Abacus' embedded dashboard.
    `INITIAL_PASSWORD=${randomBytes(32).toString("base64url")}`,
    "",
  ].join("\n");
  try {
    writeFileSync(envPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Windows ACLs inherit from the user's private AppData directory.
    }
  } catch (error) {
    // Another Abacus/Brahma process may have initialized it at the same time.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function findExistingPinnedRuntimeNode(): Promise<string | null> {
  const node = findExecutable(
    process.platform === "win32" ? ["node.exe", "node"] : ["node"]
  );
  if (!node || !existsSync(omniRouteEntry)) return null;
  return (await installedVersion(node)) === OMNIROUTE_VERSION ? node : null;
}

async function ensureRuntimeInstalled(): Promise<string> {
  mkdirSync(omniRouteDataDir, { recursive: true });
  prepareFreshOmniRouteEnvironment();
  const { node, npmArgs } = nodeAndNpm();
  const version = await installedVersion(node);
  if (version !== OMNIROUTE_VERSION) {
    const result = await runCommand(
      node,
      [
        ...npmArgs,
        "install",
        "--prefix",
        omniRouteDataDir,
        "--no-fund",
        "--no-audit",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=optional",
        `omniroute@${OMNIROUTE_VERSION}`,
      ],
      5 * 60_000,
      runtimeInstallEnvironment()
    );
    if (result.code !== 0) {
      // Do not expose potentially noisy installer output to the renderer.
      throw new Error(
        "Could not install the pinned OmniRoute runtime. " +
          "Check your internet connection and Node.js/npm installation, " +
          "then retry."
      );
    }
  }

  const verifiedVersion = await installedVersion(node);
  if (verifiedVersion !== OMNIROUTE_VERSION) {
    throw new Error(
      `OmniRoute version verification failed; expected ${OMNIROUTE_VERSION}. ` +
        "No provider keys were changed."
    );
  }
  await ensureRuntimeFallbackPackages(node, npmArgs);
  return node;
}

async function waitForOmniRouteDashboard(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOmniRouteDashboardReachable()) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return isOmniRouteDashboardReachable();
}

async function waitForOmniRoute(
  child: ChildProcess,
  apiKey: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOmniRouteReady(apiKey)) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return isOmniRouteReady(apiKey);
}

async function isOmniRouteDashboardReachable(): Promise<boolean> {
  try {
    const [modelsResponse, homeResponse] = await Promise.all([
      fetch(`${OMNIROUTE_BASE_URL}/models`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      }),
      // OmniRoute 3.8.50 intentionally redirects "/" to "/dashboard".
      // Inspect the redirect instead of treating a normal same-origin redirect
      // as a failed health check.
      fetch(`${OMNIROUTE_ORIGIN}/`, {
        headers: { Accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(1500),
      }),
    ]);
    if (![200, 401, 403].includes(modelsResponse.status)) return false;

    if (homeResponse.status >= 300 && homeResponse.status < 400) {
      const location = homeResponse.headers.get("location");
      if (!location) return false;
      const destination = new URL(location, OMNIROUTE_ORIGIN);
      return (
        destination.origin === OMNIROUTE_ORIGIN &&
        ["/dashboard", "/login"].includes(destination.pathname)
      );
    }

    if (!homeResponse.ok) return false;
    if (new URL(homeResponse.url).origin !== OMNIROUTE_ORIGIN) return false;
    const dashboard = (await homeResponse.text()).slice(0, 500_000);
    return /omniroute/i.test(dashboard);
  } catch {
    return false;
  }
}

async function isOmniRouteReady(apiKey: string): Promise<boolean> {
  try {
    const [modelsResponse, homeResponse] = await Promise.all([
      fetch(`${OMNIROUTE_BASE_URL}/models`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      }),
      fetch(`${OMNIROUTE_ORIGIN}/`, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(1500),
      }),
    ]);
    if (!modelsResponse.ok || !homeResponse.ok) return false;
    if (new URL(homeResponse.url).origin !== OMNIROUTE_ORIGIN) return false;
    const models = (await modelsResponse.json()) as { data?: unknown };
    const dashboard = (await homeResponse.text()).slice(0, 500_000);
    return Array.isArray(models.data) && /omniroute/i.test(dashboard);
  } catch {
    return false;
  }
}

function readOmniRouteClientKey(): string | null {
  try {
    const value = readFileSync(omniRouteClientKeyPath, "utf8").trim();
    return value.length >= 16 ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "The saved OmniRoute client key could not be read securely."
    );
  }
}

function persistOmniRouteClientKey(apiKey: string): string {
  writeFileSync(omniRouteClientKeyPath, `${apiKey.trim()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(omniRouteClientKeyPath, 0o600);
  } catch {
    // On Windows, inherit the private ACL of the user's LocalAppData folder.
  }
  return apiKey.trim();
}

function readOmniRouteCliSalt(): string {
  const builtinDefaultSalt = "omniroute-cli-auth-v1";
  if (process.env.OMNIROUTE_CLI_SALT !== undefined) {
    return process.env.OMNIROUTE_CLI_SALT || builtinDefaultSalt;
  }

  try {
    const contents = readFileSync(join(omniRouteDataDir, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (
        separator < 0 ||
        trimmed.slice(0, separator).trim() !== "OMNIROUTE_CLI_SALT"
      ) {
        continue;
      }
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value || builtinDefaultSalt;
    }
  } catch {
    // Older shared installations may use OmniRoute's built-in salt.
  }
  return builtinDefaultSalt;
}

/**
 * Match OmniRoute 3.8.50's server-side machine-token derivation locally.
 * Only the HMAC token is sent, as a loopback-only CLI header; the machine ID
 * itself never leaves this process.
 */
function deriveOmniRouteCliToken(): string | null {
  try {
    const machineIdModule = createRequire(omniRouteEntry)(
      "node-machine-id"
    ) as {
      machineIdSync?: (original?: boolean) => string;
      default?: { machineIdSync?: (original?: boolean) => string };
    };
    const machineIdSync =
      machineIdModule.machineIdSync || machineIdModule.default?.machineIdSync;
    if (typeof machineIdSync !== "function") return null;
    const rawMachineId = machineIdSync(true);
    if (!rawMachineId) return null;
    return createHmac("sha256", rawMachineId)
      .update(readOmniRouteCliSalt())
      .digest("hex");
  } catch {
    return null;
  }
}

async function createOmniRouteClientKey(
  node: string | null,
  allowCliFallback: boolean
): Promise<string> {
  const sessionToken = await loginOmniRouteManagement();
  if (sessionToken) {
    try {
      const response = await fetch(`${OMNIROUTE_ORIGIN}/api/keys`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: `auth_token=${sessionToken}`,
          Origin: OMNIROUTE_ORIGIN,
        },
        body: JSON.stringify({ name: "AbacusAI Bot" }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as { key?: unknown };
        if (typeof payload.key === "string" && payload.key.length >= 16) {
          // A successful create response is not proof that OmniRoute accepts
          // the key on the OpenAI-compatible endpoint. Verify it before saving.
          if (await isOmniRouteReady(payload.key)) {
            return persistOmniRouteClientKey(payload.key);
          }
          // Continue to the CLI-token route below. Some 3.8.50 installs have
          // returned dashboard-created keys that fail Bearer authentication.
        }
      }
    } catch {
      // Existing shared runtimes may have a different dashboard password.
    }
  }

  if (!allowCliFallback) {
    throw new Error(
      "OmniRoute could not create a client key through its authenticated " +
        "management session. The local dashboard login or API-key setup failed."
    );
  }

  // When dashboard login is unavailable (for example on an existing install),
  // use OmniRoute's loopback-only machine-token header to provision the key.
  // This fallback does not turn off API-key enforcement for inference requests.
  if (!node) {
    throw new Error(
      "OmniRoute could not create the client key through its dashboard session, " +
        "and the matching pinned local runtime is unavailable. The shared gateway " +
        "was left untouched; verify dashboard login or the OmniRoute 3.8.50 install."
    );
  }
  const cliToken = deriveOmniRouteCliToken();
  if (!cliToken) {
    throw new Error(
      "OmniRoute's local machine token could not be derived from this installation. " +
        "The existing gateway was left running and untouched."
    );
  }
  let response: Response;
  try {
    response = await fetch(`${OMNIROUTE_ORIGIN}/api/keys`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-omniroute-cli-token": cliToken,
        Origin: OMNIROUTE_ORIGIN,
      },
      body: JSON.stringify({ name: "AbacusAI Bot" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      "Could not reach OmniRoute's loopback key provisioning endpoint. " +
        "The existing gateway was left running and untouched."
    );
  }
  if (!response.ok) {
    throw new Error(
      `OmniRoute rejected loopback client-key provisioning (HTTP ${response.status}). ` +
        "The existing gateway was left running and untouched."
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    key?: unknown;
  } | null;
  const apiKey = payload?.key;
  if (typeof apiKey !== "string" || apiKey.length < 16) {
    throw new Error("OmniRoute did not return a valid client API key.");
  }
  if (!(await isOmniRouteReady(apiKey))) {
    throw new Error(
      "OmniRoute created a client key, but the authenticated /v1/models " +
        "check rejected it. No unverified client key was saved."
    );
  }
  return persistOmniRouteClientKey(apiKey);
}

function readInitialManagementPassword(): string | null {
  const environmentValue = process.env.INITIAL_PASSWORD;
  if (typeof environmentValue === "string" && environmentValue.length > 0) {
    return environmentValue;
  }

  try {
    const contents = readFileSync(join(omniRouteDataDir, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (
        separator < 0 ||
        trimmed.slice(0, separator).trim() !== "INITIAL_PASSWORD"
      ) {
        continue;
      }
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : null;
    }
  } catch {
    // Existing installs may manage their password in the dashboard instead.
  }
  return null;
}

async function loginOmniRouteManagement(): Promise<string | null> {
  const password = readInitialManagementPassword();
  if (!password) return null;

  try {
    const response = await fetch(`${OMNIROUTE_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: OMNIROUTE_ORIGIN,
      },
      body: JSON.stringify({ password }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const cookieHeaders = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookie =
      cookieHeaders.getSetCookie?.().join(", ") ||
      response.headers.get("set-cookie") ||
      "";
    return /(?:^|,\s*)auth_token=([^;,\s]+)/.exec(setCookie)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function authenticateOmniRouteDashboard(
  window: BrowserWindow
): Promise<void> {
  const token = await loginOmniRouteManagement();
  if (!token) return;

  try {
    await window.webContents.session.cookies.set({
      url: OMNIROUTE_ORIGIN,
      name: "auth_token",
      value: token,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
    });
  } catch {
    // Never block the dashboard from opening if auto-login is unavailable.
  }
}

async function portIsOccupied(): Promise<boolean> {
  try {
    const response = await fetch(OMNIROUTE_ORIGIN, {
      redirect: "manual",
      signal: AbortSignal.timeout(700),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

function startOmniRoute(node: string, requireApiKey: boolean): ChildProcess {
  const child = spawn(
    node,
    [
      omniRouteEntry,
      "--no-open",
      "--no-recovery",
      "--port",
      String(OMNIROUTE_PORT),
    ],
    {
      cwd: omniRouteDataDir,
      env: runtimeEnvironment(requireApiKey),
      windowsHide: true,
      stdio: "ignore",
    }
  );
  gatewayProcess = child;
  child.once("error", () => {
    if (gatewayProcess === child) gatewayProcess = null;
  });
  child.once("exit", () => {
    if (gatewayProcess === child) gatewayProcess = null;
  });
  return child;
}

async function ensureOmniRoute(): Promise<string> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    let clientKey = readOmniRouteClientKey();
    if (clientKey && (await isOmniRouteReady(clientKey))) return clientKey;

    // Prefer a shared Brahma/OmniRoute process when one is already healthy.
    // Creating an API key uses OmniRoute's loopback-only CLI management auth;
    // it does not require stopping or reconfiguring a process owned by Brahma.
    if (await isOmniRouteDashboardReachable()) {
      // Never npm-install or replace files underneath a gateway another app
      // already owns. Dashboard-session provisioning needs no local CLI; the
      // CLI fallback is allowed only when the matching pinned runtime exists.
      const node = await findExistingPinnedRuntimeNode();
      clientKey = await createOmniRouteClientKey(node, true);
      if (await isOmniRouteReady(clientKey)) return clientKey;
      throw new Error(
        "OmniRoute created a client key but the authenticated model endpoint " +
          "did not pass its readiness check."
      );
    }

    if (await portIsOccupied()) {
      throw new Error(
        `Port ${OMNIROUTE_PORT} is already in use by a service that did not pass ` +
          "the OmniRoute health checks. Close or verify that service " +
          "before starting the gateway."
      );
    }

    const node = await ensureRuntimeInstalled();

    // Start with API-key enforcement enabled before listening on the port.
    // OmniRoute's management API accepts its loopback-only CLI token, so the
    // app can create a real client key without exposing unauthenticated
    // /v1 routes.
    const child = startOmniRoute(node, true);
    if (!(await waitForOmniRouteDashboard(child, 30_000))) {
      if (child.exitCode === null && child.signalCode === null) {
        await stopOmniRoute();
      }
      throw new Error(
        "OmniRoute did not become ready for secure key provisioning. " +
          "Check Node.js/npm, then retry."
      );
    }

    try {
      clientKey = await createOmniRouteClientKey(node, true);
      if (!(await waitForOmniRoute(child, clientKey, 30_000))) {
        throw new Error(
          "OmniRoute did not pass its authenticated readiness check after " +
            "client key creation."
        );
      }
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        await stopOmniRoute();
      }
      throw error;
    }
    return clientKey;
  })();

  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

function ensureAbacusProvider(clientKey: string): void {
  const provider: CustomProviderEntry = {
    id: PROVIDER_ID,
    name: "OmniRoute",
    baseUrl: OMNIROUTE_BASE_URL,
    // This is an API key generated and persisted by OmniRoute itself, not an
    // upstream provider credential or a hard-coded placeholder.
    apiKey: clientKey,
    models: [
      {
        id: "auto",
        name: "OmniRoute Auto",
        reasoning: true,
        contextWindow: 262_144,
        maxTokens: 32_768,
      },
    ],
  };
  upsertCustomProvider(provider);
  setDefaultModel(DEFAULT_MODEL);
}

function openExternalHttps(target: string): void {
  if (isSafeExternalUrl(target) && target.startsWith("https://")) {
    void shell.openExternal(target);
  }
}

/**
 * Start/attach to the local gateway, register its model, and open its window.
 */
export async function openOmniRouteWindow(): Promise<{
  ok: true;
  message: string;
}> {
  const clientKey = await ensureOmniRoute();
  ensureAbacusProvider(clientKey);

  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    dashboardWindow = new BrowserWindow({
      title: "OmniRoute Gateway",
      width: 1040,
      height: 740,
      minWidth: 780,
      minHeight: 560,
      resizable: true,
      center: true,
      autoHideMenuBar: true,
      backgroundColor: "#111827",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (new URL(url).origin === OMNIROUTE_ORIGIN) {
          return { action: "allow" };
        }
      } catch {
        // Malformed or non-URL targets are denied below.
      }
      openExternalHttps(url);
      return { action: "deny" };
    });
    dashboardWindow.webContents.on("will-navigate", (event, target) => {
      try {
        if (new URL(target).origin !== OMNIROUTE_ORIGIN) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    dashboardWindow.once("closed", () => {
      dashboardWindow = null;
    });
    await authenticateOmniRouteDashboard(dashboardWindow);
    await dashboardWindow.loadURL(OMNIROUTE_ORIGIN);
  } else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }

  return {
    ok: true,
    message:
      "OmniRoute is ready. Add provider API keys in the OmniRoute window; " +
      "AbacusAI Bot now defaults new sessions to OmniRoute Auto.",
  };
}

/**
 * Stop only the gateway process tree this app started; never stop a shared instance.
 * OmniRoute's CLI starts a supervisor and a separate server child. On Windows,
 * terminating just the CLI can orphan that server, so taskkill is scoped to the
 * owned CLI PID and its descendants.
 */
export async function stopOmniRoute(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    const taskkill = join(
      process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
      "System32",
      "taskkill.exe"
    );
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        killer.kill();
        finish();
      }, 5000);
      killer.once("error", finish);
      killer.once("close", finish);
    });
  } else {
    child.kill("SIGTERM");
  }

  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
