import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

let harness: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(async () => {
  harness?.view.unmount();
  await harness?.cleanup();
  harness = undefined;
});

const seedWithTorvis = () => {
  const seed = defaultSeed();
  const existing = seed.bots[0]!;
  seed.bots = [
    ...seed.bots,
    {
      ...existing,
      id: "torvis-test-id",
      name: "T.O.R.V.I.S.",
      title: "Primary conductor",
    },
  ];
  return seed;
};

it("opens the existing TORVIS conductor when entering the Bots area", async () => {
  harness = await renderApp("/bots", { seed: seedWithTorvis() });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/bots/torvis-test-id")
  );
});

it("keeps normal bot setup available when no TORVIS conductor exists", async () => {
  harness = await renderApp("/bots", { seed: defaultSeed() });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/bots/new")
  );
});
