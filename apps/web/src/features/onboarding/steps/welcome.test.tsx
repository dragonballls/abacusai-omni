import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";

import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { WelcomeStep } from "./welcome";

it("lets desktop users proceed to provider setup without an Abacus sign-in", async () => {
  await initI18n();
  const advance = vi.fn();
  const signIn = vi.fn();
  const ctx = {
    t: fixedT(),
    busy: false,
    advance,
    props: { signIn },
  } as unknown as StepContext;

  render(<WelcomeStep ctx={ctx} profiles={[]} heading={createRef()} />);

  expect(screen.queryByRole("button", { name: "Sign up for free" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "I already have an account" })
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(advance).toHaveBeenCalledOnce();
  expect(signIn).not.toHaveBeenCalled();
});
