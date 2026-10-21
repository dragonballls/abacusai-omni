import { waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  clearDraft,
  getDraft,
} from "#renderer/features/bots/form/draft-store";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

let harness: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(async () => {
  harness?.view.unmount();
  await harness?.cleanup();
  harness = undefined;
  clearDraft();
});

const seedWithTorvis = () => {
  const seed = defaultSeed();
  const bots = seed.bots ?? [];
  const existing = bots[0]!;
  seed.bots = [
    ...bots,
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

it("starts a fresh install directly in TORVIS conductor setup", async () => {
  harness = await renderApp("/bots", { seed: defaultSeed() });
  await waitFor(() =>
    expect(harness!.router.state.location.pathname).toBe("/bots/new")
  );
  expect(harness!.router.state.location.search).toMatchObject({
    step: "setup",
  });
  expect(getDraft().values.name).toBe("T.O.R.V.I.S.");
  expect(getDraft().values.instructions).toContain(
    "primary conductor for the user's Abacus agent network"
  );
});
