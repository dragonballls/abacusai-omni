# T.O.R.V.I.S and Mark-LVI: public capability and compatibility research

Research updated: 20 October 2026.

This document compares publicly described T.O.R.V.I.S capabilities with Abacus's existing architecture and evaluates the separate public Mark-LVI source project. These are separate products: Mark-LVI is not T.O.R.V.I.S source code.

## Sources checked

- T.O.R.V.I.S product page: https://heytorvis.com/
- T.O.R.V.I.S download and getting-started page: https://heytorvis.com/download/
- Creator's installation video: https://www.youtube.com/watch?v=mMigua_rhkw
- Separate Mark-LVI repository: https://github.com/FatihMakes/Mark-LVI
- Mark-LVI README: https://github.com/FatihMakes/Mark-LVI/blob/main/readme.md
- Mark-LVI license file: https://github.com/FatihMakes/Mark-LVI/blob/main/LICENSE
- Mark-LVI dependencies: https://github.com/FatihMakes/Mark-LVI/blob/main/requirements.txt

## T.O.R.V.I.S: confirmed public product information

The public product pages describe T.O.R.V.I.S as a Windows voice assistant that can:

- Open applications and handle files.
- Use a screen agent to click and type through applications while the user watches.
- Keep long tasks running in the background.
- Require a separate user confirmation for consequential actions such as sending, deleting, running code, calling, or shutting down.
- Accept messages and voice notes through a private Telegram bot, using the same memory even when the PC is off.
- Use hosted AI running on the vendor's servers rather than requiring a user's own provider API key.
- Enable bundled skills including screen agent, 3D-printer support, game updater, cloud memory, live panels, disk map, quiz, shopping list, and Excel writer.
- Add custom Python plugins using an in-app guide.

The download page identifies Windows 10 and 11 (64-bit), a microphone, and an internet connection as requirements. It describes a per-user install without administrator rights, subscription/license-key activation, and in-app automatic updates.

These pages establish user-facing capabilities and the custom Python plugin concept. The reviewed public pages do not specify a third-party developer API, external command-line contract, public plugin ABI/schema, configuration-file format, or supported way for another desktop app to control T.O.R.V.I.S. That means an external integration surface is **not verified from these sources**; it does not prove that no private or separately documented interface exists.

The official installer executable was not downloaded or executed during this research pass. As a result, its exact version, file hash, digital signature, installer technology, embedded package metadata, and runtime behavior remain unverified.

## Mark-LVI: repository, architecture, license, and dependencies

Repository: https://github.com/FatihMakes/Mark-LVI

GitHub identifies this as a separate public Python project. Its visible source tree includes main.py, ui.py, setup.py, requirements.txt, core, actions, plugins, providers, dashboard, memory, and config. It must not be represented as T.O.R.V.I.S source code.

The README and public source describe these architectural elements:

- A PyQt6 desktop UI and a Python application loop.
- Gemini Live voice interaction, plus configurable speech-to-text, language-model, and text-to-speech components.
- Local or hosted OpenAI-compatible chat-completions endpoints for an alternate model pipeline.
- File-based Python plugin discovery through the plugins directory; plugins expose tool metadata and a handler.
- Separate built-in action modules, a confirmation gate, undo support, memory, and desktop/browser control.
- A dashboard component for remote access from a phone.
- Optional local speech components such as faster-whisper and Piper; these are not part of the minimal default dependency set.

The requirements file identifies Python packages including PyQt6, sounddevice, NumPy, google-genai, httpx, requests, BeautifulSoup, Playwright, PyAutoGUI, Pyperclip, Pillow, OpenCV, mss, and psutil, with additional optional or platform-specific dependencies. The README lists Python 3.11, 3.12, or 3.13 and Windows 10/11, macOS, or Linux. OS permissions and capabilities vary; for example, desktop input and screen capture depend on the OS security model.

### Verified license

The repository's actual LICENSE file begins by identifying Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0), and the README describes personal and non-commercial use only. GitHub's metadata reports “Other”/NOASSERTION, so the checked-in LICENSE—not the metadata label—is the substantive license reference.

