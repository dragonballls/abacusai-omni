# T.O.R.V.I.S public-information and compatibility research

This document tracks a **public-documentation-only** evaluation of T.O.R.V.I.S by FatihMakes. It is not T.O.R.V.I.S source code. Do not commit the vendor installer, executables, extracted application files, license keys, tokens, cookies, private user data, or other proprietary materials to this public repository.

## Official information checked

Checked 20 October 2026:

- Product and download page: https://heytorvis.com/
- Terms of Use: https://heytorvis.com/en/terms/
- Creator's installation video: https://www.youtube.com/watch?v=mMigua_rhkw
- Separate public project reference: https://github.com/FatihMakes/Mark-LVI — this is a separate project and must not be described as T.O.R.V.I.S source code.

The official site describes T.O.R.V.I.S as a Windows voice assistant that can operate apps and files, interact with the screen, use Python plugins, and connect to a phone through a private Telegram bot. It says the AI models run on the vendor's servers. The site describes installation followed by a licence key, and subscription plans; downloading the installer alone does not provide permission to use the service or mean that the hosted AI is included in the installer.

## Important terms and eligibility limits

The Terms of Use currently identify themselves as effective **19 October 2026** and state that users must be **18 or older**. They also state that the application is licensed, not sold, and prohibit copying, modifying, decompiling, disassembling, reverse engineering, extracting code or contents, redistributing/reselling the app, or using it to build a competing product, except where the law expressly allows otherwise.

Accordingly, this repository workstream must not provide a download-and-upload path for the proprietary app, attempt to bypass its licence/age requirements, unpack or reverse-engineer its internals, or redistribute its installer. Continue only with public product documentation, published and supported integration surfaces, independently written compatible functionality, or work for which the rights holder has given appropriate written authorization. If uncertain whether a proposed inspection is permitted, stop and ask the vendor for written clarification.

## Safe Abacus integration goals

1. Record publicly documented user-facing capabilities and relevant product links.
2. Look for an explicitly documented, supported plugin/interface/API that can lawfully interoperate with Abacus. Do not assume one exists until official documentation confirms it.
3. If no supported interface is documented, implement original Abacus features inspired by the general capability (voice interaction, permissioned desktop actions, plugin isolation, visible confirmations) without copying Torvis code, UI assets, prompts, or proprietary package contents.
4. Keep Abacus's existing process boundaries, secret handling, and user confirmations. Never embed a Torvis licence key or credentials in source control.
5. If the vendor offers a developer programme or grants written permission for a specific integration, record its scope and conditions before proceeding.

## Findings log

No T.O.R.V.I.S installer has been downloaded, installed, executed, or analyzed as part of this repository workstream. This is intentional: the current public terms impose age and intellectual-property restrictions that must be respected.

| Field | Status |
|---|---|
| Official product page identified | Yes: https://heytorvis.com/ |
| Official Terms of Use reviewed | Yes: effective 19 October 2026 |
| Age eligibility | Terms state 18+ |
| Public product capabilities recorded | Yes, from the official website |
| Installer obtained or inspected | No |
| Vendor internals extracted or reverse-engineered | No |
| Supported developer API/plugin interface verified | Not yet |
| Vendor authorization for redistribution or reverse engineering | Not established |
| Abacus integration implemented | No |

Do not describe the T.O.R.V.I.S investigation or integration as completed until an authorized, supported integration path has been confirmed and verified with reproducible tests.
