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
- If this app starts the gateway, it binds to **127.0.0.1**, disables
  telemetry, and enables `REQUIRE_API_KEY=true` before serving requests. Fresh
  data folders receive random `JWT_SECRET`, `API_KEY_SECRET`,
  `OMNIROUTE_CLI_SALT`, and first-run management-password values before the
  pinned package is installed. The embedded window attempts a management
  session using that password. The password and generated Abacus client key
  stay in the user's local OmniRoute data directory; real credentials are
  never committed to Git. Existing data directories and secrets are not rotated.
- If another app already owns a healthy shared gateway, Abacus does not stop it
  or run npm installation against its data directory. It first attempts to
  create the Abacus client key through an authenticated dashboard session. If
  that fails, the loopback-only CLI fallback is available only when the matching
  pinned OmniRoute 3.8.50 runtime is already installed locally; otherwise Abacus
  reports the provisioning failure and leaves the shared gateway untouched.
  API-key enforcement for that already-running process stays under its owner's
  existing settings.
- Add Gemini, OpenRouter, Anthropic, OpenAI, or other upstream keys inside
  OmniRoute's own dashboard. Those credentials are managed by OmniRoute and are
  not copied into AbacusAI Bot's provider-key settings or committed to Git.
- AbacusAI Bot registers an OpenAI-compatible `omniroute/auto` model and sets
  it as the default for new sessions. Authenticated `/v1/models` checks use the
  same app-specific API key as model requests. The gateway must have at least
  one usable upstream provider configured before inference can succeed.
- Node.js and npm must be installed. The app installs only the pinned OmniRoute
  package into the per-user runtime directory; it does not install packages
  globally. The embedded API-key gateway retains platform-specific optional
  package assets but skips npm lifecycle scripts to avoid first-run native
  build/download hangs. It restores the three standalone JavaScript support
  packages and uses Node's built-in SQLite driver with sql.js fallback. Native-
  only OAuth/web transport backends that require install scripts are not
  initialized by this lightweight API-key setup.

OmniRoute is an independently maintained package. Review its provider and
network-security settings before entering production credentials. Only use
provider keys you are authorized to use, and honor each upstream provider's
usage and rate limits.
