/**
 * The router as both loops drive it: when a direct provider API's shared
 * free quota runs out, the next configured API source should take over, and
 * the exhausted source should stay out across chats.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CooldownEntries, CooldownStore } from "./openllm-cooldowns.js";
import type { ModelChoice } from "./providers.js";

const pool = vi.hoisted(() => ({ models: [] as ModelChoice[] }));
vi.mock("./providers.js", () => ({
  listModels: () => pool.models,
}));

const { OpenLlmRouter } = await import("./openllm-router.js");
const { memoryQuotaStore } = await import("./openllm-quota.js");

const choice = (id: string, free = true): ModelChoice => ({
  provider: id.split("/")[0]!,
  modelId: id.split("/").slice(1).join("/"),
  id,
  label: id,
  free,
  inputCost: 0,
  reasoning: false,
  contextWindow: 128_000,
  // Abacus models are never part of automatic API fallback.
  ...(id.startsWith("abacus/") ? { poolEligible: true, poolRank: 0 } : {}),
});

/** What a file store keeps between chats, in memory. */
const memoryStore = (): CooldownStore => {
  let entries: CooldownEntries = {};
  return {
    read: () => ({ ...entries }),
    write: (next) => {
      entries = { ...entries, ...next };
    },
  };
};

const registry = {} as ModelRegistry;
const QUOTA_EXHAUSTED =
  '429: {"error":{"status":"RESOURCE_EXHAUSTED","message":"exceeded your current quota"}}';

beforeEach(() => {
  pool.models = [
    choice("gemini/gemini-3.6-flash"),
    choice("openrouter/big:free"),
  ];
});

describe("a provider whose free API quota is exhausted", () => {
  it("is put out as a whole, and the next source takes the turn", () => {
    const router = new OpenLlmRouter(
      () => 1_000,
      memoryStore(),
      memoryQuotaStore()
    );
    expect(router.pick(registry)?.id).toBe("gemini/gemini-3.6-flash");

    const next = router.failed(registry, QUOTA_EXHAUSTED, {
      provider: "gemini",
      id: "gemini-3.6-flash",
    });

    expect(next).toEqual({ nextId: "openrouter/big:free" });
    expect(router.poolShut(registry)).toBe(false);
  });

  it("stays out for the next chat, which starts on the next source", () => {
    const store = memoryStore();
    const first = new OpenLlmRouter(() => 1_000, store, memoryQuotaStore());
    first.failed(registry, QUOTA_EXHAUSTED, {
      provider: "gemini",
      id: "gemini-3.6-flash",
    });

    // A new chat is a new process with a new router on the same file.
    const second = new OpenLlmRouter(() => 2_000, store, memoryQuotaStore());
    expect(second.pick(registry)?.id).toBe("openrouter/big:free");
  });

  it("shuts the pool once every source has refused", () => {
    pool.models = [choice("gemini/gemini-3.6-flash")];
    const router = new OpenLlmRouter(
      () => 1_000,
      memoryStore(),
      memoryQuotaStore()
    );

    expect(
      router.failed(registry, QUOTA_EXHAUSTED, {
        provider: "gemini",
        id: "gemini-3.6-flash",
      })
    ).toBeNull();
    expect(router.poolShut(registry)).toBe(true);
  });
});

describe("a model that merely failed", () => {
  it("sits out on its own and is not returned to this turn", () => {
    pool.models = [
      choice("openrouter/big:free"),
      choice("openrouter/small:free"),
    ];
    const router = new OpenLlmRouter(
      () => 1_000,
      memoryStore(),
      memoryQuotaStore()
    );

    const next = router.failed(registry, "429: rate limited upstream", {
      provider: "openrouter",
      id: "big:free",
    });
    expect(next).toEqual({ nextId: "openrouter/small:free" });

    // The second model fails too: nothing is left this turn, whatever the
    // cooldown clock says about the first.
    expect(
      router.failed(registry, "429: rate limited upstream", {
        provider: "openrouter",
        id: "small:free",
      })
    ).toBeNull();

    // A new turn may ask the soonest-free one again.
    router.beginTurn();
    expect(router.pick(registry)).toBeDefined();
  });

  it("starts from a clean sheet once it answers", () => {
    pool.models = [
      choice("openrouter/big:free"),
      choice("openrouter/small:free"),
    ];
    let now = 1_000;
    const router = new OpenLlmRouter(
      () => now,
      memoryStore(),
      memoryQuotaStore()
    );
    router.failed(registry, "429: rate limited upstream", {
      provider: "openrouter",
      id: "big:free",
    });
    router.beginTurn();
    now += 1;
    expect(router.pick(registry)?.id).toBe("openrouter/small:free");

    router.succeeded("openrouter/big:free");
    expect(router.pick(registry)?.id).toBe("openrouter/big:free");
  });
});

