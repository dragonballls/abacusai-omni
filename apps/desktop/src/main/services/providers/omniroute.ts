/**
 * Local OmniRoute gateway integration for AbacusAI Bot.
 *
 * Matches Brahma Evo's pinned OmniRoute 3.8.50 runtime and shared Windows
 * data directory. Upstream provider credentials are entered in OmniRoute's
 * own dashboard and are never copied into AbacusAI Bot settings.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { app, BrowserWindow, shell } from "electron";

import type { CustomProviderEntry } from "@abacus-ai/contract/settings";
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
        process.env.LOCALAPPDATA || join(app.getPath("home"), "AppData", "Local"),
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

let gatewayProcess: ChildProcess | null = null;
let dashboardWindow: BrowserWindow | null = null;
let ensurePromise: Promise<void> | null = null;

type CommandResult = { code: number | null; output: string };

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
      "OmniRoute needs Node.js installed on this computer. Install Node.js 24, reopen AbacusAI Bot, and try again."
    );
  }

  if (process.platform === "win32") {
    // Prefer npm's JavaScript entrypoint over npm.cmd, which requires a shell
    // and can incorrectly quote paths that contain spaces.
    const npmCli = join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) {
      throw new Error(
        "The Node.js installation was found, but npm's CLI is missing. Repair/reinstall Node.js with npm, then retry OmniRoute."
      );
    }
    return { node, npmArgs: [npmCli] };
  }

  const npm = findExecutable(["npm"]);
  if (!npm) {
    throw new Error("npm was not found. Install Node.js with npm, then retry OmniRoute.");
  }
  return { node, npmArgs: [npm] };
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATA_DIR: omniRouteDataDir,
    PORT: String(OMNIROUTE_PORT),
    OMNIROUTE_SERVER_HOST: "127.0.0.1",
    OMNIROUTE_TELEMETRY: "false",
    NODE_ENV: "production",
    // Safe only because the listener is explicitly restricted to loopback.
    // This avoids asking for a second, unrelated proxy key in Abacus settings.
    REQUIRE_API_KEY: "false",
  };
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: omniRouteDataDir,
      env: runtimeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const append = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-5000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("OmniRoute setup timed out. Check Node.js/npm and try again."));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start the OmniRoute setup command: ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function installedVersion(node: string): Promise<string | null> {
  if (!existsSync(omniRouteEntry)) return null;
  const result = await runCommand(node, [omniRouteEntry, "--version"], 15_000);
  if (result.code !== 0) return null;
  return result.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null;
}

async function ensureRuntimeInstalled(): Promise<string> {
  mkdirSync(omniRouteDataDir, { recursive: true });
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
        "--omit=dev",
        `omniroute@${OMNIROUTE_VERSION}`,
      ],
      5 * 60_000
    );
    if (result.code !== 0) {
      // Do not expose potentially noisy installer output to the renderer.
      throw new Error(
        "Could not install the pinned OmniRoute runtime. Check your internet connection and Node.js/npm installation, then retry."
      );
    }
  }

  const verifiedVersion = await installedVersion(node);
  if (verifiedVersion !== OMNIROUTE_VERSION) {
    throw new Error(
      `OmniRoute version verification failed; expected ${OMNIROUTE_VERSION}. No provider keys were changed.`
    );
  }
  return node;
}

async function waitForOmniRoute(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOmniRouteReady()) return true;
    if (gatewayProcess && gatewayProcess.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return isOmniRouteReady();
}

async function isOmniRouteReady(): Promise<boolean> {
  try {
    const [modelsResponse, homeResponse] = await Promise.all([
      fetch(`${OMNIROUTE_BASE_URL}/models`, {
        headers: { Accept: "application/json" },
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

async function ensureOmniRoute(): Promise<void> {
  if (await isOmniRouteReady()) return;
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    if (await isOmniRouteReady()) return;
    if (await portIsOccupied()) {
      throw new Error(
        `Port ${OMNIROUTE_PORT} is already in use by a service that did not pass the OmniRoute health checks. Close or verify that service before starting the gateway.`
      );
    }

    const node = await ensureRuntimeInstalled();
    const child = spawn(
      node,
      [omniRouteEntry, "--no-open", "--port", String(OMNIROUTE_PORT)],
      {
        cwd: omniRouteDataDir,
        env: runtimeEnvironment(),
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

    if (!(await waitForOmniRoute(30_000))) {
      if (child.exitCode === null) child.kill();
      if (gatewayProcess === child) gatewayProcess = null;
      throw new Error(
        "OmniRoute did not become ready on its local port. Check Node.js/npm, then retry."
      );
    }
  })();

  try {
    await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

function ensureAbacusProvider(): void {
  const provider: CustomProviderEntry = {
    id: PROVIDER_ID,
    name: "OmniRoute",
    baseUrl: OMNIROUTE_BASE_URL,
    // OmniRoute is bound to loopback with its upstream keys managed by its
    // dashboard. This is a local placeholder, not a real provider credential.
    apiKey: "local-omniroute",
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

/** Start/attach to the local gateway, register its model, and open its window. */
export async function openOmniRouteWindow(): Promise<{
  ok: true;
  message: string;
}> {
  await ensureOmniRoute();
  ensureAbacusProvider();

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
      if (new URL(url).origin === OMNIROUTE_ORIGIN) return { action: "allow" };
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
    await dashboardWindow.loadURL(OMNIROUTE_ORIGIN);
  } else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }

  return {
    ok: true,
    message:
      "OmniRoute is ready. Add provider API keys in the OmniRoute window; AbacusAI Bot now defaults new sessions to OmniRoute Auto.",
  };
}

/** Stop only the gateway process this app started; never stop a shared instance. */
export async function stopOmniRoute(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve();
    }, 2500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}
