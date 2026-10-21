import type { ToolDefinition } from "./definition";

/**
 * What a bot knows about its own other conversations.
 */
export const BOTS_TOOLS: ToolDefinition[] = [
  {
    name: "my_activity",
    toolsets: "always",
    botAlways: true,
    description: [
      "Your own recent activity, across YOUR other conversations: your main",
      "chat with the user, your auto-reply chats, and your routine runs.",
      'Call it when the user asks what you have done, or when "so far"',
      "plainly reaches beyond this conversation. This chat's context does",
      "not follow you between conversations, but your work does.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
    run: (host, args, callerSession) => host.myActivity(callerSession),
  },
  {
    name: "a2a",
    toolsets: ["a2a"],
    botsOnly: true,
    description: [
      "Manage the user's Abacus bot team as the coordinating agent.",
      "Actions: list_agents; create_agent (name, mission, optional title, persona, model);",
      "update_agent (agent_id and changed fields); delete_agent (agent_id plus exact confirm_name);",
      "delegate_task (agent_id, task) then task_status (task_id);",
      "convene (topic, instructions, agent_ids: up to eight bots); meeting_status (meeting_id);",
      "follow_up (meeting_id, instructions, optional agent_ids and shared_context).",
      "Each worker uses its own saved model, integrations, tools, and Abacus permissions.",
      "Tasks are delivered to each worker's persistent bot chat. Poll task_status or meeting_status",
      "for results; follow_up sends new work with the shared meeting findings.",
      "Create and update agents with explicit names and mission instructions. Deletion requires",
      "the exact current name and must never be used merely to stop a task.",
      "This tool is available only inside a persistent bot chat, not a regular session or unattended routine.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list_agents",
            "create_agent",
            "update_agent",
            "delete_agent",
            "delegate_task",
            "task_status",
            "convene",
            "meeting_status",
            "follow_up",
          ],
        },
        agent_id: { type: "string" },
        agent_ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
        },
        name: { type: "string" },
        title: { type: "string" },
        mission: { type: "string" },
        persona: { type: "string" },
        model: { type: ["string", "null"] },
        confirm_name: { type: "string" },
        task: { type: "string" },
        task_id: { type: "string" },
        topic: { type: "string" },
        instructions: { type: "string" },
        meeting_id: { type: "string" },
        shared_context: { type: "string" },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.a2a(args, callerSession),
  },
];
