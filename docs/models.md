# Models

AbacusAI Bot is a bring-your-own-provider app: on desktop, you can use
supported model APIs by adding your own API keys in Settings → Models. An
Abacus.AI account or Abacus credit balance is not required to use the app's
direct Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, and other provider
integrations. You may also use OmniRoute as a local API gateway to centralize
the providers you have configured.

Each upstream provider still controls model access, free quotas, rate limits,
and billing. A provider's free tier can change or run out, and paid API usage
is billed by that provider. The optional Abacus.AI integration may have its own
credits and plan restrictions; the app does not remove those restrictions from
Abacus-hosted requests.

You can also connect provider subscriptions where supported, cloud platforms,
OpenAI-compatible endpoints, or a local model. Direct provider requests are not
automatically proxied through an AbacusAI Bot service.

Open Settings, then Models, to paste a provider key or use a supported sign-in
flow. The page lists the providers available in the installed version and links
to each provider's key page. The app supports direct providers, model gateways,
AWS Bedrock, Google Vertex, Azure OpenAI, and OpenAI-compatible local endpoints
such as llama.cpp and vLLM.

## Local models

Settings, then Models, has an "On this machine" section: the app can download
a model (a Qwen build in GGUF form, pinned by checksum) into
`~/.abacusai-bot/models` and run it with the bundled llama.cpp server. It
appears in the model picker under "On this machine" and joins RouteLLM - Open
as its last resort, after the direct provider API sources. The recommendation
follows the machine's memory. A local model needs no account, key or quota; it
is slower than the cloud, and the server is stopped after fifteen idle minutes
so the memory comes back.

## Key precedence

The app stores pasted keys in `~/.abacusai-bot/config.json`. A non-empty
environment variable overrides the saved value. This lets a shell profile or a
secret manager supply credentials without writing them to the app config.

Common variables include:

| Provider | Variable |
| --- | --- |
| Abacus.AI | `ABACUS_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google AI Studio | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

The Models page is the source of truth for the full list. Providers that need
several settings, including Bedrock, Vertex, and Azure OpenAI, read their
standard environment variables.

Search, generation, and service connectors have their own settings. A saved
Abacus.AI key also enables account services and automatic diagnostic uploads.
See [Privacy](privacy.md).

## RouteLLM - Open

`RouteLLM - Open` is the picker label for `openllm/auto`. It provides
automatic fallback across these direct provider APIs and local models. It does
not send automatic requests through Abacus-hosted models or consume Abacus
account credits.

| Source | What it adds |
| --- | --- |
| Google AI Studio | Gemini on the key's daily free quota |
| OpenRouter | Its `:free` models |
| Mistral | Devstral, Mistral Medium, Codestral and Mistral Small (free tier: one request a second) |
| NVIDIA | Kimi, GLM, DeepSeek and Nemotron models served free on build.nvidia.com |
| Cerebras | GPT-OSS 120B and Qwen 3.8 (free trial) |
| Groq | GPT-OSS and Qwen. The free tier allows 8K tokens a minute, less than one agent request, so this helps only on a paid Groq plan |
| On this machine | Local models, last |

Provider rows use the keys saved on this device. When a provider asks for a
key, the app stores it locally; OpenRouter's supported sign-in flow is optional.
Connect more than one source to get fallback across independent quotas.
`RouteLLM - Open` is intended for free-tier eligible sources, not as a spending
policy: each provider controls its own access and billing, and paid models you
choose directly can incur charges on that provider's account.

The router tracks advertised free limits (calls and tokens per minute and per
day) and can skip a model whose quota window is spent rather than repeatedly
requesting it. These are fallback heuristics, not a guarantee of free usage:
the provider's own quota, account type, rates, and billing rules still apply.
When a provider names a wait (such as "try again in 7m12s"), the model sits out
for that long; a rejected key pauses its provider until the key changes; a
retired model sits out for a day.

A failed request is retried once, then the conversation moves to another
eligible model. A model that writes its tool call as text, after the app's own
repair has failed, also hands the turn on. Provider-wide quota errors pause
that provider tier. Model-specific errors only pause the failed model. The pool
never moves onto a premium model merely because a free model failed.

This route needs at least one of these connections. Connect more than one
provider for fallback across independent quotas.

## Per-session selection

Choose a model from the composer. The session keeps that choice across restarts.
A bot also keeps its configured model. If a provider becomes unavailable, the
app reports the provider error instead of silently changing a pinned model.

Model catalogs, prices, and context limits come from the bundled provider
catalog or the configured endpoint. They can change between app releases and
may differ from a provider's current billing page.

## Usage

The Usage page reads session logs stored on your machine. It reports requests,
input and output tokens, model use, and estimated cost for the current day and
the last 30 days. RouteLLM - Open also reports which concrete models ran and
which ones hit limits.

These numbers do not replace provider billing. A provider may price cached
tokens, tool calls, or subscription usage differently from the catalog data
available to the app.

The app computes usage totals locally. This does not disable transcript, log,
or diagnostic uploads described in [Privacy](privacy.md).

## GPT-6 Astra through the shared OmniRoute gateway

Open **Settings → Models → OmniRoute Gateway** once to register the shared local
gateway, then choose **GPT-6 Astra · Deep Reasoning · Paid API** from the model
picker when a task needs deeper reasoning and tool use. Abacus sends this model
through OmniRoute's OpenAI **Responses API** endpoint; keep OmniRoute 3.8.50 and
the OpenAI provider credential configured in the shared gateway. On Windows,
Abacus reuses `%LOCALAPPDATA%\\BrahmaAI\\OmniRoute`, which Brahma Evo also uses.
The provider key stays in OmniRoute rather than being copied into Abacus settings.

`omniroute/auto` remains the default for routine work and fallback. Astra is an
explicit, higher-cost choice rather than an automatic route, so ordinary chats
do not unexpectedly start using the premium model. Standard short-context
pricing is currently $10 per million input tokens and $50 per million output
tokens; cached input and cache writes have separate rates. Long-context requests
and processing tiers may cost more. The picker estimate is informational and
does not replace the provider's billing page.

GPT-6 Astra requires the Responses API for tool calling. The OmniRoute adapter
uses the Responses transport so tool-enabled agent turns do not fall back to
Chat Completions. For a provider failure, verify the OpenAI key in the shared
OmniRoute dashboard and test that provider there before changing other keys.
