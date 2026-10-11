# OmniRoute Gateway integration

The desktop app can start or attach to a local OmniRoute gateway and open its
dashboard in a movable, resizable window from **Settings → Models → OmniRoute
Gateway**.

- OmniRoute is pinned to **3.8.50**, matching the Brahma Evo integration.
- On Windows, the runtime and gateway data use
  `%LOCALAPPDATA%\BrahmaAI\OmniRoute`, the same location used by Brahma Evo.
  Other platforms use AbacusAI Bot's user-data directory.
- If the expected OmniRoute dashboard and OpenAI-compatible `/v1/models`
  endpoint already respond on `127.0.0.1:20128`, the app reuses that gateway
  instead of starting a second one.
- If this app starts the gateway, it explicitly binds it to **127.0.0.1**,
  disables telemetry, creates a real app-specific OmniRoute API key, and
  restarts with `REQUIRE_API_KEY=true` before model requests. The client key is
  kept in the user's local OmniRoute data folder with restrictive file
  permissions; it is not committed to Git.
- If Brahma or another app already owns a healthy shared gateway, Abacus creates
  its own API key through OmniRoute's loopback-only CLI authentication and does
  not stop or reconfigure that other app's process. In that case API-key
  enforcement remains controlled by the running gateway's existing settings.
- Add Gemini, OpenRouter, Anthropic, OpenAI, or other upstream keys inside
  OmniRoute's own dashboard. Those credentials are managed by OmniRoute and are
  not copied into AbacusAI Bot's provider-key settings or committed to Git.
- AbacusAI Bot registers an OpenAI-compatible `omniroute/auto` model and sets
  it as the default for new sessions. Authenticated `/v1/models` checks use the
  same app-specific API key as model requests. The gateway must have at least
  one usable upstream provider configured before inference can succeed.
- Node.js and npm must be installed. The app installs only the pinned OmniRoute
  package into the per-user runtime directory; it does not install packages
  globally.

OmniRoute is an independently maintained package. Review its provider and
network-security settings before entering production credentials. Only use
provider keys you are authorized to use, and honor each upstream provider's
usage and rate limits.
