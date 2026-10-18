import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { creditMarkState } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Share counters and deduplicate refreshes without caching an exhaustion marker. */
export const useCreditsAccount = () => {
  const { transport } = useAppContext();
  // Some isolated component tests intentionally omit the settings RPC. Keep
  // those contexts usable, but don't treat cached settings as authoritative for
  // a desktop BYOK decision until this mount has received a fresh result.
  const settingsOptions = transport.orpc.settings?.get?.queryOptions?.({
    input: {},
  });
  const hasSettingsQuery = Boolean(settingsOptions);
  const settings = useQuery({
    ...(settingsOptions ?? {
      queryKey: ["credits-account-settings-unavailable"] as const,
      queryFn: async () => undefined,
    }),
    enabled: false,
    staleTime: 0,
  });
  // Require the result of a settings request started by this hook. Cached
  // settings can still contain an Abacus key that has since been removed.
  const [verifiedSettingsAt, setVerifiedSettingsAt] = useState<number | null>(
    null
  );
  const { refetch: refetchSettings } = settings;
  useEffect(() => {
    if (!IS_ELECTRON || !hasSettingsQuery) return;
    let active = true;
    void refetchSettings({ cancelRefetch: false })
      .then((result) => {
        if (active)
          setVerifiedSettingsAt(!result.isError ? result.dataUpdatedAt : null);
      })
      .catch(() => {
        if (active) setVerifiedSettingsAt(null);
      });
    return () => {
      active = false;
    };
  }, [hasSettingsQuery, refetchSettings]);
  const canQueryAccount =
    !IS_ELECTRON ||
    !hasSettingsQuery ||
    (verifiedSettingsAt !== null &&
      settings.dataUpdatedAt >= verifiedSettingsAt &&
      Boolean(settings.data?.apiKeys?.ABACUS_API_KEY));
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
