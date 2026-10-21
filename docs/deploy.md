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

Install git, uv and Node.js 20+ first.

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

## 4. Workspace

Create an empty workspace. On first start the gateway writes default
`.wandrun/agents.toml`, `mcps.toml` and `environments.toml` plus the built-in `browser` and
`skill-installer` skills:

```bash
install -d -m 700 ~/wandrun-workspace
```

- **Agents and MCP servers** are imported from the TOML files into the gateway database on the
  first start only. After that, edit them in the app (Settings → Agents / Connectors).
- **Environments** (`environments.toml`) are read on every start.
- **Skills** live in `.wandrun/skills/<name>/SKILL.md`; you can also import them from the app.

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
slots = 1          # concurrent browser tasks
max_pages = 3      # pages per task
idle_timeout = 900 # seconds before an idle lease is released
queue_timeout = 30
```

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

Do not log full request URLs or query strings at the proxy, and do not bind the gateway to
`0.0.0.0` on a public machine. For app OAuth (Notion), set `WANDRUN_PUBLIC_URL` (or
`--public-url`) to the address the phone uses; the callback is `<public url>/oauth/callback`.
GitHub uses Device Flow and needs no callback.

## 7. Pair the phone

With the gateway running:

```bash
cd ~/wandrun
.venv/bin/python -m wandrun.gateway pair --workspace ~/wandrun-workspace \
  --url https://wandrun.example.com --name "My phone"
```

Set `--url` to the address the phone actually uses (the domain or private address from section 6).
Scan the QR code in the app, or type the address and code manually. Codes are single-use and
expire after five minutes. `--list` shows paired devices and `--revoke <device id>` revokes one.

## Build the Android app

The app is in `mobile/` (Expo SDK 57, React Native). Expo Go is fine for quick UI previews, but
use an APK or a development build day to day: a native module and native patches only apply there.

```bash
cd mobile
npm ci
npx eas-cli login
npx eas-cli init                                        # links the app to your Expo account
npx eas-cli build --platform android --profile preview  # produces an installable APK
```

For local development, `npx expo run:android` builds and installs a debug build on a connected device.

## Upgrades

1. Read the release notes. The state format is not stable yet; a release may require a fresh state.
2. Stop the services: `systemctl --user stop wandrun-chrome wandrun-xvfb` (the gateway stops with Chrome).
3. Back up `~/wandrun-workspace` and `~/wandrun-chrome`.
4. Check out the new tag and run `uv sync --locked --no-dev`.
5. If the release requires it, move `~/wandrun-workspace/.wandrun/state` aside. Agents and
   connectors are then re-imported from the TOML files, and phones must be paired again.
6. Start the services and wait for the 401 check above.

Do not restore an old copy of `auth.json`: the refresh token may already have rotated.

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
| Browser task waits for a slot | All `slots` are busy; close idle pages or raise `slots` if memory allows |
