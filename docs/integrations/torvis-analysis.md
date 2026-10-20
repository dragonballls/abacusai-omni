# T.O.R.V.I.S package research plan

This document records a lawful, non-destructive compatibility investigation for the T.O.R.V.I.S desktop installer by FatihMakes. It is **not** the T.O.R.V.I.S source code, and no proprietary installer, executable, extracted application files, API secrets, license tokens, or user data should be committed to this public repository unless the rights holder expressly permits redistribution.

## What is confirmed so far

- The creator's installation video points to https://heytorvis.com for T.O.R.V.I.S and describes access through FatihMakes Academy.
- The video includes a "License Key & Setup" step. A downloadable installer alone therefore should not be treated as permission to use the application or evidence that its backend services are included.
- The public Mark-LVI repository is a separate project. It is useful as a public architectural reference, but it should not be represented as the T.O.R.V.I.S source.
- Official video: https://www.youtube.com/watch?v=mMigua_rhkw
- Public Mark-LVI reference: https://github.com/FatihMakes/Mark-LVI

These points are based on public descriptions and have not been independently tested against an installed T.O.R.V.I.S package.

## Investigation goals

1. Establish the exact installer filename, version, publisher/signature, SHA-256 hash, and package type.
2. Inspect file manifests and bundled-runtime metadata without executing the installer.
3. Identify ordinary integration surfaces (documented local endpoints, plugin APIs, command-line arguments, IPC, configuration formats, or supported launch options).
4. In a disposable Windows Sandbox/VM, observe normal startup and shutdown, child processes, file changes, and outbound network destinations. Do not submit credentials or personal data.
5. Compare findings with Abacus's existing Electron lifecycle, permission boundaries, and OmniRoute gateway.
6. Implement only an authorized integration adapter or independently written compatible functionality. Do not disable activation/licensing, extract secrets, impersonate accounts, or claim the vendor's hosted AI is included in the installer.

## Sample handling

Keep the installer and any extracted proprietary application files outside the public repository, in a local, access-controlled analysis directory. Do not run an unknown installer on the primary Windows profile before static inspection.

In PowerShell, replace the path below with the installer you obtained from the official source:

```powershell
$sample = "C:\Path\To\TorvisInstaller.exe"
Get-Item $sample | Select-Object FullName, Length, LastWriteTime
Get-FileHash $sample -Algorithm SHA256
Get-AuthenticodeSignature $sample | Format-List Status, StatusMessage, SignerCertificate, Path
```

Record only non-sensitive metadata in the public investigation report. Do not paste license keys, authentication tokens, cookies, private account data, or user conversations into logs or GitHub.

If the package is an archive that the publisher permits inspecting, list its contents before extracting it. Do not upload the installer or unpacked application to this public repo. If a package is not inspectable without bypassing technical or licensing restrictions, stop and use the vendor's documented interface or request permission.

## Findings log

No T.O.R.V.I.S installer has been obtained or analyzed in this workstream yet.

| Field | Status |
|---|---|
| Official source identified | Yes: https://heytorvis.com |
| Actual installer file obtained | Not yet |
| SHA-256 / signature checked | Not yet |
| Static package inventory | Not yet |
| Runtime/network behavior observed | Not yet |
| Supported integration API confirmed | Not yet |
| Abacus integration implemented | Not yet |
| Vendor authorization for redistribution | Not established |

Do not describe this investigation as completed until these fields are updated with reproducible evidence.
