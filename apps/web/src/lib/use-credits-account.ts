import { useEffect, useEffectEvent, useState } from "react";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { creditMarkState } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Share counters and deduplicate refreshes without caching an exhaustion marker. */
export const useCreditsAccount = () => {
  const { transport } = useAppContext();
  // A desktop account endpoint is optional. Query settings directly rather
  // than trusting a cached query that can still contain a removed Abacus key.
  const hasSettingsReader =
    typeof transport.client.settings?.get === "function";
  const [desktopAccountAllowed, setDesktopAccountAllowed] =
    useState(!IS_ELECTRON);
  const readSettings = useEffectEvent(() => transport.client.settings.get({}));
  useEffect(() => {
    if (!IS_ELECTRON || !hasSettingsReader) return;
    let active = true;
    void readSettings()
      .then((settings) => {
        if (active)
          setDesktopAccountAllowed(Boolean(settings?.apiKeys?.ABACUS_API_KEY));
      })
      .catch(() => {
        if (active) setDesktopAccountAllowed(false);
      });
    return () => {
      active = false;
    };
  }, [hasSettingsReader]);
  const canQueryAccount =
    !IS_ELECTRON || (hasSettingsReader && desktopAccountAllowed);
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const account = useAccount({ enabled: canQueryAccount });
  const clearFreshMark = useEffectEvent(
    (mark: number, data: typeof account.data) => {
      if (
        prefs.creditsExhaustedAt === mark &&
        creditMarkState(data, mark, Date.now(), true) === "clear"
      )
        void update({ creditsExhaustedAt: null }).catch(() => undefined);
    }
  );
  const { refetch } = account;
  useEffect(() => {
    const mark = prefs.creditsExhaustedAt;
    if (mark === null || !canQueryAccount) return;
    let active = true;
    void refetch({ cancelRefetch: false }).then((result) => {
      if (active && !result.isError) clearFreshMark(mark, result.data);
    });
    return () => {
      active = false;
    };
  }, [prefs.creditsExhaustedAt, refetch, canQueryAccount]);
  return account;
};
