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

1. Read the release notes, then stop services: `systemctl --user stop wandrun-chrome wandrun-xvfb`
   (the gateway stops with Chrome).
2. Back up `~/wandrun-workspace` and `~/wandrun-chrome` while stopped, including SQLite sidecars.
   Keep credentials private; see the token rollback warning below.
3. Check out the new tag and run `uv sync --locked --no-dev`.
4. Choose the state path below, then start services and wait for the 401 check above.

### From v0.1.x (gateway schema 22 → 23)

The formats are incompatible; the project contains no migration code. Prefer **fresh state**:
move `~/wandrun-workspace/.wandrun/state` to a backup location while stopped. Conversations,
schedules and device pairings start afresh; agents and connectors are re-imported from TOML,
not recovered from edits in the old database. Old memory is not imported.

Alternatively, to retain the gateway database, install the `sqlite3` CLI and run this
**one-time SQL only on a stopped, backed-up schema-22 database**. It drops memory authorship
metadata, rebuilds `memory_metadata` and sets version 23; it is not a general state migration.
Old memory is not converted to shared profile or working memory: re-enter what you need in
the app, and start new conversations rather than resuming old execution checkpoints.

```bash
sqlite3 "$HOME/wandrun-workspace/.wandrun/state/gateway.sqlite" <<'SQL'
.bail on
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE upgrade_guard (version INTEGER CHECK (version = 22));
INSERT INTO upgrade_guard SELECT user_version FROM pragma_user_version;
DROP TABLE memory_metadata;
CREATE TABLE memory_metadata (
    scope TEXT NOT NULL CHECK (scope IN ('profile', 'work')),
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'agent')),
    CHECK ((scope = 'profile' AND agent_id IS NULL) OR (scope = 'work' AND agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX memory_metadata_profile ON memory_metadata(scope) WHERE scope = 'profile';
CREATE UNIQUE INDEX memory_metadata_work ON memory_metadata(agent_id) WHERE scope = 'work';
PRAGMA user_version = 23;
COMMIT;
PRAGMA user_version;
PRAGMA integrity_check;
SQL
```

Expect `23` and `ok`. On error, keep services stopped and inspect the backup; do not bypass
the version guard. This SQL does not update other schema versions.

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
| Browser task waits for a slot | All `slots` are busy; close idle pages or raise `slots` if memory allows |
