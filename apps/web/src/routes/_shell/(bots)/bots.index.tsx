import { createFileRoute, redirect } from "@tanstack/react-router";

import { selectTorvisConductor } from "#renderer/features/bots/form/draft-store";

export const Route = createFileRoute("/_shell/(bots)/bots/")({
  beforeLoad: async ({ context }) => {
    await context.db.collections.bots.preload();
    const torvisBot = context.db.collections.bots.toArray.find((bot) => {
      const normalized = bot.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normalized === "torvis" || normalized === "torvisconductor";
    });
    if (torvisBot != null) {
      throw redirect({
        to: `/bots/${torvisBot.id}` as never,
        search: true,
        state: true,
        replace: true,
      });
    }

    // TORVIS is the default control room on a fresh install. This is still
    // Abacus's ordinary bot-creation flow, prefilled with the conductor brief.
    selectTorvisConductor();
    throw redirect({
      to: "/bots/new",
      search: (previous) => ({
        step: "setup",
        ...(previous.connect === "whatsapp"
          ? { connect: "whatsapp" as const }
          : {}),
      }),
      state: true,
      replace: true,
    });
  },
});
