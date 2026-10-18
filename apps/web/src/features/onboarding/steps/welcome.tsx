import { Brain, Puzzle, Sparkles } from "lucide-react";
import type { Ref } from "react";

import { Spinner } from "#renderer/components/spinner";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { websiteSignInStarted } from "../first-run";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

export interface BrowserProfile {
  id: string;
  browserName: string;
  profileName: string;
  isDefault?: boolean;
  hasAbacusSession?: boolean | null;
}

export const WelcomeStep = ({
  ctx,
  heading,
}: {
  ctx: StepContext;
  profiles?: readonly BrowserProfile[];
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, advance } = ctx;
  if (!IS_ELECTRON)
    return (
      <>
        <StepTitle ref={heading}>
          {t("onboarding.pages.connect.title")}
        </StepTitle>
        <StepBody className="mt-2">{t("onboarding.webSignIn.body")}</StepBody>
        {websiteSignInStarted() ? (
          <div className="mt-7">
            <StepButton disabled={busy} onClick={() => props.signIn("signin")}>
              {t("onboarding.pages.retry")}
            </StepButton>
          </div>
        ) : (
          <div
            role="status"
            className="onboarding-card mt-7 flex h-[52px] items-center gap-2.5 rounded-[14px] pr-[18px] pl-3.5"
          >
            <Spinner className="text-primary size-[18px]" aria-hidden />
            <span className="font-medium">
              {t("onboarding.webSignIn.waiting")}
            </span>
          </div>
        )}
      </>
    );
  return (
    <>
      <StepTitle ref={heading} size="hero">
        {t("onboarding.welcomeTitle")}
      </StepTitle>
      <p className="onboarding-tagline mt-2">
        {t("onboarding.welcomeTagline")}
      </p>
      <ul className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-3">
        {[
          { key: "welcomeCapabilityMemory", icon: Brain },
          { key: "welcomeCapabilityConnectors", icon: Puzzle },
          { key: "welcomeCapabilityModels", icon: Sparkles },
        ].map(({ key, icon: Icon }) => (
          <li key={key} className="flex items-center gap-2 text-sm font-medium">
            <Icon
              aria-hidden
              className="text-primary size-5"
              strokeWidth={1.75}
            />
            {t(`onboarding.${key}`)}
          </li>
        ))}
      </ul>
      <div className="onboarding-actions mt-9">
        <StepButton disabled={busy} onClick={advance}>
          {t("onboarding.setupDoneCta")}
        </StepButton>
      </div>
    </>
  );
};
