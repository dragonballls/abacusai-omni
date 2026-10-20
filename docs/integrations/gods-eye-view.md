# God’s Eye View integration

AbacusAI Bot launches the full standalone God’s Eye View console inside a separate, resizable desktop window. The application and its local provider server start only when the user opens it. It uses the pinned upstream revision listed below rather than silently drifting at launch.

- Upstream source: https://github.com/bilawalsidhu/gods-eye-view
- Pinned revision: https://github.com/bilawalsidhu/gods-eye-view/commit/de2138e84c1778fd98a48b7c9fd0b9788c318946
- Code license: MIT. Third-party data, camera feeds, datasets, and models have separate usage and attribution requirements. Keep the upstream DATA_SOURCES.md, LICENSE, and public/models/README.md with the packaged app and obey every applicable carve-out.

## Build and runtime

The pack hook calls scripts/prepare-gods-eye-runtime.mjs. It initializes the submodule at the exact pinned commit, installs its locked dependencies with Puppeteer and Playwright browser downloads disabled, and checks that the Vite runtime exists before packaging. The installer copies source and dependencies as separate resources. On first launch, Abacus copies them into its writable per-account profile, so God’s Eye can save its own Provider Settings without writing into the installation directory. Build-host .env files and upstream cache/log folders are never packaged.

God’s Eye uses Node.js 24.14.x or 26.x. The Windows build reuses the bundled Node runtime; the macOS and Linux builds package a dedicated Node 24.14 runtime beside the app, so end users do not need to install Node separately. The server binds only to 127.0.0.1, runs with a random local port, and is stopped when the God’s Eye window closes or Abacus quits. Do not publish this local server to a LAN or the internet.

## Optional Life360 bridge

The integration follows the pattern already used in Brahma Evo: it reads the user's own authorized Home Assistant device_tracker entities. It does not sign in to Life360, circumvent Life360 Circle-sharing controls, or discover a person's location without their sharing permission.

1. In Settings → Environment, enable Life360 through Home Assistant.
2. Enter your private/loopback Home Assistant base URL and a long-lived access token created in that Home Assistant account. Abacus encrypts the token using Electron's OS-backed secureStorage. The plaintext token stays in the main process and is never sent to the God’s Eye renderer.
3. Optionally specify comma-separated device_tracker entity IDs. If supplied, only those entities are shown. If empty, the bridge selects entities whose entity ID or attribution/source identifies Life360.
4. Save, test the connection, and click Open / refresh in God’s Eye settings. That request fetches the currently authorized locations and turns them into temporary pins using God’s Eye's own share-link annotation format. Up to 24 pins are displayed, and refreshing preserves the current camera/view fields and non-Life360 pins.

The bridge only accepts loopback/private-network Home Assistant endpoints. It rejects redirects, times out requests, limits responses to 64 KiB, and validates coordinates. It does not store a location history or write location details into logs. Refresh is user-triggered; the bridge is disabled by default.

The community Home Assistant Life360 integration at https://github.com/pnbruckner/ha-life360 is not an official Life360 API. It relies on undocumented behavior and may break as Life360 changes. The Home Assistant device-tracker API contract is documented at https://www.home-assistant.io/integrations/device_tracker/.

## Verification boundary

Unit tests cover private-host rejection, redirect refusal, response size limits, allowlists, coordinate validation, and map-pin preservation. A real connection test needs a valid token and a reachable Home Assistant instance; no live connection is claimed as successful until it has actually been tested in that environment.