describe("the sources beyond Abacus, Gemini and OpenRouter", () => {
  const reply = (provider: string, model: string, totalTokens = 1_000) => ({
    role: "assistant",
    provider,
    model,
    stopReason: "stop",
    usage: { totalTokens },
  });

  it("waits out the time the provider named, not a guess", () => {
    pool.models = [
      choice("groq/openai/gpt-oss-120b"),
      choice("groq/qwen/qwen3.8-27b"),
    ];
    let now = 1_000;
    const router = new OpenLlmRouter(
      () => now,
      memoryStore(),
      memoryQuotaStore()
    );

    router.failed(
      registry,
      "429 Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM). Please try again in 7m12s.",
      { provider: "groq", id: "openai/gpt-oss-120b" }
    );
    router.beginTurn();
    now += 7 * 60_000;
    expect(router.pick(registry)?.id).toBe("groq/qwen/qwen3.8-27b");
    now += 13_000;
    expect(router.pick(registry)?.id).toBe("groq/openai/gpt-oss-120b");
  });

  it("puts a refused key out across all its models, and the next source takes over", () => {
    pool.models = [
      choice("mistral/devstral-latest"),
      choice("mistral/mistral-small-latest"),
      choice("nvidia/z-ai/glm-5.3"),
    ];
    const router = new OpenLlmRouter(
      () => 1_000,
      memoryStore(),
      memoryQuotaStore()
    );

    expect(
      router.failed(registry, "401 Unauthorized", {
        provider: "mistral",
        id: "devstral-latest",
      })
    ).toEqual({ nextId: "nvidia/z-ai/glm-5.3" });
  });

  it("skips a model whose free minute is spent, before its provider refuses it", () => {
    pool.models = [
      choice("cerebras/gpt-oss-120b"),
      choice("cerebras/qwen-3.8-27b"),
    ];
    let now = Date.UTC(2026, 9, 1, 12, 0, 0);
    const router = new OpenLlmRouter(
      () => now,
      memoryStore(),
      memoryQuotaStore()
    );

    // Cerebras's trial allows five calls a minute per model.
    for (let call = 0; call < 5; call++)
      router.recordReply(reply("cerebras", "gpt-oss-120b"));
    expect(router.pick(registry)?.id).toBe("cerebras/qwen-3.8-27b");

    now += 60_000;
    expect(router.pick(registry)?.id).toBe("cerebras/gpt-oss-120b");
  });

  it("counts an account-wide limit across every model on the key", () => {
    pool.models = [
      choice("nvidia/z-ai/glm-5.3"),
      choice("nvidia/moonshotai/kimi-k2.6"),
      choice("openrouter/big:free"),
    ];
    const router = new OpenLlmRouter(
      () => Date.UTC(2026, 9, 1, 12, 0, 0),
      memoryStore(),
      memoryQuotaStore()
    );

    for (let call = 0; call < 20; call++) {
      router.recordReply(reply("nvidia", "z-ai/glm-5.3"));
      router.recordReply(reply("nvidia", "moonshotai/kimi-k2.6"));
    }
    expect(router.pick(registry)?.id).toBe("openrouter/big:free");
  });

  it("moves on when a model writes its tool call as text", () => {
    pool.models = [
      choice("groq/openai/gpt-oss-120b"),
      choice("groq/qwen/qwen3.8-27b"),
    ];
    const router = new OpenLlmRouter(
      () => 1_000,
      memoryStore(),
      memoryQuotaStore()
    );

    expect(
      router.failed(registry, "model wrote its tool call as text", {
        provider: "groq",
        id: "openai/gpt-oss-120b",
      })
    ).toEqual({ nextId: "groq/qwen/qwen3.8-27b" });
  });
});
