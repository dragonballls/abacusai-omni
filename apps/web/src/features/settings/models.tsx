import { localModelReference } from "@abacus-ai/contract/local-models";
import {
  PROVIDER_KEY_FIELDS,
  isPlausibleApiKey,
  type ProviderKeyField,
  OMNIROUTE_PROVIDER_IDS,
  type OmniRouteProvider,
} from "@abacus-ai/contract/settings";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { signInAbacus } from "#platform/sign-in";
import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { followNotices } from "#renderer/data/queries/notices";
import { useMutation } from "#renderer/data/query-client";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#renderer/ui/dialog";
import { Field, FieldLabel, FieldError } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import { creditMarkState } from "./credits";
export const ModelsPage = ({
  adoptModel,
}: {
  adoptModel?: (target: string, model: string) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const search = useSearch({ strict: false }) as {
    provider?: string;
    for?: string;
  };
  const keys = useQuery(
    transport.orpc.settings.keys.listProviders.queryOptions({ input: {} })
  );
  const account = useCreditsAccount();
  const state = useQuery(
    transport.orpc.localModels.state.queryOptions({
      input: {},
      enabled: IS_ELECTRON,
    })
  );
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [omniRouteOpen, setOmniRouteOpen] = useState(false);
  const now = useNow();
  const mark = creditMarkState(
    account.data,
    prefs.creditsExhaustedAt,
    now,
    false
  );
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.localModels.progress({}, { signal }),
      (progress) => {
        cache.setQueryData(
          transport.orpc.localModels.state.queryKey({ input: {} }),
          (old) => (old ? { ...old, download: progress } : old)
        );
        if (["ready", "failed", "cancelled"].includes(progress.phase)) {
          void cache.invalidateQueries({
            queryKey: transport.orpc.localModels.state.queryKey({ input: {} }),
          });
          void cache.invalidateQueries({
            queryKey: transport.orpc.models.list.queryKey(),
          });
        }
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, cache]);
  useEffect(() => {
    if (search.provider === "local") {
      const el = document.querySelector<HTMLElement>(
        '[data-setting-id="localModels"]'
      );
      el?.scrollIntoView({ block: "center" });
      el?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [search.provider, state.data?.runtimeAvailable]);
  const adopt = async (id: string) => {
    if (search.for && adoptModel)
      await adoptModel(search.for, localModelReference(id));
  };
  const stateKey = transport.orpc.localModels.state.queryKey({ input: {} });
  // The `for` target the page adopts for now. An install answers once the
  // download ends; one started for another target adopts nothing.
  const target = useRef(search.for);
  useEffect(() => {
    target.current = search.for;
  }, [search.for]);
  const install = useMutation({
    ...transport.orpc.localModels.install.mutationOptions(),
    onMutate: () => {
      setError(null);
      return { target: target.current };
    },
    // Awaited by the mutation: it stays pending through the refetches
    // and the adoption, and a failed adoption is its error.
    onSuccess: async (result, { modelId }, started) => {
      const current = started.target === target.current;
      if (!result.ok) {
        if (current && result.error !== "cancelled") setError(result.error);
        return;
      }
      await cache.invalidateQueries({ queryKey: stateKey });
      await cache.invalidateQueries({
        queryKey: transport.orpc.models.list.queryKey(),
      });
      if (current && started.target === target.current) await adopt(modelId);
    },
    onError: (e) => setError(errorText(e)),
  });
  const removeModel = useMutation(
    transport.orpc.localModels.remove.mutationOptions({
      meta: { invalidates: [stateKey] },
    })
  );
  const fields = PROVIDER_KEY_FIELDS.filter((p) => p.kind === "model").toSorted(
    (a, b) => Number(!!b.featured) - Number(!!a.featured)
  );
  const row = (field: ProviderKeyField) => (
    <SettingRow
      id={`provider-${field.provider}`}
      key={field.provider}
      media={
        <ConnectorMark
          id={markForProvider(field.provider) ?? field.provider}
          size={28}
        />
      }
      title={field.label}
      detail={
        keys.data?.includes(field.provider)
          ? t("phase5.savedUnverified")
          : field.envVar
      }
    >
      <StatePill>
        {t(
          keys.data?.includes(field.provider)
            ? "phase5.saved"
            : "phase5.notConnected"
        )}
      </StatePill>
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void navigate({
            to: "/settings/models",
            search: (old) => ({ ...old, provider: field.provider }),
            transition: "none",
          })
        }
      >
        {t(
          keys.data?.includes(field.provider)
            ? "phase5.manage"
            : field.connect && IS_ELECTRON
              ? "phase5.connect"
              : "phase5.addKey"
        )}
      </Button>
    </SettingRow>
  );
  return (
    <>
      <AreaPage
        title={t("settings.pages.models")}
        description={t("phase5.settings.modelsDetail")}
      >
        {IS_ELECTRON && (
          <GroupCard title="OmniRoute · multi-provider routing">
            <p className="p-3 text-sm">
              Add provider API keys to OmniRoute, then route new chats through its
              automatic model selector. Keys are passed to OmniRoute over stdin
              and are not stored in Abacus Bot settings.
            </p>
            <div className="px-3 pb-3">
              <Button onClick={() => setOmniRouteOpen(true)}>
                Open OmniRoute window
              </Button>
            </div>
          </GroupCard>
        )}
        {mark === "show" && (
          <GroupCard title={t("phase5.creditsExhausted")}>
            <p className="p-3 text-sm">{t("phase5.creditsAlternatives")}</p>
            <div className="flex gap-2 p-3">
              <Button
                onClick={() =>
                  void navigate({
                    to: "/settings/models",
                    search: (old) => ({ ...old, provider: "openrouter" }),
                    transition: "none",
                  })
                }
              >
                {t("phase5.connectFree")}
              </Button>
              {IS_ELECTRON && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void navigate({
                      to: "/settings/models",
                      search: (old) => ({ ...old, provider: "local" }),
                      transition: "none",
                    })
                  }
                >
                  {t("phase5.useLocal")}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => void update({ creditsExhaustedAt: null })}
              >
                {t("phase5.dismiss")}
              </Button>
            </div>
          </GroupCard>
        )}
        <GroupCard title={t("phase5.providers")}>
          {fields.filter((p) => p.featured).map(row)}
        </GroupCard>
        <details>
          <summary>{t("phase5.otherProviders")}</summary>
          <Input
            aria-label={t("phase5.searchProviders")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <GroupCard>
            {fields
              .filter(
                (p) =>
                  !p.featured &&
                  [p.label, p.envVar, p.hint, p.provider]
                    .join(" ")
                    .toLowerCase()
                    .includes(q.toLowerCase())
              )
              .map(row)}
          </GroupCard>
        </details>
        {IS_ELECTRON && state.data?.runtimeAvailable && (
          <section data-setting-id="localModels">
            <GroupCard title={t("phase5.onThisMachine")}>
              <p className="p-3 text-xs">
                {t("phase5.memoryAvailable", {
                  memory: Math.round(state.data.totalMemoryBytes / 1024 ** 3),
                })}
              </p>
              {state.data.catalog.map((model) => {
                const installed = state.data!.installedIds.includes(model.id);
                const progress =
                  state.data!.download?.modelId === model.id
                    ? state.data!.download
                    : null;
                const downloading =
                  progress?.phase === "downloading" ||
                  progress?.phase === "verifying";
                return (
                  <SettingRow
                    id={`local-${model.id}`}
                    key={model.id}
                    title={model.label}
                    detail={[
                      model.id === state.data!.recommendedId
                        ? t("phase5.recommended")
                        : "",
                      `${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB`,
                      model.minMemoryBytes > state.data!.totalMemoryBytes
                        ? t("phase5.tightMemory")
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {installed ? (
                      <>
                        <StatePill>{t("phase5.installed")}</StatePill>
                        {search.for && (
                          <Button
                            disabled={!adoptModel}
                            size="sm"
                            onClick={() =>
                              void adopt(model.id).catch((e) =>
                                setError(errorText(e))
                              )
                            }
                          >
                            {t("phase5.useModel", { model: model.label })}
                          </Button>
                        )}
                        <ConfirmAction
                          title={t("phase5.removeModel", {
                            model: model.label,
                          })}
                          description={t("phase5.downloadAgain")}
                          label={t("phase5.remove")}
                          onConfirm={() =>
                            removeModel.mutateAsync({ modelId: model.id })
                          }
                        />
                      </>
                    ) : downloading ? (
                      <>
                        <span role="status" className="text-xs">
                          {progress.phase === "verifying"
                            ? t("phase5.verifying")
                            : `${Math.round((progress.receivedBytes / Math.max(1, progress.totalBytes)) * 100)}%`}
                        </span>
                        <Button
                          size="sm"
                          onClick={() =>
                            void transport.client.localModels.cancelInstall({})
                          }
                        >
                          {t("phase5.stop")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={
                          install.isPending ||
                          ["downloading", "verifying"].includes(
                            state.data!.download?.phase ?? ""
                          )
                        }
                        onClick={() => install.mutate({ modelId: model.id })}
                      >
                        {t(
                          search.for ? "phase5.installUse" : "phase5.download"
                        )}
                      </Button>
                    )}
                  </SettingRow>
                );
              })}
            </GroupCard>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
      </AreaPage>
      {IS_ELECTRON && omniRouteOpen && (
        <OmniRouteDialog onClose={() => setOmniRouteOpen(false)} />
      )}
      {search.provider &&
        search.provider !== "local" &&
        fields.find((f) => f.provider === search.provider) && (
          <ProviderDialog
            key={search.provider}
            field={fields.find((f) => f.provider === search.provider)!}
            stored={keys.data?.includes(search.provider) ?? false}
          />
        )}
    </>
  );
};
export const ProviderDialog = ({
  field,
  stored,
}: {
  field: ProviderKeyField;
  stored: boolean;
}) => {
  const { t } = useTranslation();
  const { transport, credentialsChanged } = useAppContext();
  const navigate = useAppNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const close = () =>
    void navigate({
      to: "/settings/models",
      search: (old) => ({ ...old, provider: undefined }),
      transition: "none",
    });
  const canConnect =
    field.connect && (IS_ELECTRON || field.connect === "abacus");
  const auth =
    field.connect === "abacus"
      ? transport.client.auth.abacus
      : transport.client.auth.openRouter;
  useEffect(
    () => () => {
      token.current++;
      if (IS_ELECTRON && field.connect) void auth.cancel({});
    },
    [auth, field.connect]
  );
  const refresh = async () => {
    await transport.client.models.list({ refresh: true });
    await credentialsChanged();
  };
  const saveKey = useMutation(
    transport.orpc.settings.keys.save.mutationOptions({
      onSuccess: async () => {
        await refresh();
        close();
      },
    })
  );
  const save = (key: string) =>
    saveKey.mutateAsync({ provider: field.provider, key });
  const schema = v.object({
    key: v.pipe(v.string(), v.trim(), v.check(isPlausibleApiKey, "api-key")),
  });
  const form = useAppForm({
    defaultValues: { key: "" },
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      try {
        await save(v.parse(schema, value).key);
      } catch (e) {
        setError(errorText(e));
      }
    },
  });
  const connect = async () => {
    if (!canConnect) return;
    const id = ++token.current;
    setPending(true);
    setError(null);
    try {
      const result = IS_ELECTRON
        ? await auth.start({})
        : await signInAbacus(transport, {});
      if (id !== token.current) return;
      if (result.ok) {
        await refresh();
        close();
      } else if (!result.cancelled) setError(result.error);
    } catch (e) {
      if (id === token.current) setError(errorText(e));
    }
    if (id === token.current) setPending(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t(canConnect ? "phase5.connectProvider" : "phase5.getKey", {
              provider: field.label,
            })}
          </DialogTitle>
          <DialogDescription>{t("phase5.storedHere")}</DialogDescription>
        </DialogHeader>
        {canConnect ? (
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => void connect()}>
              {t(pending ? "phase5.waitingSignIn" : "phase5.connect")}
            </Button>
            {pending && (
              <Button
                variant="secondary"
                onClick={() => {
                  token.current++;
                  setPending(false);
                  if (IS_ELECTRON) void auth.cancel({});
                }}
              >
                {t("phase5.cancel")}
              </Button>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
            className="space-y-3"
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void platformSystem(transport.client).openExternal({
                  url: field.signupUrl,
                })
              }
            >
              {t("phase5.openProvider", { provider: field.label })}
            </Button>
            <form.Field name="key">
              {(f) => (
                <Field>
                  <FieldLabel htmlFor="provider-key">
                    {t("phase5.apiKey")}
                  </FieldLabel>
                  <Input
                    autoFocus
                    id="provider-key"
                    type="password"
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value)}
                    onBlur={f.handleBlur}
                  />
                  {f.state.meta.errors.length > 0 && (
                    <FieldError>{t("phase5.invalidKey")}</FieldError>
                  )}
                </Field>
              )}
            </form.Field>
            <form.AppForm>
              <form.SubmitButton label={t("phase5.save")} />
            </form.AppForm>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          {stored && (
            <ConfirmAction
              title={t("phase5.removeKey", { provider: field.label })}
              description={t("phase5.removeKeyDetail")}
              label={t("phase5.remove")}
              onConfirm={() => save("")}
            />
          )}
          <Button variant="secondary" onClick={close}>
            {t("phase5.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};


const OMNI_ROUTE_LABELS: Record<OmniRouteProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  groq: "Groq",
  cerebras: "Cerebras",
  mistral: "Mistral",
  xai: "xAI",
  cohere: "Cohere",
};

export const OmniRouteDialog = ({ onClose }: { onClose: () => void }) => {
  const { transport, credentialsChanged } = useAppContext();
  const cache = useQueryClient();
  const [provider, setProvider] = useState<OmniRouteProvider>("gemini");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    setOffset({
      x: start.offsetX + event.clientX - start.pointerX,
      y: start.offsetY + event.clientY - start.pointerY,
    });
  };
  const onDragEnd = () => {
    dragStart.current = null;
  };
  const status = useQuery(
    transport.orpc.settings.omniRoute.status.queryOptions({ input: {} })
  );
  const statusKey = transport.orpc.settings.omniRoute.status.queryKey({ input: {} });
  const refreshModels = async () => {
    await cache.invalidateQueries({ queryKey: statusKey });
    await transport.client.models.list({ refresh: true });
    await credentialsChanged();
  };
  const start = useMutation(
    transport.orpc.settings.omniRoute.start.mutationOptions({
      onSuccess: async (result) => {
        setMessage(result.message || "OmniRoute is ready.");
        setError(null);
        await refreshModels();
      },
      onError: (e) => setError(errorText(e)),
    })
  );
  const addKey = useMutation(
    transport.orpc.settings.omniRoute.addKey.mutationOptions({
      onSuccess: async (result) => {
        setKey("");
        setMessage(result.message);
        setError(null);
        await refreshModels();
      },
      onError: (e) => setError(errorText(e)),
    })
  );
  const testProvider = useMutation(
    transport.orpc.settings.omniRoute.testProvider.mutationOptions({
      onSuccess: (result) => {
        if (result.ok) {
          setMessage(result.message);
          setError(null);
        } else {
          setError(result.message);
          setMessage(null);
        }
      },
      onError: (e) => setError(errorText(e)),
    })
  );

  const submitKey = () => {
    if (key.trim().length < 8) {
      setError("Enter a valid provider API key.");
      return;
    }
    setError(null);
    setMessage(null);
    addKey.mutate({ provider, key: key.trim() });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="sm:max-w-[620px] max-h-[85vh] resize overflow-auto"
        style={{
          left: `calc(50% + ${offset.x}px)`,
          top: `calc(50% + ${offset.y}px)`,
        }}
      >
        <div
          className="cursor-move select-none touch-none"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <DialogHeader>
            <DialogTitle>OmniRoute</DialogTitle>
            <DialogDescription>
              Drag this header to move the window or resize its lower-right edge.
              Add your own provider credentials; provider costs and quotas apply.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm space-y-1">
            <div className="font-medium">
              Status: {status.data?.running ? "Running" : status.data?.available ? "Installed · stopped" : "Not installed"}
            </div>
            <div className="text-muted-foreground break-all">
              {status.data?.baseUrl ?? "http://127.0.0.1:20128/v1"}
            </div>
            <p className="text-muted-foreground">
              {status.data?.message ?? "OmniRoute starts only when you click Start."}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                disabled={start.isPending}
                onClick={() => {
                  setError(null);
                  setMessage(null);
                  start.mutate({});
                }}
              >
                {start.isPending ? "Starting…" : status.data?.running ? "Connect to running OmniRoute" : "Start and use OmniRoute"}
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label htmlFor="omniroute-provider" className="text-sm font-medium">
                Provider
              </label>
              <select
                id="omniroute-provider"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={provider}
                onChange={(event) => setProvider(event.target.value as OmniRouteProvider)}
              >
                {OMNIROUTE_PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>{OMNI_ROUTE_LABELS[id]}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="omniroute-api-key" className="text-sm font-medium">
                Provider API key
              </label>
              <Input
                id="omniroute-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="Paste a provider API key"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Sent to OmniRoute over stdin. This key is not written to Abacus Bot's config.json.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={addKey.isPending || key.trim().length < 8}
                onClick={submitKey}
              >
                {addKey.isPending ? "Saving key…" : "Save key to OmniRoute"}
              </Button>
              <Button
                variant="secondary"
                disabled={testProvider.isPending || !status.data?.running}
                onClick={() => {
                  setError(null);
                  setMessage(null);
                  testProvider.mutate({ provider });
                }}
              >
                {testProvider.isPending ? "Testing…" : "Test provider"}
              </Button>
            </div>
          </div>
        </div>

        {message && <p role="status" className="text-sm text-foreground">{message}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
