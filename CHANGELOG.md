# Changelog

## 0.2.0 - 2026-09-23

### Changed

- Adapted to the current DeepSeek Harness (0.1.7-alpha.2): dropped the removed `dsh-settings` `installSettingsSection`/`settingsNamespace` API in favor of `Volatile` Config fields read via `.get()` plus a `loader/volatile-update` re-sync; upgraded every `@deepseek-ai/*` SDK dependency and moved to `@deepseek-ai/schemastery`.
- The browser half now registers through the shell's first-class slots — a `sidebar.panellist` row and the keyed `main` panel — instead of DOM injection into the sidebar/center column, so it tracks the current AppFrame layout and stops leaking global CSS.
- Replaced the Python/pywinrm bridge with the native Node.js [winrm-client](https://github.com/shide1989/winrm-client) library: no Python runtime, no child process; WinRS shell creation, PowerShell `-EncodedCommand` execution, receive loop, and NTLM/Basic auth all run in-process.
- Command results no longer carry PowerShell's `#< CLIXML` host records on `stderr`; genuine process-level stderr is preserved. The transport also bounds every call (shell creation included) with a deadline and cleans up a shell that arrives after it, so a slow handshake cannot leak or run past the timeout.
- Migrated the build config to tsdown's current `deps.neverBundle` / `deps.alwaysBundle` options, removing the deprecated `external` / `noExternal` warnings.

### Security

- Credentials stay inside the host process (passed straight to the Node WinRM client) — they no longer travel through a child-process stdin pipe and never appear in any process argument list.

## 0.1.4 - 2026-08-22

### Added

- WinRM/PowerShell Remoting host management: host config store, PowerShell exec, streaming console sessions, service and process management, base64-chunked file transfer, cluster execution.
- Seven agent tools: winrm_list, winrm_exec, winrm_service, winrm_process, winrm_upload, winrm_download, winrm_cluster.
- Web sidebar panel with host/console/service/process/transfer tabs.
- UTF-8 base64 command envelope so Chinese output survives WinRM code page handling.
- One-shot target preparation script (scripts/enable-winrm.ps1).

### Security

- Credentials are stored in ~/.dsh/dsh-winrm.json with mode 0600 and passed to pywinrm via stdin, never in process arguments.
- Cluster execution filters targets by aliases, environment, and tags.
