# 部署 Wandrun

[English](deploy.md) · 简体中文

本文在 Linux 服务器或桌面上部署一个单用户、常驻运行的 Wandrun 网关，包括：网关、浏览器任务专用的
Chrome、systemd 用户服务、HTTPS 和手机配对。已在 Ubuntu 24.04 和 Debian 13（x86_64）上测试。

> [!WARNING]
> Agent 拥有部署用户的文件、命令和网络权限。需要隔离时请使用单独的 Linux 用户。
> Chrome DevTools 只绑定回环地址；网关绑定回环（经 HTTPS 反向代理暴露）或私有网络网卡，不要绑定公网地址。

## 1. 环境要求

| | |
| --- | --- |
| 系统 | 支持 systemd 用户服务的 Linux（不登录也要运行时需 `loginctl enable-linger`） |
| Python | 3.13，由 [uv](https://docs.astral.sh/uv/getting-started/installation/) 安装，不改动系统 Python |
| Node.js | 20+，用于 Codex CLI 和 `agent-browser` |
| 模型 | 包含 Codex 的 ChatGPT 套餐 |
| 浏览器（必需） | Google Chrome、Xvfb、[`agent-browser`](https://www.npmjs.com/package/agent-browser)；网关启动时连不上 Chrome 会直接失败 |
| 内存 | 至少 4 GB，并配 2 GB 以上 swap。占用主要看页面：广告多的新闻站快速滑动时，Chrome 在 4 GB 无 swap 的机器上涨到 3 GB 以上，页面失去响应 |
| 磁盘 | 依赖、Chrome 与 Codex CLI 约 2.5 GB，另加 swap 文件；10 GB 系统盘偏紧 |

下文使用以下路径：

| 用途 | 路径 / 地址 |
| --- | --- |
| 代码 | `~/wandrun` |
| 工作区（Agent 的文件和状态） | `~/wandrun-workspace` |
| Codex 凭据 | `~/.local/share/wandrun/codex-home` |
| Chrome 用户目录 | `~/wandrun-chrome` |
| 网关 | `127.0.0.1:8765` |
| Chrome DevTools | `127.0.0.1:9222` |

## 2. 代码与依赖

先装好 git、uv 和 Node.js 20+。

```bash
git clone https://github.com/ccpowe/wandrun.git ~/wandrun
cd ~/wandrun
git checkout <发布 tag>   # 固定在某个发布版本，不要直接跟随 main
uv sync --locked --no-dev
```

`--locked` 在锁文件不一致时直接失败，不会临时重新解析依赖。

`uv sync` 只安装 Python 依赖。浏览器相关的依赖另外安装（Ubuntu）：

```bash
sudo apt install -y xvfb curl wget
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
npm install -g agent-browser@0.38.1
sudo install -d /etc/opt/chrome/policies/managed
echo '{"ExtensionInstallForcelist": ["ddkjiahejlhfcafbddmgiahcphecmpfh"]}' |
  sudo tee /etc/opt/chrome/policies/managed/wandrun-adblock.json
```

最后三行用 Chrome 策略给这台机器上的 Chrome 强制安装 [uBlock Origin Lite](https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh)。浏览器任务的内存主要花在页面上，广告和跟踪脚本占了不少，本机实测屏蔽广告后几个新闻站同时打开的内存降了约 22%。个别网站因此异常时，在扩展里给该站点放行。

## 3. Codex 登录

网关使用**专属**的 Codex 目录，不读取 `CODEX_HOME` 或 `~/.codex`，避免和日常 CLI 争抢刷新令牌。

```bash
npm install --prefix ~/.local/share/wandrun/codex-cli @openai/codex@0.162.1
install -d -m 700 ~/.local/share/wandrun/codex-home
CODEX_HOME=~/.local/share/wandrun/codex-home \
  ~/.local/share/wandrun/codex-cli/node_modules/.bin/codex \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

设备登录不可用时，去掉 `--device-auth` 改用浏览器登录。重新登录前**一定先停止网关**，登录完再启动。
未登录时网关也能启动，App 的模型页会显示登录命令。

## 4. 工作区

创建一个空工作区。网关首次启动时会写入默认的 `.wandrun/agents.toml`、`mcps.toml`、
`environments.toml` 和内置技能 `browser`、`skill-installer`：

```bash
install -d -m 700 ~/wandrun-workspace
```

- **Agent 和 MCP 服务**只在首次启动时从 TOML 导入网关数据库，之后请在 App 里修改（设置 → Agent / 连接器）。
- **执行环境**（`environments.toml`）每次启动都会读取。
- **技能**放在 `.wandrun/skills/<名字>/SKILL.md`，也可以从 App 导入。

默认内容：

| | |
| --- | --- |
| Agent | `main`：技能 `browser`、`skill-installer`，MCP `exa` |
| MCP | `exa`：[Exa](https://exa.ai) 网页搜索与网页内容读取，默认不需要 API key |
| 执行环境 | `local`：浏览器连接 `http://127.0.0.1:9222`，即下一节的 Chrome 服务 |

浏览器的并发与页数可以在 `environments.toml` 里调整：

```toml
# ~/wandrun-workspace/.wandrun/environments.toml
default = "local"

[environments.local]
type = "local"
command_timeout = 120

[environments.local.browser]
cdp_url = "http://127.0.0.1:9222"
slots = 1          # 同时进行的浏览器任务数
max_pages = 3      # 每个任务最多页面数
idle_timeout = 900 # 空闲多少秒后释放
queue_timeout = 30
```

之后新建的 Agent 如果要操作网页，在 App 里勾选 `browser` 技能。

## 5. systemd 用户服务

Chrome 以**有界面模式跑在 Xvfb 上**，不用 `--headless`：headless Chrome 的标识是
`HeadlessChrome`，Google 登录等网站会直接拒绝。保留 Chrome 自带的沙箱。

```bash
install -d -m 700 ~/.config/systemd/user ~/wandrun-chrome
```

`~/.config/systemd/user/wandrun-xvfb.service`（选一个空闲的显示号，用 `ls /tmp/.X11-unix/` 确认）：

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

`~/.config/systemd/user/wandrun-chrome.service`：

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

`~/.config/systemd/user/wandrun-gateway.service`：

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
# 设为你的 HTTPS 地址后，Notion 等应用可以自动完成 OAuth 回调
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

`PartOf` 让网关随 Chrome 一起重启，不会继续持有失效的浏览器连接。
```bash
systemctl --user daemon-reload
systemctl --user enable --now wandrun-xvfb wandrun-chrome wandrun-gateway
sudo loginctl enable-linger "$USER"   # 退出登录后服务继续运行
```

服务显示 `active` 不代表已经就绪。等到不带令牌的请求返回 **401** 才算就绪（说明设备认证正常工作）：

```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/agents)" = 401 ]; do sleep 2; done
journalctl --user -u wandrun-gateway -n 100 --no-pager
```

## 6. HTTPS

二选一：

- **私有网络**，如 Tailscale、WireGuard：手机直接访问网关，启动时把 `--host` 设为该网卡的地址。
- **反向代理**加域名：域名解析到这台机器并开放 80/443，Caddy 会自动申请证书。没有域名时可用
  `<IP 横线形式>.sslip.io`（如 `203-0-113-7.sslip.io`）。Caddy 示例，`flush_interval -1` 保证 SSE 实时推送：

  ```caddyfile
  wandrun.example.com {
      reverse_proxy 127.0.0.1:8765 {
          flush_interval -1
      }
  }
  ```

代理不要记录完整请求 URL 和查询参数；公网机器上不要把网关绑定到 `0.0.0.0`。
要使用应用 OAuth（Notion），把 `WANDRUN_PUBLIC_URL`（或 `--public-url`）设为手机访问网关的地址，
回调地址是 `<公开地址>/oauth/callback`。GitHub 使用 Device Flow，不需要回调。

## 7. 配对手机

网关运行时执行：

```bash
cd ~/wandrun
.venv/bin/python -m wandrun.gateway pair --workspace ~/wandrun-workspace \
  --url https://wandrun.example.com --name "我的手机"
```

`--url` 换成手机实际访问的地址（第 6 节的域名或私有网络地址）。在 App 中扫码，或手动输入地址和配对码。配对码只能用一次，五分钟内有效。
`--list` 列出已配对设备，`--revoke <设备 ID>` 撤销设备。

## 构建 Android App

App 在 `mobile/`（Expo SDK 57、React Native）。Expo Go 适合快速预览界面；日常使用请装 APK 或开发构建，
其中的原生模块和原生补丁只在这两种方式下生效。

```bash
cd mobile
npm ci
npx eas-cli login
npx eas-cli init                                        # 关联到你自己的 Expo 账号
npx eas-cli build --platform android --profile preview  # 生成可安装的 APK
```

本地开发可用 `npx expo run:android`，在连接的设备上构建并安装调试版。

## 升级

1. 阅读发布说明。持久化格式尚不稳定，某些版本需要全新的状态目录。
2. 停止服务：`systemctl --user stop wandrun-chrome wandrun-xvfb`（网关随 Chrome 一起停止）。
3. 备份 `~/wandrun-workspace` 和 `~/wandrun-chrome`。
4. 切换到新 tag，执行 `uv sync --locked --no-dev`。
5. 如果发布说明要求，把 `~/wandrun-workspace/.wandrun/state` 移走。Agent 和连接器会从 TOML 重新导入，手机需要重新配对。
6. 启动服务，按上面的方法等到 401。

不要恢复旧的 `auth.json` 副本：刷新令牌可能已经轮换过。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 服务 `active` 但连接被拒绝 | 启动时会先连接 MCP 服务再开始监听；稍等后查看日志 |
| 公网 502 | 先确认 `127.0.0.1:8765` 上的网关，再查代理 |
| 处处返回 401 | 没有设备令牌时这是正常结果；先配对手机 |
| `login_required`、没有模型 | 停止网关，按第 3 节登录 Codex 后重启 |
| 改 `agents.toml` 不生效 | 首次启动后以数据库为准，请在 App 里修改 |
| Chrome 端口被占用 / 用户目录被锁 | 另一个 Chrome 占用了端口或目录；使用自己的服务和用户目录 |
| Google 登录提示浏览器不安全 | Chrome 在 headless 模式运行；按上文改为 Xvfb 上的有界面模式 |
| 浏览器画面卡住、画面连接失败 | 多半是内存不足，Chrome 停止响应：`free -h` 查看；关闭占用大的页面或稍等即可恢复 |
| 浏览器任务一直在排队 | 所有 `slots` 都被占用；关闭闲置页面，内存允许时调大 `slots` |
