import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(bots)/bots/")({
  beforeLoad: async ({ context }) => {
    await context.db.collections.bots.preload();
    const torvisBot = context.db.collections.bots.toArray.find((bot) => {
      const normalized = bot.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normalized === "torvis" || normalized === "torvisconductor";
    });
    throw redirect({
      to: torvisBot ? (`/bots/${torvisBot.id}` as never) : "/bots/new",
      search: true,
      state: true,
      replace: true,
    });
  },
});
