import { useSelector } from "@tanstack/react-store";

import { defaultLook, resolveLook } from "#renderer/lib/bots/avatar";
import { DEFAULT_CHECK_IN } from "#renderer/lib/bots/check-in";
import { BOT_TEMPLATES } from "#renderer/lib/bots/templates";
import { persistedStore } from "#renderer/lib/continuity/registry";

import { newBotId } from "../data/bot-actions";
import type { BotFormValues } from "./schema";
export interface BotDraft {
  id: string;
  templateId: string | null;
  lookPicked?: boolean;
  values: BotFormValues;
  stages: { bot: boolean; checkIn: "none" | "persisted" | "failed" };
}
const draftStore = persistedStore<BotDraft | null>(
  "abacusai-bot:renderer:bot-draft",
  () => null
);
const write = (draft: BotDraft | null): void =>
  draftStore.setState(() => draft);
export const getDraft = (): BotDraft => {
  if (draftStore.state) return draftStore.state;
  const draft: BotDraft = {
    id: newBotId(),
    templateId: null,
    lookPicked: false,
    stages: { bot: false, checkIn: "none" },
    values: {
      name: "",
      persona: "",
      instructions: "",
      description: "",
      look: defaultLook(""),
      model: null,
      checkIn: { ...DEFAULT_CHECK_IN },
    },
  };
  write(draft);
  return draft;
};
export const useBotDraft = (): BotDraft => {
  getDraft();
  return useSelector(draftStore, (state) => state!);
};
export const updateDraft = (patch: Partial<BotDraft>): void =>
  write({ ...getDraft(), ...patch });
export const clearDraft = (): void => write(null);
/**
 * Start a fresh, prefilled T.O.R.V.I.S. conductor bot. This uses the normal
 * bot creation flow, so model, workspace, permissions, and persistent chat
 * remain Abacus-owned and user-editable.
 */
export const selectTorvisConductor = (): void => {
  clearDraft();
  const name = "T.O.R.V.I.S.";
  updateDraft({
    lookPicked: true,
    values: {
      ...getDraft().values,
      name,
      persona:
        "Calm, strategic, concise, technically precise, and transparent about uncertainty.",
      description: "Primary conductor for the Abacus agent network",
      instructions: [
        "You are T.O.R.V.I.S., the primary conductor for the user's Abacus agent network.",
        "Keep this conversation as the main user-facing command center. Treat Abacus bots as persistent specialist workers; do not create a parallel bot database.",
        "",
        "For multi-agent work, use the a2a capability when available:",
        "- List existing agents before creating a new one, and reuse suitable specialists.",
        "- Create, name, and instruct a worker with a clear, bounded mission when needed.",
        "- Delegate independent tasks, then check each task by its task ID and report actual results in this conversation.",
        "- Convene up to eight distinct workers for a meeting when independent perspectives help; compare evidence, identify disagreements, and run follow-up rounds with shared context.",
        "- Keep a concise status ledger: requested task, assigned workers, task/meeting IDs, completed results, blockers, and next action.",
        "",
        "If the a2a tool is unavailable, explain that the user must enable the A2A capability in Library > Tools. Never pretend to have dispatched agents or held a meeting.",
        "Workers keep their existing Abacus models, saved provider settings, tools, connectors, and permissions. Do not bypass account controls, provider subscriptions or quotas, licensing, tool permissions, or user confirmations.",
        "Never claim a delegated task is complete until its returned result confirms completion. Ask for confirmation before consequential actions, and never delete a worker without the exact-name confirmation required by the tool.",
        "When asked to switch to Abacus, help the user work with the standard bots and settings directly; when asked to switch back, return to this conductor role.",
      ].join("\n"),
      look: defaultLook(name),
    },
  });
};

export const selectTemplate = (
  templateId: string,
  translatedName: string
): void => {
  const template = BOT_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return;
  updateDraft({
    templateId,
    lookPicked: true,
    values: {
      ...getDraft().values,
      name: translatedName,
      persona: template.persona,
      instructions: template.mission,
      description: template.title,
      look: resolveLook({
        name: translatedName,
        avatarShape: template.avatarShape,
        avatarColor: template.avatarColor,
      }),
    },
  });
};

interface EditDraft {
  values: BotFormValues;
  baseline: BotFormValues;
}
export const editDraftStore = persistedStore<Record<string, EditDraft>>(
  "abacusai-bot:abacus.bots.edits",
  () => ({})
);
export const clearEditDraft = (id: string) =>
  editDraftStore.setState((state) => {
    const { [id]: _removed, ...rest } = state;
    return rest;
  });

export const subscribeDraft = (
  listener: (draft: BotDraft | null) => void
): (() => void) => {
  const subscription = draftStore.subscribe((draft) => listener(draft));
  return () => subscription.unsubscribe();
};
