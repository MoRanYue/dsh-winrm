# Changelog

## 0.2.0

Adapted to DeepSeek Harness 0.2.0-rc.2, and fixed a defect that made every
non-trivial command fail on the wire.

### Fixed

- **Scripts longer than ~1.5 KB no longer fail with `The command line is too long.`** WinRS hands the command line to `cmd.exe`, which caps it at ~8191 characters, and `-EncodedCommand` inflates a script 2.67x (UTF-16LE → base64). The previous design embedded the whole script in the command line, so a 2,000-character script already failed and the 48 KiB transfer chunk — whose embedded base64 alone is ~65K characters — was structurally unpublishable. The command line is now a **constant** outer script and the user script rides the WinRS **stdin** stream, length-prefixed in UTF-8 bytes and split on code points. Verified live to 200 KB.
- **Output produced before a mid-script `exit` is no longer discarded.** The child body is `& (...) 2>&1 | Out-String -Stream -Width 4096`: `Out-String` stringifies error records onto stdout (a bare `2>&1` leaves them to be re-serialized as CLIXML on stderr, where CLIXML stripping deleted the text), and `-Stream` emits them line by line instead of buffering the whole pipeline (plain `Out-String` lost everything produced before an `exit`).
- **`exit N` and an uncaught `throw` no longer lose the envelope.** The script now runs in a child `powershell.exe`, so the process boundary absorbs the termination and the outer script is still alive to report the real exit code. Previously both cases killed the whole shell, the envelope never printed, and the call reported a hardcoded `exitCode: 1` with the raw CLIXML dumped as output.
- **`stderr` is now a first-class envelope field.** It used to be read off the WinRS stderr stream, which is decoded as ASCII and mixed with CLIXML host records; it now travels in the envelope as base64 UTF-8, so `[Console]::Error` output is exact and cannot be mistaken for transport noise.
- The child is started with `-EncodedCommand`, which the execution policy does not govern (the policy covers `.ps1` files). No temp file is written, so a GPO that locks the policy to `Restricted`/`AllSigned` cannot block the call.

### Changed

- `peerDependencies` widened to `^0.1.7-alpha.2 || ^0.2.0-rc.1` so the 0.2.x line loads. The previous `^0.1.7-alpha.2` range made the harness skip the whole bundle on 0.2.0-rc.2, which surfaced as `unknown tool "winrm_list"` for every tool. Verified against the harness's own compatibility checker: 0.1.7-alpha.2 … 0.2.5 are accepted, 0.3.0-rc.1 and 0.3.0 are refused. (`>=0.1.7` would have been wrong — it fails on prereleases.)
- Envelope format is now three labelled lines (`__DSH_WINRM__<code>`, `O:<base64>`, `E:<base64>`). The labels are load-bearing: the WinRM client trims every response chunk, which can eat the newline between two lines, and base64 never contains `:`.
- SDK devDependencies track `^0.2.0-rc.2`.

### Removed

- `wrapEnvelope`, `winrmPowerShellScript`, `execCommandLine`, and `consoleCommandLine` — all internal, none had an external caller.

## 0.1.1

### Fixed

- `winrm_list` no longer fails with `returned invalid output` on hosts that set `rejectUnauthorized`. `HostStore.summarize()` emits that field, but the tool's declared output schema omitted it, and the harness enforces `additionalProperties: false` — so any host configured with an explicit self-signed-certificate choice broke the call.
- Added `tests/tools.test.ts`, which validates each tool's real output value against its own declared schema, so an engine field without a matching schema entry fails in tests instead of at runtime.

## 0.1.0 - 2026-09-24

First npm release. The plugin is now built against DeepSeek Harness 0.1.7 and runs WinRM entirely in Node.

### Added

- WinRM/PowerShell Remoting host management: host config store (`~/.dsh/dsh-winrm.json`), PowerShell exec, streaming console sessions, service and process management, base64-chunked file transfer, and cluster execution.
- Seven agent tools: `winrm_list`, `winrm_exec`, `winrm_service`, `winrm_process`, `winrm_upload`, `winrm_download`, `winrm_cluster`.
- Web sidebar entry plus the tabbed operations panel (hosts / console / services / processes / transfer), registered through the shell's `sidebar.panellist` and keyed `main` slots.
- UTF-8 base64 command envelope, so Chinese and other non-ASCII output survives the WinRM code page handling.
- `dsh` peer declarations (`dsh-tools`, `dsh-host-webserver`, `dsh-system-prompt`, `dsh-llm`), so the 0.1.7 runtime compatibility check accepts the supported 0.1.x range and refuses a version the plugin was not built against.
- One-shot target preparation script (`scripts/enable-winrm.ps1`).

### Changed

- Adapted to DeepSeek Harness 0.1.7: the removed `dsh-settings` `installSettingsSection`/`settingsNamespace` API is replaced by `Volatile` Config fields read via `.get()` plus a `loader/volatile-update` re-sync; every `@deepseek-ai/*` SDK dependency tracks `^0.1.7-rc.1`.
- The browser half registers through the shell's first-class slots instead of DOM injection into the sidebar and center column, so it tracks the current AppFrame layout and no longer leaks global CSS.
- WinRM runs on the native Node.js [winrm-client](https://github.com/shide1989/winrm-client) library: no Python and no child process. WinRS shell creation, PowerShell `-EncodedCommand` execution, the receive loop, and NTLM/Basic auth all run in-process, with per-attempt auth fallback and a deadline that also covers shell creation.
- Command results no longer carry PowerShell's `#< CLIXML` host records on `stderr`; genuine process-level stderr is preserved, and a script that never reached the envelope keeps its stderr for diagnosis.
- Envelope parsing accepts an empty body, a trimmed separating newline, and a negative exit code, so no-output commands report the real exit status instead of failing.

### Security

- Credentials stay inside the host process — they are passed straight to the Node WinRM client and never travel through a child-process stdin pipe or a process argument list.
- Host passwords live in `~/.dsh/dsh-winrm.json` with mode 0600, are never echoed back by the UI, and are redacted from host summaries.
- Cluster execution filters targets by aliases, environment, and tags.

## 0.1.4 - 2026-08-22

Pre-npm history: the plugin was distributed as a git checkout/tarball before the
first registry release, and these version numbers were git-era only. The npm
release line starts at 0.1.0 above.

### Added

- WinRM/PowerShell Remoting host management: host config store, PowerShell exec, streaming console sessions, service and process management, base64-chunked file transfer, cluster execution.
- Seven agent tools: winrm_list, winrm_exec, winrm_service, winrm_process, winrm_upload, winrm_download, winrm_cluster.
- Web sidebar panel with host/console/service/process/transfer tabs.
- UTF-8 base64 command envelope so Chinese output survives WinRM code page handling.
- One-shot target preparation script (scripts/enable-winrm.ps1).

### Security

- Credentials are stored in ~/.dsh/dsh-winrm.json with mode 0600 and passed to pywinrm via stdin, never in process arguments.
- Cluster execution filters targets by aliases, environment, and tags.
