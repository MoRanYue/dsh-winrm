# Changelog

## 0.3.0 - 2026-10-03

File transfers no longer pay a full shell lifecycle per 48 KiB chunk, in either
direction.

### Changed

- **`winrm_upload` is now a single streamed transfer instead of ~44 shell cycles.** The old path created a shell, ran a command, sent one 48 KiB base64 chunk, received output and deleted the shell — five HTTP round trips per chunk, measured at **310 s for 2 MiB**. The new path opens one shell, runs one receiver command, and pushes every chunk down that command's stdin as raw bytes. Three runs of the same 2 MiB fixture on `channel=winrm` took **12.1 s, 36.7 s and 96.5 s** — an 8x spread across identical configurations, which is host-side, not code-path (the old path measured 310 s for that fixture, and its cost per chunk is fixed protocol overhead rather than host latency). After the SMB probe below, the default `channel=auto` took **15.1 s**.
- **`winrm_download` streams parallel byte ranges instead of 43 sequential chunk reads.** Measured against this target, one `Receive` returns at most 128 KiB no matter how large an envelope is declared, so a download is latency-bound rather than bandwidth-bound; the old path took **129 s for 2 MiB** (0.016 MB/s). The new path runs up to four workers, each with its own shell and an absolute byte range of the same file, and each range arrives gzip-compressed. Measured **10.5 s / 11.6 s for 2 MiB** and **21.2 s / 22.8 s for 16 MiB** (0.71 MB/s), with a compressible 16 MiB fixture landing in **5.7 s** (2.8 MB/s). Every fixture verified byte-identical by sha256.
- **Sends are hand-built SOAP envelopes.** `winrm-client`'s `doSendInput` base64-encodes the caller's input a *second* time — 1.78x the bytes on the wire — and cannot close the stdin stream. `src/engine/wsman.ts` builds the `Send` envelope itself and posts it through the library's own `sendHttp`, so Basic/NTLM/SPNEGO and the HTTPS options are unchanged, but the stream carries raw bytes.
- **Compressible payloads are gzipped per slice, adaptively.** A slice is compressed only when it actually shrinks past 85%; already-compressed input is sent raw, because gzip on incompressible data yields output marginally larger *and* makes the target inflate it for nothing (measured 3.8x slower). A 1.7 MB JSON-ish fixture went from 1.7 MB to **91 KB on the wire**. Downloads compress unconditionally, where the same measurement showed no penalty (9457 ms vs 9582 ms for incompressible data).
- Slices are 256 KiB, the ceiling the target reports (`MaxEnvelopeSizekb`), against the library's hardcoded 153600.

### Added

- `psReceiveStream()` — the remote receiver. It reads the destination path and total byte count from a header frame rather than the command line, drains each frame straight into a `FileStream`, and inflates gzip frames in a 256 KiB loop. It is delivered on stdin by a small constant bootstrap (`streamCommandLine()`) because the receiver script is 3424 characters, which `-EncodedCommand` would inflate past the ~8191-character `cmd.exe` command-line cap.
- `psSendStream()` — the remote sender: seeks to its range, streams `GZipStream`-compressed bytes to stdout, and reports progress on stderr only, since anything on the success stream would be spliced into the file.
- `src/engine/wsman.ts` — `Send`/`Receive` envelope builders, raw stdin push, a stream reader that treats a text-node-less element as zero bytes, and envelope-size fault classification.
- Slice-size recovery: a `Send` rejected for exceeding the envelope ceiling halves the slice and doubles it back afterwards, so a host with a smaller limit converges without the caller knowing it.
- `smbReachable()` — a 3-second TCP probe of port 445, cached for 60 seconds, consulted before `net use`.

### Fixed

- **`channel=auto` no longer spends a minute on a doomed SMB attempt.** `net use` has no short timeout of its own: against a host whose SMB is down it took **61 s and 58 s** to fail in two measured attempts, and on `auto` (the default) that delay landed *before* every upload — 86 s total for a transfer whose WinRM leg was 12 s. The 445 probe answers the same question in milliseconds, so `auto` now falls through to WinRM immediately. `channel=smb` reports the unreachable port directly instead of waiting out `net use`.
- The streaming paths return `null` rather than throwing when `winrm-client`'s internal `sendHttp` module is absent, so a future layout change falls back to the chunked path instead of failing the transfer.
- **A download that fails partway no longer leaves a truncated file that looks like a finished one.** Bytes already written are discarded and the destination is removed, verified by killing the remote sender mid-transfer after 6 MB had landed: the destination was gone afterwards. A failure *before* any byte arrives (a missing path, a directory, an unreachable host) leaves an existing local file untouched, because the destination is only opened on the first write.
- **A failed download no longer crashes the process with `EBADF`.** `Promise.all` rejects on the first failing range worker, but its siblings kept running and kept handing data to the caller — which had already closed the file handle in its `finally`, so the next write landed on a closed descriptor as an unhandled rejection. Workers are now gated off the moment the transfer settles, and the caller drains queued writes before closing.
- Download writes are positional and chained, so out-of-order ranges land at the right offsets and the file handle cannot close while a write is still in flight.
- **Downloading a path that does not exist now fails instead of quietly succeeding.** The size probe printed `"0"` for a missing file and for a directory, exactly as it did for a genuinely empty one, so `downloadStream` took its zero-byte shortcut and the caller wrote an empty local file and reported a completed transfer. The probe now emits nothing for the absent cases, and both the streaming and chunked paths raise `remote file not found: <path>`. The local file is opened on the first write rather than up front, so the failure no longer leaves an empty file behind either. This defect predates the streaming work.

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
