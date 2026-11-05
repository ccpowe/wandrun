# Deploying Wandrun

English · [简体中文](deploy.zh-CN.md)

This guide sets up a single-user, always-on Wandrun gateway on a Linux server or desktop:
the gateway, a dedicated Chrome for browser tasks, systemd user services, HTTPS, and phone pairing.
It was tested on Ubuntu 24.04 and Debian 13 (x86_64).

> [!WARNING]
> Agents run with the deploying user's file, shell and network permissions. Use a dedicated
> Linux user if you want separation. Keep Chrome DevTools on loopback. Bind the gateway to loopback
> (exposed through an HTTPS reverse proxy) or to a private-network interface, never a public address.

## 1. Requirements

| | |
| --- | --- |
| OS | Linux with systemd user services (`loginctl enable-linger` for running without a login session) |
| Python | 3.13, installed by [uv](https://docs.astral.sh/uv/getting-started/installation/) — the system Python is not touched |
| Node.js | 20+ for the Codex CLI and `agent-browser` |
| Model access | A ChatGPT plan that includes Codex |
| Browser (required) | Google Chrome, Xvfb, [`agent-browser`](https://www.npmjs.com/package/agent-browser); the gateway fails to start if it cannot reach Chrome |
| Memory | 4 GB or more, plus at least 2 GB of swap. Usage depends mostly on the page: scrolling fast through an ad-heavy news site pushed Chrome past 3 GB on a 4 GB machine without swap, and the page stopped responding |
| Disk | Dependencies, Chrome and the Codex CLI take about 2.5 GB, plus the swap file; a 10 GB system disk is tight |

The paths below use:

| Purpose | Path / address |
| --- | --- |
| Code | `~/wandrun` |
| Workspace (agents' files and state) | `~/wandrun-workspace` |
| Codex credentials | `~/.local/share/wandrun/codex-home` |
| Chrome profile | `~/wandrun-chrome` |
| Gateway | `127.0.0.1:8765` |
| Chrome DevTools | `127.0.0.1:9222` |

## 2. Code and dependencies

Install git, uv and Node.js 20+ first. If `swapon --show` prints nothing, create a swap file and add it to `/etc/fstab`.

```bash
git clone https://github.com/ccpowe/wandrun.git ~/wandrun
cd ~/wandrun
git checkout <release tag>   # pin a release instead of following main
uv sync --locked --no-dev
```

`--locked` fails instead of re-resolving if the lock file drifts.

`uv sync` installs Python dependencies only. Install the browser dependencies separately (Ubuntu):

```bash
sudo apt install -y xvfb curl wget
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
npm install -g agent-browser@0.38.1
sudo install -d /etc/opt/chrome/policies/managed
echo '{"ExtensionInstallForcelist": ["ddkjiahejlhfcafbddmgiahcphecmpfh"]}' |
  sudo tee /etc/opt/chrome/policies/managed/wandrun-adblock.json
```

The last three lines force-install [uBlock Origin Lite](https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh) into every Chrome on this machine through a policy. Most of a browser task's memory goes to the page, and ads and trackers are a large share: blocking them cut memory by about 22% with several news sites open in local tests. If a site breaks, allow it in the extension.

## 3. Codex login

The gateway uses its **own** Codex home and never reads `CODEX_HOME` or `~/.codex`, so it
cannot fight your everyday CLI over refresh tokens.

```bash
npm install --prefix ~/.local/share/wandrun/codex-cli @openai/codex@0.162.1
install -d -m 700 ~/.local/share/wandrun/codex-home
CODEX_HOME=~/.local/share/wandrun/codex-home \
  ~/.local/share/wandrun/codex-cli/node_modules/.bin/codex \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

If device login is unavailable, drop `--device-auth` to use the browser flow.
Always **stop the gateway before logging in again**, then start it afterwards.
The gateway starts without a login too; the app's model page then shows the login command.

The model catalog is cached for 300 seconds; reopening the page need not fetch a new catalog.
When checking Codex or connector OAuth, token rotation is expected: verify that refresh and a
subsequent authenticated request work, not that token bytes stay unchanged.

## 4. Workspace

Create an empty workspace. On first start the gateway writes default
`.wandrun/agents.toml`, `mcps.toml` and `environments.toml` plus the built-in `browser` and
`skill-installer` skills:

```bash
install -d -m 700 ~/wandrun-workspace
```

- **Agents and MCP servers** are imported only when the database has no import marker; edit them in the app afterwards. Emptying the list does not re-import TOML.
- **Environments** are read and validated on every start, but persisted definitions take precedence; editing TOML does not replace an existing binding or browser configuration. Set the parameters below before first startup.
- **Skills** live in `.wandrun/skills/<name>/SKILL.md`. Ask an agent to import them using `skill-installer`, then select them in the app. New agents do not inherit the default skills or MCP selections.

What you get by default:

| | |
| --- | --- |
| Agent | `main`: skills `browser` and `skill-installer`, MCP server `exa` |
| MCP | `exa`: [Exa](https://exa.ai) web search and page content, no API key needed by default |
| Environment | `local`: browser at `http://127.0.0.1:9222`, the Chrome service in the next section |

Tune browser concurrency and pages in `environments.toml`:

```toml
# ~/wandrun-workspace/.wandrun/environments.toml
default = "local"

[environments.local]
type = "local"
command_timeout = 120

[environments.local.browser]
cdp_url = "http://127.0.0.1:9222"
max_pages = 3      # total pages in this Chrome, shared by all tasks
idle_timeout = 900 # idle browser-lease expiry, not machine suspension; 0 disables it
```

`max_pages` is the shared budget for the environment's Chrome, including pages being created or not yet confirmed closed; excess requests fail immediately rather than queue. Human-controlled leases and leases with viewers do not expire under this idle rule.
An empty workspace copies only the two default skills. The checked-in workspace also includes an unselected `news-brief` example with separately configured Reader and other dependencies. The gateway's automatic `wandrun-ui` protocol skill is not written into this skill directory.

Agents you create later need the `browser` skill selected in the app to use web pages.

## 5. systemd user services

Chrome runs **headed on Xvfb**, not `--headless`: headless Chrome identifies itself as
`HeadlessChrome`, and sites such as Google sign-in refuse it. Keep Chrome's sandbox on.

```bash
install -d -m 700 ~/.config/systemd/user ~/wandrun-chrome
```

`~/.config/systemd/user/wandrun-xvfb.service` (pick a free display; check `ls /tmp/.X11-unix/`):

```ini
[Unit]
Description=Wandrun virtual display

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -nolisten tcp
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/wandrun-chrome.service`:

```ini
[Unit]
Description=Wandrun dedicated Chrome
Requires=wandrun-xvfb.service
After=wandrun-xvfb.service

[Service]
Type=exec
Environment=DISPLAY=:99
UMask=0077
ExecStart=/usr/bin/google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=%h/wandrun-chrome --no-first-run --no-default-browser-check --no-startup-window --window-size=1280,800 --ozone-platform=x11
ExecStartPost=/usr/bin/curl --fail --silent --output /dev/null --retry 30 --retry-connrefused --retry-delay 1 --max-time 2 http://127.0.0.1:9222/json/version
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/wandrun-gateway.service`:

```ini
[Unit]
Description=Wandrun gateway
Wants=wandrun-chrome.service
After=wandrun-chrome.service
PartOf=wandrun-chrome.service

[Service]
Type=exec
WorkingDirectory=%h/wandrun
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PYTHONUNBUFFERED=1
# Set this to your HTTPS address to enable automatic OAuth callbacks (Notion etc.)
# Environment=WANDRUN_PUBLIC_URL=https://wandrun.example.com
UnsetEnvironment=WANDRUN_GATEWAY_TOKEN CODEX_HOME
UMask=0077
ExecStart=%h/wandrun/.venv/bin/python -m wandrun.gateway --workspace %h/wandrun-workspace --host 127.0.0.1 --port 8765
Restart=always
RestartSec=5
TimeoutStopSec=120
KillMode=control-group

[Install]
WantedBy=default.target
```

`PartOf` restarts the gateway together with Chrome, so it never keeps a stale browser connection.

Wandrun no longer automatically reads `.env`. Put required variables in the unit's
`Environment=` entries or an explicit `EnvironmentFile=%h/.config/wandrun/gateway.env`
under `[Service]` (create the file first, mode `0600`). systemd environment files use
`NAME=value`, not shell `export` commands. Reload the units and restart the gateway after changes.

```bash
systemctl --user daemon-reload
systemctl --user enable --now wandrun-xvfb wandrun-chrome wandrun-gateway
sudo loginctl enable-linger "$USER"   # keep services running after logout
```

`active` does not mean ready yet. Wait until an unauthenticated request returns **401**
(that is the device auth boundary working):

```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/agents)" = 401 ]; do sleep 2; done
journalctl --user -u wandrun-gateway -n 100 --no-pager
```

## 6. HTTPS

Pick one:

- **Private network** such as Tailscale or WireGuard: the phone reaches the gateway directly;
  start it with `--host` set to that interface address.
- **Reverse proxy** with a domain that points at this machine, with ports 80/443 open; Caddy
  obtains the certificate itself. Without a domain, `<dashed IP>.sslip.io` works
  (e.g. `203-0-113-7.sslip.io`). Caddy example — `flush_interval -1` keeps SSE streaming:

  ```caddyfile
  wandrun.example.com {
      reverse_proxy 127.0.0.1:8765 {
          flush_interval -1
      }
  }
  ```

Put the config in `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. Issuing the certificate takes a few seconds; on a TLS error right after the change, check `journalctl -u caddy`. It is ready when `curl https://<domain>/agents` from outside returns 401.

Do not log full request URLs or query strings at the proxy, and do not bind the gateway to
`0.0.0.0` on a public machine. For app OAuth (Notion), set `WANDRUN_PUBLIC_URL` (or
`--public-url`) to the address the phone uses; the callback is `<public url>/oauth/callback`.
GitHub uses Device Flow and needs no callback.

## 7. Pair the phone

With the gateway running:

```bash
cd ~/wandrun
uv run --locked --no-dev python -m wandrun.gateway pair --workspace ~/wandrun-workspace \
  --url https://wandrun.example.com --name "My phone"
```

Set `--url` to the address the phone actually uses (the domain or private address from section 6).
Scan the QR code in the app, or type the address and code manually. Codes are single-use and
expire after five minutes. `--list` shows paired devices and `--revoke <device id>` revokes one.

## Optional Instabox cloud execution

Skip this section for a local-only setup; local execution and screenshots need neither Instabox nor LiveKit.
Wandrun binds **existing** [Instabox](https://instabox.sh) machines; it does not create, delete or proactively suspend them. Their files, commands and browser data live under your Instabox account rather than only on the gateway host.

Set `INSTABOX_API_KEY=<your Key>` in the gateway's explicit `EnvironmentFile`, with mode `0600`, and restart the gateway.
This is a systemd loading convention: Wandrun does not automatically read `instabox.env` or `.env`.
Choose an existing machine in the agent editor. The server page shows platform states, agent references and page counts, with a full-list subpage. Listing does not wake machines; platform state does not prove SSH, Chrome or video readiness.

Alternatively, add an explicit definition to `.wandrun/environments.toml` **before first import**, keeping the existing local table:

```toml
[environments.cloud]
type = "instabox"
machine_id = "<existing machine ID>"
api_key_env = "INSTABOX_API_KEY" # variable name, not the Key value
workdir = "/data/home/wandrun"

[environments.cloud.browser]
```

The empty `browser` table enables cloud browser defaults: CDP 9222, profile `/data/home/wandrun-browser/profile`, 8 total pages and 7200-second idle lease expiry. Omitting the table disables this browser. Still select the machine as the agent's execution environment in the app. Only `local` and `instabox` are supported; the old `type="ssh"` configuration is no longer accepted.

The cloud machine needs Python 3.13, npm, uv and Chrome / Chromium, plus access to npm and Python package sources.
When the agent follows the browser skill's `start_browser.py`, it installs pinned `agent-browser@0.38.1` and a separate video venv with `livekit==1.2.0`, `pillow==13.0.0` and `websockets==17.4` in persistent storage. The publisher venv is `/data/home/wandrun-browser/video-publisher/venv/`; the gateway runs it but never installs dependencies during publishing. The cloud startup script uses headless Chrome with a regular Chrome UA; local Chrome still uses Xvfb as in section 5.

Connections are prepared only for actual I/O. `suspended` machines are resumed; `stopped` machines are not automatically started. Files on `/data` may persist, but processes and pages are not promised to survive suspension. Recovery never automatically replays commands with unknown outcomes. Cloud storage does not replace a backup of the gateway's `.wandrun/state`.

## Optional LiveKit browser video

Video requires **an Instabox environment, a LiveKit SFU, and an Android APK / development build with the native LiveKit modules and project patches**. Expo Go does not have the required player. Missing `[stream.video]`, local execution or an unsupported app automatically uses screenshots without changing takeover input. Video has no audio.
Once video is selected, failures remain explicit and retryable, **not an automatic downgrade to screenshots**. Invalid configuration or unavailable key files prevent gateway startup.

### Deploy the SFU

The project's existing deployment uses [LiveKit Server 1.13.11](https://github.com/livekit/livekit/releases/tag/v1.13.11). Follow the [official self-hosting guide](https://docs.livekit.io/home/self-hosting/deployment/) to install that binary at `~/.local/bin/livekit-server`. This example is a single node with the gateway and Caddy on the same host, without TURN; it does not guarantee connectivity on every network.

Generate your own API-key-to-secret mapping shared by the SFU and gateway; do not put values in the repository or logs. `generate-keys` prints labeled fields, so convert them to a YAML mapping:

```bash
install -d -m 700 ~/.config/wandrun
(umask 077; ~/.local/bin/livekit-server generate-keys |
  uv run --no-project python -c 'import sys; fields = dict(line.split(":", 1) for line in sys.stdin if ":" in line); print(fields["API Key"].strip() + ": " + fields["API Secret"].strip())' \
  > ~/.config/wandrun/livekit-keys.yaml)
```

Create `~/.config/wandrun/livekit.yaml`, replacing the user path, public IP and interface name:

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]
key_file: /home/<user>/.config/wandrun/livekit-keys.yaml
rtc:
  tcp_port: 7881
  udp_port: 7882
  node_ip: <SFU public IP>
  use_external_ip: false
  interfaces:
    includes: [<public network interface>]
turn:
  enabled: false
```

Allow **TCP 7881 and UDP 7882** as described in [LiveKit ports and firewall](https://docs.livekit.io/home/self-hosting/ports-firewall/). Signaling port 7880 stays loopback-only. Media connects directly, not through Caddy. Both the app and cloud machine must reach the SFU; restricted networks may require TURN, which this example does not configure. Set the public interface explicitly on hosts with multiple bridges.

`~/.config/systemd/user/wandrun-livekit.service`:

```ini
[Unit]
Description=Wandrun LiveKit SFU

[Service]
ExecStart=%h/.local/bin/livekit-server --config %h/.config/wandrun/livekit.yaml
UMask=0077
Restart=on-failure
KillMode=control-group
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

Reload and start it with `systemctl --user daemon-reload && systemctl --user enable --now wandrun-livekit`.
Replace section 6's Caddy site with the same-site routing below, keeping the `/rtc` prefix:

```caddyfile
wandrun.example.com {
    handle /rtc* {
        reverse_proxy 127.0.0.1:7880
    }
    handle {
        reverse_proxy 127.0.0.1:8765 {
            flush_interval -1
        }
    }
}
```

Validate and reload Caddy. The SFU runs independently of the gateway and never replaces its authorization or input channel.

### Configure gateway video

Create `~/.config/wandrun/stream.toml`:

```toml
[stream.video]
url = "wss://wandrun.example.com" # site root, without /rtc
api_url = "http://127.0.0.1:7880"
key_file = "~/.config/wandrun/livekit-keys.yaml"
```

Append `--stream-config %h/.config/wandrun/stream.toml` to the gateway unit's `ExecStart`, reload the unit and restart.
`url` must be WSS reachable by the app and publisher; the management API must be loopback HTTP. The key file must be a nonempty YAML mapping with permissions no broader than `0600`. There is no automatic configuration-file discovery.
The current protocol selects the picture transport automatically and uses streaming state input, with no picture/input mode switches. Old `default_transport`, `default_input_mode` and `mode_switch_timeout_s` keys are rejected; do not copy old experimental configurations.

Check that unauthenticated gateway requests still return 401, port 7880 is loopback-only and media ports are allowed. Have a cloud agent open a page, then watch and take over with the new APK. This sends that page's picture through your SFU to the app; the gateway still issues short-lived, least-privilege room tokens. Remove `[stream.video]` and restart the gateway to disable video.

## Build the Android app

The app is in `mobile/` (Expo SDK 57, React Native). The v0.3.0 attachment is a new signed build from `95bf9fc`; its internal version remains **0.2.0 / versionCode 3**.
Video requires the APK / development build's native LiveKit modules and two project patches; Expo Go automatically uses screenshots. Verify keyboard/chat pinning on a native build with the pinned keyboard-controller 1.22.9, not Expo Go's different bundled version.

```bash
cd mobile
corepack enable pnpm
pnpm install --frozen-lockfile  # packageManager pins pnpm 10.34.9
pnpm dlx eas-cli login
pnpm dlx eas-cli init                                        # links the app to your Expo account
pnpm dlx eas-cli build --platform android --profile preview  # produces an installable APK
```

For local development, `pnpm exec expo run:android` builds and installs a debug build on a connected device.

## Fast support

v0.3.0 supports the independent lightning toggle beside each agent's model and the discrete reasoning-effort slider.
Fast is off by default; it applies to the agent's main and compaction model requests without changing reasoning effort.
When enabled, it requests `service_tier=priority` with `x-codex-routing-hint`; when disabled, neither is sent.
There is no client-side fallback retry without Fast if the provider rejects the request.

The app enables the control only after the gateway advertises `capabilities.fast_mode=true`
through `/models` or `/connection`. This declares implementation support, **not** account
entitlement or provider availability. Priority requests may consume more subscription quota;
neither a faster response nor a particular latency is promised.

The native app also offers original-image download/system sharing and an explicit
**More → Landscape** switch during browser takeover (reset to portrait on leaving).
Existing overview screenshots are illustrative and may not show these controls.

## Optional LangSmith tracing

Tracing is **off by default**. To opt in, add an explicit environment file to the gateway
unit as above, containing:

```ini
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=<your LangSmith API key>
LANGSMITH_PROJECT=wandrun
```

Restart the gateway to apply it. Remove `LANGSMITH_TRACING` or set it to `false` and restart
to turn it off. `LANGSMITH_ENDPOINT` and `LANGSMITH_WORKSPACE_ID` are optional routing settings.
Enabling tracing sends conversation content (including injected memory), model inputs/outputs
and tool inputs/results to your configured LangSmith service. Known credentials are redacted
and trace attachments are stripped, but unknown secrets and personal content are not guaranteed
to be removed; review the data and the service's retention policy before opting in. Usage counts
against your LangSmith quota. Harbor forwarding also requires the adapter's
`langsmith_tracing=True`; see [the adapter](../src/wandrun/evaluation/harbor_agent.py).

## Upgrades

1. Read the release notes, then stop services: `systemctl --user stop wandrun-gateway wandrun-chrome wandrun-xvfb`.
2. Back up `~/wandrun-workspace` and `~/wandrun-chrome` while stopped, including SQLite sidecars.
   Keep credentials private; see the token rollback warning below.
3. Check out the new tag and run `uv sync --locked --no-dev`.
4. v0.3.0 requires schema **31** and **is incompatible with old state, with no migration**.
   While stopped, move `~/wandrun-workspace/.wandrun/state` to a backup location, then start services
   and wait for the 401 readiness check above.

Fresh state resets conversations, schedules, pairings and database-stored agent/connector settings.
Agents and connectors are re-imported from TOML; edits made in the old database are not recovered.
Prepare the intended TOML and skills before upgrading, then pair the phone and authorize connectors again.
Do not just change SQLite `user_version` or apply the old schema-22-to-24 operator SQL.
Moving state does not automatically remove user files or browser profiles outside it; back up and inspect those separately.

**Rollback and OAuth:** tokens may rotate during acceptance checks. Never restore an older
Codex `auth.json` or connector refresh token from a database backup over the current credentials.
Restoring code/state is not a credential rollback; if current credentials cannot be retained
consistently, sign in or authorize again rather than replaying an old refresh token.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Service `active` but connection refused | Startup opens MCP servers before listening; wait, then read the journal |
| Public 502 | Gateway on `127.0.0.1:8765` first, then the proxy |
| 401 everywhere | Expected without a device token; pair the phone |
| `login_required`, no models | Run the Codex login in section 3 with the gateway stopped, then restart it |
| Editing `agents.toml` has no effect | After the first start the database is the source; edit in the app |
| Chrome port busy / profile locked | Another Chrome is using the port or profile; use your own unit and profile directory |
| Google sign-in says the browser is not secure | Chrome is running headless; run it headed on Xvfb as above |
| Browser view freezes or the view connection fails | Usually Chrome stopped responding for lack of memory: check `free -h`; close heavy pages or wait for it to recover |
| Browser page creation is rejected | The environment reached `max_pages`; close idle pages, or raise `max_pages` if memory allows |
| Cloud machine says paused but cannot execute | Platform `stopped` is not started automatically; restore a supported state in Instabox first. A platform state is not an SSH readiness check |
| Video fails | Check the SFU, `/rtc*` proxy, TCP 7881 / UDP 7882, native app player and cloud publisher venv; retry explicitly, with no automatic screenshot downgrade |
| Editing environment TOML has no effect | Persisted definitions take precedence; use a fresh workspace rather than changing SQLite to rebind machines |