Practical implication: non-commercial reuse may be possible only while satisfying the license's attribution and other conditions. This does not establish commercial reuse rights, grant rights to separately licensed dependencies/assets, or make the project automatically compatible with the rest of Abacus's MIT-licensed code. Do not copy Mark-LVI files into Abacus's ordinary source tree without an explicit file-by-file license and distribution decision. Prefer an optional, separately licensed process boundary or an independently implemented equivalent when the architecture permits it.

## Compatibility matrix

| Capability | Publicly confirmed in T.O.R.V.I.S | Abacus status / decision |
|---|---|---|
| Voice input/output | Yes | Abacus already has voice RPC, microphone-permission handling, and Whisper model support. A complete always-on/wake-word conversational loop is not verified by this comparison. |
| AI model routing | Hosted vendor AI is described | OmniRoute already provides an authenticated local OpenAI-compatible gateway and Auto model selection; provider-backed live calls still require configured upstream credentials. |
| Desktop/app interaction | Screen agent is described | Abacus has an Electron desktop host and agent/browser task tools. Validate every action through existing permission and confirmation pathways. |
| File operations | File handling is described | Abacus already has file and generated-file agent tools; keep writes constrained by existing path and permission rules. |
| Extensibility | Custom Python plugins are described | Abacus has an installed-skill/marketplace/local-import flow and MCP/tool extension points. No T.O.R.V.I.S-compatible plugin schema has been verified. |
| Phone access | Private Telegram bot is described | Abacus has messaging integrations. Do not assume T.O.R.V.I.S bot compatibility; no public external control API was established. |
| Remote/dashboard access | Product describes phone access | Mark-LVI contains a dashboard component; this is not evidence of a T.O.R.V.I.S API. Any Abacus bridge must be explicitly authenticated and opt-in. |
| Long-running tasks and confirmations | Both are described | Reuse Abacus's existing agent sessions, permission UI, and tool gates rather than adding a parallel execution path. |

## Integration decisions

1. **No direct T.O.R.V.I.S adapter yet.** There is no verified, public third-party API or plugin protocol in the product/download pages checked. Do not guess an endpoint or present the in-app Python-plugin feature as a remote API.
2. **Use native Abacus extension points first.** Extend the existing skills, MCP tools, agent-tool, permission, and voice surfaces where a new capability is needed. Preserve OmniRoute and the existing God's Eye/Life360 work; do not replace those subsystems with a separate assistant runtime.
3. **Keep Mark-LVI separate unless its license boundary is deliberately accepted.** It offers a concrete reference for file-based Python plugins and explicit user confirmation, but its CC BY-NC license and Python dependency/runtime requirements should not be silently combined with the main Abacus package.
4. **If pursuing a Mark-LVI sidecar later,** define a documented localhost protocol, narrow permissions, explicit opt-in, process lifecycle management, and an isolated data/config directory. Test that it can reach the configured OmniRoute endpoint without exposing credentials to the renderer or writing them to source control.
5. **Never depend on a vendor binary's undocumented internals.** Before adding a direct T.O.R.V.I.S connector, obtain a documented supported interface from the vendor. This research pass does not modify or redistribute the T.O.R.V.I.S installer.

## Test and CI record

- Repository main head checked: 513aafabf66d48c465294b9a52ef5c2af8c75dd6.
- Research branch before this documentation update: 5326c236458ecf2a56cd85fe0b0d87391d7b771f.
- Main CI run 39459134458: completed successfully for the checked main head.
- God's Eye/Life360 PR #17 CI run 39507470449: still in progress at the last check; Windows and macOS test jobs had not completed. Do not interpret this as a final pass.
- Mark-LVI files inspected: repository metadata, README, LICENSE, requirements.txt, core/plugin_loader.py, and the core/plugins directory listings.
- T.O.R.V.I.S installer execution, signature/hash checks, and live vendor API tests: not run.
- Provider-backed OmniRoute live calls: not run in this research pass because they require configured upstream provider credentials.
- Documentation checks for this update: source list and compatibility matrix reviewed against the checked public pages/files; no T.O.R.V.I.S installer or private vendor package contents are included.

The research milestone is ready for review when this documentation commit's CI has completed. T.O.R.V.I.S compatibility and full desktop-assistant completion remain unverified until an authorized interface and reproducible integration tests are available.
