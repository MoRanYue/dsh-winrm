# dsh-winrm — remote Windows administration for DSH (WinRM / PowerShell Remoting)

[中文](README.md) | English

A DSH plugin modeled on [dsh-ssh](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-ssh): it administers Windows servers over the native **WinRM / PowerShell Remoting** protocol, so **the target machine needs no OpenSSH**.

> **Provenance**: this project is a fork of [andyfan1094/dsh-winrm](https://github.com/andyfan1094/dsh-winrm) (Apache-2.0) that replaces the backend's Python + pywinrm implementation with a native Node.js client ([winrm-client](https://github.com/shide1989/winrm-client)), so **Python is no longer required locally**. The GUI, the agent tools and the feature scope follow the upstream design.

## Features

| Surface | What it does |
| --- | --- |
| "Windows" sidebar entry | A main panel with five tabs: **Hosts** / **Console** / **Services** / **Processes** / **Transfer** |
| Agent tools | `winrm_list` `winrm_exec` `winrm_service` `winrm_process` `winrm_read` `winrm_write` `winrm_edit` `winrm_upload` `winrm_download` `winrm_cluster` |
| PowerShell console | A WebSocket command session (each command runs through the native Node WinRM client and streams its output back) |
| Service management | List / start / stop / restart / change start type (automatic, manual, disabled) |
| Process management | List (CPU, memory, path) / kill by PID |
| Remote text files | Read (paged by line, encoding aware, numbered envelope) / write (whole-file overwrite, optional UTF-8 / UTF-8 BOM / UTF-16LE) / edit (exact string replacement that keeps the original encoding; a non-unique match is refused by default) |
| Transcript cards | `winrm_read` / `winrm_write` / `winrm_edit` render as a **file content card and diff cards** in the transcript (reusing the harness's own `ReadBlock` / `DiffBlock` primitives) instead of the raw model-facing envelope |
| File transfer | Streamed over WinRM (upload through one shell and one stream, download through parallel byte ranges, **no SMB dependency**, any path works); uploads create parent directories |
| Cluster | Run one command across many hosts concurrently (filtered by aliases / environment / tags) |

## Authentication and transport

- Uses a native Node.js WinRM client ([winrm-client](https://github.com/shide1989/winrm-client)) and picks the authentication automatically per transport: Basic first over HTTPS, NTLM first over HTTP, each falling back to the other (HTTP Basic is for trusted intranets only — use HTTPS on the public internet)
- Local accounts are written as `Administrator`; domain accounts as `DOMAIN\user` or `user@domain`
- No Python locally — WinRM runs on a pure Node dependency (winrm-client) installed with the plugin
- Transport: HTTP (5985) or HTTPS (5986); HTTPS offers an "accept self-signed certificate" checkbox
- Chinese output is never mangled: every command goes through a **UTF-8 base64 envelope** (`Out-String -Stream` wrapping plus three labelled envelope lines), which sidesteps the WinRM transport code page
- PowerShell's CLIXML host records are stripped from `stderr` automatically; real process-level stderr (for example `[Console]::Error`) is preserved verbatim
- **Scripts travel over WinRS stdin, not the command line**: WinRS hands the command line to `cmd.exe`, which caps it at roughly 8191 characters, while `-EncodedCommand` inflates a script by 2.67x — long scripts used to fail outright with `The command line is too long.`. The command line is now a **constant** and the script is chunked to stdin behind a UTF-8 byte-length prefix; a 200 KB script is verified working

## Preparing the target machine (one time)

On the Windows machine you want to manage, run this **as administrator**:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\enable-winrm.ps1
```

The script enables the WinRM service and the 5985 listener, allows Basic/Negotiate authentication, permits unencrypted HTTP (intranet), raises the WinRS memory limit to 512 MB, opens the firewall and prints the machine's IP address.

> ⚠️ **Security**: HTTP + Basic is cleartext and belongs on trusted intranets only. On the public internet, configure HTTPS with a self-signed certificate and tick "accept self-signed certificate" in the plugin. Passwords are stored in cleartext in `~/.dsh/dsh-winrm.json` locally (mode 0600, readable only by the current user) and are never echoed back by the plugin UI.

## Screenshot

![dsh-winrm: the Hosts tab after opening the "Windows" sidebar entry](docs/screenshots/winrm-panel.png)

## Install

> Requires DeepSeek Harness **0.1.7-alpha.2 or newer** (including `0.1.7-rc.1`, `0.2.0-rc.*` and `0.2.x`). The plugin declares `peerDependencies` as `^0.1.7-alpha.2 || ^0.2.0-rc.1`, which DSH checks at startup: every 0.1.7 and 0.2.x version loads, and `0.3.0` onward is refused (use `dsh plugin allow-version` to admit a specific version if you accept the risk).

Download the latest `dsh-winrm-*.tgz` from [Releases](https://github.com/MoRanYue/dsh-winrm/releases) and add it to your profile:

```powershell
dsh plugin --profile web add D:\downloads\dsh-winrm-0.3.1.tgz
```

You can also install straight from npm:

```powershell
dsh plugin --profile web add dsh-winrm
```

For local development, link the checkout instead:

```bash
dsh plugin --profile web add link:D:\projects\dsh-winrm
```

**Restart dsh web** after installing (quit and start `dsh web` again) so the plugin takes effect. A "Windows" entry appears in the sidebar, and `winrm_list` and friends become available in the conversation.

### Building from source

```bash
cd D:\projects\dsh-winrm
pnpm install
npm run build     # tsc declarations + tsdown host/client bundles + postbuild wrapping
```

## Usage examples (agent tools)

```
winrm_list                                        # list configured hosts
winrm_exec  alias=web1 command="Get-Service | Select -First 5 | Format-Table"
winrm_service alias=web1 name=W3SVC action=restart
winrm_process alias=web1 action=list
winrm_process alias=web1 id=1234 action=kill
winrm_read   alias=web1 remotePath=C:\logs\app.log offset=1 limit=200
winrm_write  alias=web1 remotePath=C:\temp\run.ps1 content="$env:TEMP" encoding=utf8bom
winrm_edit   alias=web1 remotePath=C:\temp\app.config oldString="port=8080" newString="port=9090"
winrm_upload alias=web1 localPath=D:\a.zip remotePath=C:\temp\a.zip
winrm_download alias=web1 remotePath=C:\logs\app.log localPath=D:\app.log
winrm_cluster command="Get-Date" tags=prod
```

## Architecture

```
src/
  index.ts            Cordis plugin entry (webServer/tools/systemPrompt mounts + settings panel + announcement)
  engine.ts           WinRmEngine facade: exec / services / processes / readFile / writeFile / editFile / ls / upload / download / console / cluster / test
  store.ts            ~/.dsh/dsh-winrm.json host store (atomic write, 0600)
  protocol.ts         Host <-> browser wire types
  diff.ts             Bounded hunk derivation for the transcript cards (no diff package)
  powershell.ts       PS fragment builders + stdin envelope (outer/child wrapping / services / processes / directory / streamed send-receive scripts)
  routes.ts           /api/dsh-winrm route family + console WebSocket (loopback fence)
  tools.ts            The 10 winrm_* agent tools
  engine/client.ts    winrm-client transport: in-process authentication (NTLM/Basic), UTF-8 envelope, streamed upload/download + chunked fallback
  engine/wsman.ts     Hand-written WSMan Send/Receive envelopes (raw bytes over stdin, no double base64; 512000 envelope cap)
  engine/console.ts   Streaming PowerShell console session
  client/             Browser half: sidebar entry + main panel (5 tabs)
  client/tool/        Transcript cards: three tool.call.toolview frames rendered with DSH's own ReadBlock / DiffBlock
scripts/
  enable-winrm.ps1    One-shot WinRM enablement on the target machine
  postbuild.mjs       __ModuleLoader__ wrapping for the client artifact
```

Transport relies on the native Node.js [winrm-client](https://github.com/shide1989/winrm-client) (NTLM/Basic, in-process authentication); the password is used only inside the host process and never appears on any child process command line.

### SMB channel and a custom port

The fast `channel=smb` / `channel=auto` path talks to the target's port 445 by default. The host form exposes an "SMB port" field, but Windows **cannot** move the SMB TCP listening port ([the documentation](https://learn.microsoft.com/en-us/windows-server/storage/file-server/smb-ports) only allows alternate QUIC ports), so any other value means something forwards to 445 in front of the target:

```powershell
# On the target: forward 1445 to the local 445, open only to the dsh machine's egress IP
netsh interface portproxy add v4tov4 listenport=1445 listenaddress=0.0.0.0 connectport=445 connectaddress=127.0.0.1
New-NetFirewallRule -DisplayName 'dsh-winrm: SMB 1445' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 1445 -RemoteAddress <egress IP of the dsh machine>
```

With a non-445 port the transfer maps the share with `New-SmbMapping -TcpPort` onto a free drive letter (Z downwards), copies, and unmaps. `-TcpPort` needs **the machine running dsh** to be Windows 11 24H2 / Windows Server 2025 or newer; the credentials reach PowerShell through environment variables, not the command line.

## Known limitations

- The console is a command session: it does not preserve PowerShell variables or the current directory, and every command runs independently
- Uploads go over **one stdin stream**: a single shell, a single command, one `Send` per 256 KB, with per-chunk gzip for compressible content (a 1.7 MB JSON fixture travels as 91 KB on the wire). The old 48 KB chunked path is kept as a fallback, used only when the streaming channel is unavailable
- Downloads go over **parallel byte ranges**: up to four workers by default, each with its own shell reading an absolute byte range of the same file, compressed on the remote side and written locally at the matching offset (measured: 2 MiB in about 10-12 s, 16 MiB in about 21-23 s, 16 MiB of compressible content in about 6 s; the old 48 KB chunked path needed 129 s for 2 MiB and remains as a fallback). A single server `Receive` returns at most 128 KB regardless of the envelope size, so downloads are round-trip bound rather than bandwidth bound
- `channel=auto` (the default) probes the target's SMB port first: `net use` has no short timeout of its own and takes about 60 s to fail when SMB is unavailable, and that wait used to happen before every upload. It is now decided within 3 s and the transfer goes straight over WinRM. An explicit `channel=smb` on a host whose port is closed fails immediately and names `winrm` as the way out
- A custom SMB port (anything but 445) depends on a forward in front of the target, and the machine running dsh must be Windows 11 24H2 / Windows Server 2025 or newer (`New-SmbMapping -TcpPort`); Windows cannot change the SMB TCP listening port
- A streaming transfer is bounded by **whether bytes are still moving**, not by a fixed deadline for the whole transfer: it keeps going as long as data arrives, and only a range that delivers nothing for 180 s is treated as stalled. A 700 MiB file therefore completes normally at the ~0.73 MiB/s this link measures even though it takes about sixteen minutes; the absolute cap exists only so a wedged transfer cannot stay alive forever, and it scales with the payload
- A failed download leaves no residue: bytes already written are discarded and the target file is removed. If the failure happens before any byte arrives (missing path, target is a directory, host unreachable), an existing local file is left untouched — the target file is only created on the first write
- When an attempt is abandoned mid-transfer (for example a failed auth candidate retried from the start), the sender process on the target can outlive it and keep the file open until its shell is reclaimed; a transfer that finishes normally exits on its own. If a remote file refuses to delete, end the corresponding `powershell.exe` sender on the target first
- A single command times out after 60 s by default; pass `timeoutMs` to change it
- The target machine must already have WinRM enabled (see above); cleartext HTTP Basic must not be used on the public internet
- Closing and reopening the panel returns to the Hosts tab: the panel occupies the `main` slot, so it unmounts when you switch back to the conversation and the active tab is not preserved across toggles
