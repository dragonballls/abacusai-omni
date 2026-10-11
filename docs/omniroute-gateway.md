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
- If this app starts the gateway, it explicitly binds it to **127.0.0.1** and
  disables telemetry. It never intentionally exposes the gateway on the LAN.
- Add Gemini, OpenRouter, Anthropic, OpenAI, or other upstream keys inside
  OmniRoute's own dashboard. Those credentials are managed by OmniRoute and are
  not copied into AbacusAI Bot's provider-key settings or committed to Git.
- AbacusAI Bot registers an OpenAI-compatible `omniroute/auto` model and sets
  it as the default for new sessions. The gateway must have at least one usable
  upstream provider configured before inference can succeed.
- Node.js and npm must be installed. The app installs only the pinned OmniRoute
  package into the per-user runtime directory; it does not install packages
  globally.

OmniRoute is an independently maintained package. Review its provider and
network-security settings before entering production credentials. Only use
provider keys you are authorized to use, and honor each upstream provider's
usage and rate limits.
