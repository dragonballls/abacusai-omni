/**
 * Local OmniRoute runtime and credential bridge.
 *
 * Mirrors the Brahma Evo integration: pinned OmniRoute 3.8.50, loopback-only
 * HTTP, no browser auto-open, and API keys sent to the CLI over stdin rather
 * than command-line arguments or Abacus Bot's config.json.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

import type {
  OmniRouteConnection,
  OmniRouteOperationResult,
  OmniRouteProvider,
  OmniRouteStatus,
} from "@abacus-ai/contract/settings";
import { setDefaultModel, upsertCustomProvider } from "../config/settings";

const OMNIROUTE_VERSION = "3.8.50";
const OMNIROUTE_PORT = 20128;
const BASE_URL = "http://127.0.0.1:" + OMNIROUTE_PORT + "/v1";
const MODEL_ID = "auto";
const PROVIDER_ID = "omniroute";
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 60_000;

const providerLabel: Record<OmniRouteProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  groq: "Groq",
  cerebras: "Cerebras",
  mistral: "Mistral",
  xai: "xAI",
  cohere: "Cohere",
};

const findExecutable = (names: string[]): string | null => {
  const pathValue = process.env.PATH ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const name of names) {
      const candidates = path.extname(name)
        ? [path.join(dir, name)]
        : extensions.map((ext) => path.join(dir, name + ext.toLowerCase()));
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // Keep looking through PATH.
        }
      }
    }
  }
  return null;
};

const isProvider = (value: string): value is OmniRouteProvider =>
  Object.hasOwn(providerLabel, value);

export class OmniRouteService {
  private child: ChildProcess | null = null;
  private startInFlight: Promise<OmniRouteStatus> | null = null;
  private readonly dataDir = path.join(
    process.env.LOCALAPPDATA ||
      (process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local")
        : path.join(os.homedir(), ".local", "share")),
    "BrahmaAI",
    "OmniRoute"
  );
  private readonly entryPath = path.join(
    this.dataDir,
    "node_modules",
    "omniroute",
    "bin",
    "omniroute.mjs"
  );

  constructor() {
    app.once("before-quit", () => this.stop());
  }

  private runtimeEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DATA_DIR: this.dataDir,
      PORT: String(OMNIROUTE_PORT),
      OMNIROUTE_TELEMETRY: "false",
    };
  }

  private nodeExecutable(): string {
    // Prefer standalone Node; Electron can run its own Node runtime as a child.
    return (
      findExecutable(process.platform === "win32" ? ["node.exe", "node"] : ["node"]) ??
      process.execPath
    );
  }

  private async probe(): Promise<boolean> {
    try {
      const response = await fetch(BASE_URL + "/models", {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(900),
      });
      if (!response.ok) return false;
      const payload: unknown = await response.json();
      return (
        payload != null &&
        typeof payload === "object" &&
        Array.isArray((payload as { data?: unknown }).data)
      );
    } catch {
      return false;
    }
  }

  async status(): Promise<OmniRouteStatus> {
    const running = await this.probe();
    const installed = fs.existsSync(this.entryPath);
    let version: string | null = null;
    if (installed) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(this.dataDir, "node_modules", "omniroute", "package.json"), "utf8")
        ) as { version?: unknown };
        if (typeof pkg.version === "string") version = pkg.version;
      } catch {
        version = null;
      }
    }
    return {
      available: running || installed,
      running,
      baseUrl: BASE_URL,
      version,
      message: running
        ? "OmniRoute is responding on this PC."
        : installed
          ? "OmniRoute is installed but not running. Start it to connect models."
          : "OmniRoute has not been installed yet. Start it to install the pinned runtime.",
    };
  }

  private installRuntime(): void {
    if (fs.existsSync(this.entryPath)) return;
    const npm = findExecutable(
      process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"]
    );
    if (!npm) {
      throw new Error(
        "Node.js and npm were not found. Install the current Node.js LTS runtime, then reopen OmniRoute."
      );
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
    const result = spawnSync(
      npm,
      [
        "install",
        "--prefix",
        this.dataDir,
        "--no-fund",
        "--no-audit",
        "--omit=dev",
        "omniroute@" + OMNIROUTE_VERSION,
      ],
      {
        encoding: "utf8",
        timeout: INSTALL_TIMEOUT_MS,
        windowsHide: true,
        shell: process.platform === "win32",
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    if (result.error || result.status !== 0 || !fs.existsSync(this.entryPath)) {
      // Avoid exposing package-manager output in the UI.
      throw new Error(
        "OmniRoute could not be installed. Check Node/npm and your network connection, then retry."
      );
    }
  }

  private async runCli(
    args: string[],
    stdinText?: string,
    timeoutMs = CLI_TIMEOUT_MS
  ): Promise<{ ok: boolean; stdout: string }> {
    this.installRuntime();
    return await new Promise((resolve, reject) => {
      const node = this.nodeExecutable();
      const env = this.runtimeEnvironment();
      if (node === process.execPath && process.versions.electron) {
        env.ELECTRON_RUN_AS_NODE = "1";
      }
      const child = spawn(node, [this.entryPath, ...args], {
        env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let settled = false;
      let stdout = "";
      const finish = (value: { ok: boolean; stdout: string }, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, stdout: "" }, new Error("OmniRoute command timed out."));
      }, timeoutMs);
      child.once("error", () =>
        finish({ ok: false, stdout: "" }, new Error("Could not start the OmniRoute command."))
      );
      child.stdout.on("data", (chunk: Buffer | string) => {
        // The CLI redacts provider credentials from structured output.
        // Cap captured text and never expose raw output in errors or UI messages.
        if (stdout.length < 1_000_000) stdout += String(chunk).slice(0, 1_000_000 - stdout.length);
      });
      child.once("close", (code) => finish({ ok: code === 0, stdout }));
      // Credentials travel through stdin only; never argv, logs, or responses.
      child.stdin.end(stdinText == null ? undefined : stdinText.trim() + "\n");
    });
  }

  async listConnections(): Promise<OmniRouteConnection[]> {
    if (!fs.existsSync(this.entryPath)) return [];
    const result = await this.runCli(
      ["--non-interactive", "providers", "list", "--json"],
      undefined,
      15_000
    );
    if (!result.ok) return [];
    try {
      const payload = JSON.parse(result.stdout) as { providers?: unknown };
      if (!Array.isArray(payload.providers)) return [];
      return payload.providers.flatMap((item): OmniRouteConnection[] => {
        if (item == null || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        const name = typeof row.name === "string" ? row.name.trim() : "";
        const provider = typeof row.provider === "string" ? row.provider.trim() : "";
        if (!id || !name || !provider) return [];
        return [{
          id,
          name,
          provider,
          isActive: row.isActive !== false,
          testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
        }];
      });
    } catch {
      return [];
    }
  }

  async start(): Promise<OmniRouteStatus> {
    if (this.startInFlight) return await this.startInFlight;
    this.startInFlight = this.startInner().finally(() => {
      this.startInFlight = null;
    });
    return await this.startInFlight;
  }

  private async startInner(): Promise<OmniRouteStatus> {
    if (!(await this.probe())) {
      this.installRuntime();
      const node = this.nodeExecutable();
      const env = this.runtimeEnvironment();
      if (node === process.execPath && process.versions.electron) {
        env.ELECTRON_RUN_AS_NODE = "1";
      }
      this.child = spawn(
        node,
        [this.entryPath, "--no-open", "--port", String(OMNIROUTE_PORT)],
        {
          env,
          stdio: "ignore",
          windowsHide: true,
        }
      );
      this.child.once("error", () => {
        this.child = null;
      });

      const deadline = Date.now() + START_TIMEOUT_MS;
      let ready = false;
      while (Date.now() < deadline) {
        if (this.child == null || this.child.exitCode != null) break;
        if (await this.probe()) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) {
        this.stop();
        throw new Error(
          "OmniRoute did not become ready on 127.0.0.1:20128. Check whether another service is using that port."
        );
      }
    }

    // Register the loopback endpoint with the existing model runtime. Upstream
    // credentials live in OmniRoute's store; the Abacus config contains no real key.
    upsertCustomProvider({
      id: PROVIDER_ID,
      name: "OmniRoute",
      baseUrl: BASE_URL,
      apiKey: "local",
      models: [
        {
          id: MODEL_ID,
          name: "OmniRoute Auto (provider costs and quotas apply)",
          contextWindow: 1_000_000,
          maxTokens: 32_768,
        },
      ],
    });
    setDefaultModel(PROVIDER_ID + "/" + MODEL_ID);
    return await this.status();
  }

  async addKey(
    provider: OmniRouteProvider,
    rawName: string,
    rawKey: string
  ): Promise<OmniRouteOperationResult> {
    if (!isProvider(provider)) throw new Error("Choose a supported AI provider.");
    const name = String(rawName ?? "").trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error("Connection name must be 1–64 characters without control characters.");
    }
    const key = rawKey.trim();
    if (key.length < 8 || !/^[\u0021-\u007e]+$/.test(key)) {
      throw new Error("Enter a valid-looking API key without spaces or line breaks.");
    }
    await this.start();
    const result = await this.runCli(
      ["--non-interactive", "providers", "add", provider, "--name", name, "--credential-stdin", "--json"],
      key
    );
    if (!result.ok) {
      throw new Error(
        "OmniRoute could not save connection '" + name + "' for " + providerLabel[provider] + ". Check the provider and key, then retry."
      );
    }
    let connectionId: string | undefined;
    try {
      const payload = JSON.parse(result.stdout) as { connection?: { id?: unknown } };
      if (typeof payload.connection?.id === "string") connectionId = payload.connection.id;
    } catch {
      // An older compatible build may return a non-JSON success line.
    }
    return {
      ok: true,
      provider,
      ...(connectionId ? { connectionId } : {}),
      connectionName: name,
      message: "Saved '" + name + "' to OmniRoute. The key was not stored in Abacus Bot settings.",
    };
  }

  async testConnection(rawId: string): Promise<OmniRouteOperationResult> {
    const id = String(rawId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("Choose a saved OmniRoute connection to test.");
    }
    const connection = (await this.listConnections()).find((item) => item.id === id);
    if (!connection) throw new Error("That OmniRoute connection no longer exists. Refresh the list and retry.");
    const result = await this.runCli(
      ["--non-interactive", "providers", "test", id, "--json"]
    );
    return {
      ok: result.ok,
      provider: connection.provider,
      connectionId: id,
      connectionName: connection.name,
      message: result.ok
        ? "Connection test passed for '" + connection.name + "'."
        : "Connection test failed for '" + connection.name + "'. Check its saved key, provider status and quota.",
    };
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null && !child.killed) child.kill();
  }
}

export const omniRouteService = new OmniRouteService();
