/**
 * A2A: the main bot can manage named workers, delegate work into their
 * persistent Abacus chats, inspect results, and convene a bounded meeting.
 * Workers stay on Abacus's real bot/model/tool stack; only task handles live
 * in the coordinator's small in-memory registry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

type FakeBot = {
  id: string;
  name: string;
  title: string;
  description: string;
  persona: string;
  avatarColor: string;
  avatarShape: string;
  workspaceId: string;
  sessionId: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
};

let home: string;
let logDir: string;
let bots: FakeBot[];
let logs: Record<string, string>;
let created = 0;
const previousHome = process.env.ABACUSAI_BOT_HOME;

const makeBot = (
  id: string,
  name: string,
  sessionId: string | null = null
): FakeBot => ({
  id,
  name,
  title: name,
  description: "Mission for " + name,
  persona: "Be a careful specialist.",
  avatarColor: "#7c3aed",
  avatarShape: "pebble",
  workspaceId: "workspace-1",
  sessionId,
  model: "provider/test-model",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const logFor = (sessionId: string): string => {
  const file = path.join(logDir, sessionId + ".jsonl");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  logs[sessionId] = file;
  return file;
};

const appendMessage = (file: string, role: string, text: string): void => {
  fs.appendFileSync(
    file,
    JSON.stringify({
      message: { role, content: [{ type: "text", text }] },
    }) + "\n"
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-a2a-home-"));
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-a2a-logs-"));
  process.env.ABACUSAI_BOT_HOME = home;
  created = 0;
  bots = [
    makeBot("conductor", "TORVIS Conductor", "conductor-session"),
    makeBot("research", "Research Scout"),
    makeBot("critic", "Critical Reviewer"),
  ];
  logs = {};
  logFor("conductor-session");
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
});

const build = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["a2a"]),
    workspacePath: () => null,
    workspaceId: () => "workspace-1",
    botIdForSession: (sessionId: string) =>
      sessionId === "conductor-session" ? "conductor" : null,
    ownActivity: (botId: string) => {
      const bot = bots.find((item) => item.id === botId);
      if (bot?.sessionId == null) return [];
      return [
        {
          sessionId: bot.sessionId,
          label: bot.name,
          role: "forever" as const,
          file: logFor(bot.sessionId),
        },
      ];
    },
    agentTeam: {
      listBots: () => bots as never,
      createBot: (input: {
        name: string;
        description: string;
        title?: string;
        persona?: string;
        model?: string | null;
      }) => {
        const id = "created-" + ++created;
        const bot = makeBot(id, input.name);
        bot.description = input.description;
        bot.title = input.title ?? input.name;
        bot.persona = input.persona ?? "";
        bot.model = input.model ?? null;
        bots.push(bot);
        return bot as never;
      },
      updateBot: (id: string, changes: Record<string, unknown>) => {
        const bot = bots.find((item) => item.id === id);
        if (bot == null) throw new Error("Unknown bot " + id);
        if (typeof changes.name === "string") bot.name = changes.name;
        if (typeof changes.title === "string") bot.title = changes.title;
        if (typeof changes.description === "string")
          bot.description = changes.description;
        if (typeof changes.persona === "string") bot.persona = changes.persona;
        if (typeof changes.model === "string" || changes.model === null)
          bot.model = changes.model as string | null;
        bot.updatedAt = Date.now();
        return bot as never;
      },
      deleteBot: (id: string) => {
        bots = bots.filter((bot) => bot.id !== id);
      },
      announceBotChange: async () => {},
      openBotChat: async (botId: string) => {
        const bot = bots.find((item) => item.id === botId);
        if (bot == null) throw new Error("Unknown bot " + botId);
        bot.sessionId ??= botId + "-session";
        logFor(bot.sessionId);
        return {
          botId,
          workspaceId: "workspace-1",
          sessionId: bot.sessionId,
        };
      },
      sendAgentMessage: async (request: {
        sessionId: string;
        message: string;
      }) => {
        const file = logFor(request.sessionId);
        appendMessage(file, "user", request.message);
        appendMessage(
          file,
          "assistant",
          "Completed assigned work for " + request.sessionId
        );
        return true;
      },
      listSessions: () =>
        bots
          .filter((bot) => bot.sessionId != null)
          .map((bot) => ({
            id: bot.sessionId,
            workspaceId: "workspace-1",
            label: bot.name,
            status: "running",
            owner: {
              kind: "bot",
              botId: bot.id,
              role: "forever",
              key: null,
            },
          })) as never,
      getTurnState: (workspaceId: string, sessionId: string) =>
        ({
          workspaceId,
          sessionId,
          phase: "idle",
          isBusy: false,
          updatedAt: new Date().toISOString(),
        }) as never,
    },
  } as never);

const call = async (
  server: McpAgentToolsServer,
  args: Record<string, unknown>,
  session = "conductor-session"
): Promise<string> => {
  const result = await (
    server as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
    }
  ).executeTool("a2a", args, session);
  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("A2A bot team", () => {
  it("refuses to manage the team from a plain session", async () => {
    const text = await call(
      build(),
      { action: "list_agents" },
      "ordinary-session"
    );
    expect(text).toMatch(/only available in a bot|only bots can call/i);
  });

  it("lists agents without exposing their session IDs", async () => {
    const text = await call(build(), { action: "list_agents" });
    expect(text).toContain("Research Scout");
    expect(text).toContain("Critical Reviewer");
    expect(text).not.toContain("research-session");
  });

  it("creates and updates an agent name, mission, and persona", async () => {
    const server = build();
    const createdText = await call(server, {
      action: "create_agent",
      name: "Code Auditor",
      mission: "Review code for correctness and security.",
      persona: "Precise, skeptical, evidence-led.",
      model: "provider/test-model",
    });
    const createdResult = JSON.parse(createdText) as {
      created: { id: string };
    };
    expect(createdResult.created.id).toBe("created-1");
    expect(createdText).toContain("Review code for correctness and security.");

    const updatedText = await call(server, {
      action: "update_agent",
      agent_id: "created-1",
      mission: "Review TypeScript and security changes.",
    });
    expect(updatedText).toContain("Review TypeScript and security changes.");
  });

  it("requires an exact name before deleting an agent", async () => {
    const server = build();
    const refused = await call(server, {
      action: "delete_agent",
      agent_id: "research",
      confirm_name: "almost the right name",
    });
    expect(refused).toContain("confirm_name must exactly match");
    expect(bots.some((bot) => bot.id === "research")).toBe(true);

    const deleted = await call(server, {
      action: "delete_agent",
      agent_id: "research",
      confirm_name: "Research Scout",
    });
    expect(deleted).toContain("Deleted agent Research Scout");
    expect(bots.some((bot) => bot.id === "research")).toBe(false);
  });

  it("delegates work into a worker chat and reads back its result", async () => {
    const server = build();
    const submitted = JSON.parse(
      await call(server, {
        action: "delegate_task",
        agent_id: "research",
        task: "Investigate the current API routing implementation.",
      })
    ) as { accepted: boolean; task_id: string; state: string };

    expect(submitted.accepted).toBe(true);
    expect(submitted.state).toBe("queued");

    const statusText = await call(server, {
      action: "task_status",
      task_id: submitted.task_id,
    });
    expect(statusText).toContain('"state": "completed"');
    expect(statusText).toContain(
      "Completed assigned work for research-session"
    );
  });

  it("keeps a task result scoped to its own transcript turn", async () => {
    const server = build();
    const submitted = JSON.parse(
      await call(server, {
        action: "delegate_task",
        agent_id: "research",
        task: "Summarize the relevant API changes.",
      })
    ) as { task_id: string };

    const file = logs["research-session"]!;
    appendMessage(file, "user", "A separate request after the delegated task.");
    appendMessage(file, "assistant", "An unrelated later assistant answer.");

    const status = JSON.parse(
      await call(server, {
        action: "task_status",
        task_id: submitted.task_id,
      })
    ) as { state: string; output?: string };
    expect(status.state).toBe("completed");
    expect(status.output).toBe(
      "Completed assigned work for research-session"
    );
    expect(status.output).not.toContain("unrelated later");
  });

  it("refuses a second dispatch while the same worker is being assigned", async () => {
    const server = build();
    const internal = server as unknown as {
      a2aDispatchingBots: Set<string>;
    };
    internal.a2aDispatchingBots.add("research");

    const result = await call(server, {
      action: "delegate_task",
      agent_id: "research",
      task: "A second assignment must not interleave.",
    });
    expect(result).toMatch(/already receiving a task/i);
  });

  it("convenes a parallel meeting and supports a follow-up round", async () => {
    const server = build();
    const createdMeeting = JSON.parse(
      await call(server, {
        action: "convene",
        topic: "Review the API design",
        instructions: "Assess correctness, risk, and maintainability.",
        agent_ids: ["research", "critic"],
      })
    ) as {
      meeting_id: string;
      participants: Array<{ agent: { id: string }; state: string }>;
    };

    expect(createdMeeting.meeting_id).toBeTruthy();
    expect(createdMeeting.participants).toHaveLength(2);
    expect(
      createdMeeting.participants.every((item) => item.state === "completed")
    ).toBe(true);

    const followup = await call(server, {
      action: "follow_up",
      meeting_id: createdMeeting.meeting_id,
      instructions:
        "Reconcile disagreements and give one final recommendation.",
      shared_context: "Compare evidence, do not invent facts.",
      agent_ids: ["research"],
    });
    expect(followup).toContain("Completed assigned work for research-session");
    expect(fs.readFileSync(logs["research-session"]!, "utf8")).toContain(
      "Reconcile disagreements"
    );

    const status = await call(server, {
      action: "meeting_status",
      meeting_id: createdMeeting.meeting_id,
    });
    expect(status).toContain("Review the API design");
    expect(status).toContain("Critical Reviewer");
  });

  it("limits a meeting to eight distinct workers", async () => {
    const text = await call(build(), {
      action: "convene",
      topic: "Large meeting",
      instructions: "Discuss",
      agent_ids: [
        "research",
        "research",
        "missing",
        "critic",
        "conductor",
        "x",
        "y",
        "z",
        "q",
        "p",
      ],
    });
    expect(text).toContain("Choose between 1 and 8 distinct agent ids");
  });
});
