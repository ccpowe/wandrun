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

先装好 git、uv 和 Node.js 20+；`swapon --show` 没有输出时先建一个 swap 文件并写进 `/etc/fstab`。

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

模型目录缓存 300 秒，重新打开页面不一定会重新拉取。验收 Codex 或连接器 OAuth 时允许令牌轮换：
确认刷新和后续认证请求成功，不要以 token 字节保持不变作为通过条件。

## 4. 工作区

创建一个空工作区。网关首次启动时会写入默认的 `.wandrun/agents.toml`、`mcps.toml`、
`environments.toml` 和内置技能 `browser`、`skill-installer`：

```bash
install -d -m 700 ~/wandrun-workspace
```

- **Agent 和 MCP 服务**仅在数据库尚无导入标记时从 TOML 导入；之后在 App 修改，删空列表也不会重新导入。
- **执行环境**每次启动读取并校验 TOML，但已持久化的环境定义优先；修改 TOML 不会覆盖已有绑定或浏览器参数。下面的参数应在首次启动前设置。
- **技能**放在 `.wandrun/skills/<名字>/SKILL.md`，可让 Agent 按 `skill-installer` 导入，再在 App 勾选。新建 Agent 不自动继承默认技能或 MCP。

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
max_pages = 3      # 这个 Chrome 的总页面数，所有任务共用
idle_timeout = 900 # 浏览器租约空闲释放期限；不是云机器暂停期限，0 禁用
```

`max_pages` 是该执行环境 Chrome 的共享总预算，包含创建中与未确认关闭的页面；超限立即拒绝，不排队。人工接管或有观看连接的租约不按上述空闲规则释放。
空工作区只复制两个默认技能；仓库自带 workspace 另附未勾选的 `news-brief` 示例，其 Reader 等依赖需自行接入。`wandrun-ui` 是网关自动提供的协议技能，不写入该技能目录。

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

Wandrun 不再自动读取 `.env`。需要的变量放在 unit 的 `Environment=` 中，或在 `[Service]` 下显式添加
`EnvironmentFile=%h/.config/wandrun/gateway.env`（先创建文件，权限设为 `0600`）。
systemd 环境文件使用 `NAME=value`，不写 shell 的 `export`。修改后重新加载 unit 并重启网关。

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

配置写进 `/etc/caddy/Caddyfile` 后 `sudo systemctl reload caddy`。证书签发要几秒，刚改完出现 TLS 错误时先看 `journalctl -u caddy`；从外部 `curl https://<域名>/agents` 返回 401 才算就绪。

代理不要记录完整请求 URL 和查询参数；公网机器上不要把网关绑定到 `0.0.0.0`。
要使用应用 OAuth（Notion），把 `WANDRUN_PUBLIC_URL`（或 `--public-url`）设为手机访问网关的地址，
回调地址是 `<公开地址>/oauth/callback`。GitHub 使用 Device Flow，不需要回调。

## 7. 配对手机

网关运行时执行：

```bash
cd ~/wandrun
uv run --locked --no-dev python -m wandrun.gateway pair --workspace ~/wandrun-workspace \
  --url https://wandrun.example.com --name "我的手机"
```

`--url` 换成手机实际访问的地址（第 6 节的域名或私有网络地址）。在 App 中扫码，或手动输入地址和配对码。配对码只能用一次，五分钟内有效。
`--list` 列出已配对设备，`--revoke <设备 ID>` 撤销设备。

## 可选 Instabox 云执行环境

不使用云沙箱时跳过本节；本机运行和截图不依赖 Instabox 或 LiveKit。
Wandrun 仅绑定**已有** [Instabox](https://instabox.sh) 机器，不负责创建、删除或主动暂停机器。云环境中的文件、命令与浏览器数据位于你的 Instabox 账号下，不再只留在网关主机。

在网关的 `EnvironmentFile` 中设置 `INSTABOX_API_KEY=<你的 Key>`，权限 `0600`，重启网关。
这是 systemd 的显式加载约定，Wandrun 不自动读取 `instabox.env` 或 `.env`。
App 的 Agent 编辑器可选择已有机器；服务器页显示运行中 / 启动中 / 已暂停等平台状态、Agent 引用与页面数，并可打开完整列表。列表读取不会唤醒机器，平台状态不代表 SSH、Chrome 或视频已就绪。

也可在**首次导入前**显式添加 `.wandrun/environments.toml` 定义（保留原有 local 表）：

```toml
[environments.cloud]
type = "instabox"
machine_id = "<已有机器 ID>"
api_key_env = "INSTABOX_API_KEY" # 变量名，不是 Key 值
workdir = "/data/home/wandrun"

[environments.cloud.browser]
```

空 `browser` 表启用默认云浏览器：CDP 9222、profile `/data/home/wandrun-browser/profile`、总页面数 8、租约空闲期限 7200 秒；省略该表则不启用浏览器。仍需在 App 中将 Agent 的执行环境改为该机器。仅支持 `local` 与 `instabox`；旧 `type="ssh"` 不再支持。

云机器需已有 Python 3.13、npm、uv 与 Chrome / Chromium，并能访问 npm / Python 包源。
Agent 按 browser 技能运行 `start_browser.py` 时，在持久目录安装固定版本 `agent-browser@0.38.1`，以及视频 venv 的 `livekit==1.2.0`、`pillow==13.0.0`、`websockets==17.4`。推流 venv 位于 `/data/home/wandrun-browser/video-publisher/venv/`；网关只运行它，不在推流时安装依赖。云浏览器启动脚本使用 headless Chrome 与普通 Chrome UA；本机仍按第 5 节使用 Xvfb。

实际执行 I/O 时才连接机器；`suspended` 会恢复，`stopped` 不自动启动。`/data` 中的文件可持久保存，但不保证进程、页面跨暂停继续；恢复后不自动重放结果未知的命令。云磁盘不能替代网关 `.wandrun/state` 备份。

## 可选 LiveKit 浏览器视频

视频需要 **Instabox 执行环境 + LiveKit SFU + 含原生 LiveKit 模块和项目补丁的 Android APK / 开发构建**；Expo Go 不具备该播放器能力。没有 `[stream.video]`、使用本机环境或 App 不支持时，自动使用截图，不影响接管输入。视频无音频。
已选视频的连接失败时显示错误并允许显式重试，**不会自动降级为截图**；配置非法或密钥文件不可用会阻止网关启动。

### 部署 SFU

本项目现有部署使用 [LiveKit Server 1.13.11](https://github.com/livekit/livekit/releases/tag/v1.13.11)；按[官方自托管指南](https://docs.livekit.io/home/self-hosting/deployment/)安装该二进制到 `~/.local/bin/livekit-server`。以下为单节点、同机网关 / Caddy、无 TURN 示例，不是任意网络的连通保证。

生成自己的 API key / secret 映射文件，供 SFU 和网关共同使用；不要把值写入仓库或日志。`generate-keys` 输出带标签的字段，需转换为 YAML 映射：

```bash
install -d -m 700 ~/.config/wandrun
(umask 077; ~/.local/bin/livekit-server generate-keys |
  uv run --no-project python -c 'import sys; fields = dict(line.split(":", 1) for line in sys.stdin if ":" in line); print(fields["API Key"].strip() + ": " + fields["API Secret"].strip())' \
  > ~/.config/wandrun/livekit-keys.yaml)
```

创建 `~/.config/wandrun/livekit.yaml`，把用户路径、公网 IP 和网卡名替换为自己的实际值：

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]
key_file: /home/<用户>/.config/wandrun/livekit-keys.yaml
rtc:
  tcp_port: 7881
  udp_port: 7882
  node_ip: <SFU 公网 IP>
  use_external_ip: false
  interfaces:
    includes: [<公网网卡名>]
turn:
  enabled: false
```

按 [LiveKit 端口说明](https://docs.livekit.io/home/self-hosting/ports-firewall/)放行 **TCP 7881、UDP 7882**；信令 7880 仅回环，不开放公网。媒体直接连接这些端口，不经 Caddy。App 与云机器都必须能访问 SFU；受限网络可能需额外部署 TURN（本例未配置）。多网桥主机应明确指定公网网卡。

`~/.config/systemd/user/wandrun-livekit.service`：

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

重新加载并启动 `systemctl --user daemon-reload && systemctl --user enable --now wandrun-livekit`。
将第 6 节 Caddy 站点替换为下面的同站点路由；保留 `/rtc` 前缀：

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

校验配置后重新加载 Caddy。SFU 与网关独立运行；SFU 不替代网关的鉴权和输入通道。

### 网关视频配置

创建 `~/.config/wandrun/stream.toml`：

```toml
[stream.video]
url = "wss://wandrun.example.com" # 站点根地址，不加 /rtc
api_url = "http://127.0.0.1:7880"
key_file = "~/.config/wandrun/livekit-keys.yaml"
```

在网关 unit 的 `ExecStart` 后追加 `--stream-config %h/.config/wandrun/stream.toml`，重新加载 unit 并重启。
`url` 必须为 App 与推流端可达的 WSS 地址；管理 API 必须为回环 HTTP；密钥文件必须为非空 YAML 映射且权限不宽于 `0600`。不自动查找配置文件。
当前协议自动选择画面并使用流式状态输入，没有画面 / 输入方式切换；旧 `default_transport`、`default_input_mode`、`mode_switch_timeout_s` 会被拒绝，勿从旧实验配置复制。

检查网关未认证请求仍返回 401、7880 仅回环监听、媒体端口放行；让云环境 Agent 打开网页，再用新 APK 观看并接管。此链路把该页面的画面经你部署的 SFU 发给 App；网关仍签发最小权限、短期房间令牌。不启用视频可移除 `[stream.video]` 后重启网关。

## 构建 Android App

App 在 `mobile/`（Expo SDK 57、React Native）。v0.3.0 附件为从 `95bf9fc` 新构建的签名 APK，内部版本仍是 **0.2.0 / versionCode 3**。
视频需要 APK / 开发构建中的原生 LiveKit 模块及两份项目补丁；Expo Go 自动使用截图。键盘 / 聊天顶置应在项目锁定的 keyboard-controller 1.22.9 原生构建上验证，不能以 Expo Go 的不同内置版本替代。

```bash
cd mobile
corepack enable pnpm
pnpm install --frozen-lockfile  # packageManager 固定 pnpm 10.34.9
pnpm dlx eas-cli login
pnpm dlx eas-cli init                                        # 关联到你自己的 Expo 账号
pnpm dlx eas-cli build --platform android --profile preview  # 生成可安装的 APK
```

本地开发可用 `pnpm exec expo run:android`，在连接的设备上构建并安装调试版。

## Fast 支持

v0.3.0 支持每个 Agent 模型旁的独立闪电开关与离散档位推理强度滑条。
Fast 默认关闭，作用于该 Agent 的主模型与压缩模型请求，不改变推理强度。
开启时发送 `service_tier=priority` 和 `x-codex-routing-hint`，关闭时两者均不发送。
上游拒绝请求时，客户端不会自动关闭 Fast 降级重试。

只有网关通过 `/models` 或 `/connection` 声明 `capabilities.fast_mode=true` 后，
App 才启用该控件。这表示实现支持，**不代表**账户有权限或上游可用。
优先处理请求可能消耗更多订阅额度，不承诺响应更快或特定延迟。

原生 App 也支持下载原图／通过系统分享原图，以及接管浏览器时主动选择**更多 → 横屏**
（离开页面恢复竖屏）。现有概览截图仅作示意，可能未展示这些控件。

## 可选 LangSmith 追踪

追踪**默认关闭**。确需开启时，按上文给网关 unit 显式添加环境文件，内容如下：

```ini
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=<你的 LangSmith API key>
LANGSMITH_PROJECT=wandrun
```

重启网关生效；删除 `LANGSMITH_TRACING` 或设为 `false` 后重启即可关闭。
`LANGSMITH_ENDPOINT`、`LANGSMITH_WORKSPACE_ID` 是可选的路由配置。
开启会把对话内容（含注入的记忆）、模型输入输出和工具输入结果发送到配置的 LangSmith 服务。
已知凭据会脱敏，trace 附件会移除，但不保证移除未知秘密或个人内容；启用前核对数据范围与服务保留策略，
并留意 LangSmith 额度。Harbor 转发还须显式设置适配器的 `langsmith_tracing=True`，
见[适配器源码](../src/wandrun/evaluation/harbor_agent.py)。

## 升级

1. 阅读发布说明，停止服务：`systemctl --user stop wandrun-gateway wandrun-chrome wandrun-xvfb`。
2. 停服备份 `~/wandrun-workspace` 和 `~/wandrun-chrome`，包括 SQLite 附属文件；凭据备份保密，回滚限制见下文。
3. 切换到新 tag，执行 `uv sync --locked --no-dev`。
4. v0.3.0 要求结构版本 **31**，**不兼容旧 state，不提供迁移**。停服后将
   `~/wandrun-workspace/.wandrun/state` 移到备份位置，再启动服务并等待上述 401 检查。

新 state 会重新开始对话、定时、设备配对与数据库中的 Agent / 连接器设置；Agent 与连接器从 TOML 重新导入，不恢复旧数据库中经 App 做的编辑。升级前准备好要使用的 TOML 与技能，配对手机并重新授权连接器；不要只改 SQLite `user_version`，也不要套用旧版 22→24 运维 SQL。保留在 state 外的用户文件与浏览器 profile 不因移走 state 自动删除；仍需备份并人工核对。

**回滚与 OAuth：** 验收可能使令牌轮换。不要把备份中的旧 Codex `auth.json` 或连接器 refresh token
覆盖回当前凭据。回滚代码／状态不等于回滚凭据；无法一致保留当前凭据时，重新登录或授权，不重放旧 refresh token。

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
| 新建浏览器页面被拒绝 | 本环境已达 `max_pages`；关闭闲置页面，内存允许时调大 `max_pages` |
| 云机器显示已暂停但无法执行 | 平台 `stopped` 不会自动启动；先在 Instabox 恢复到支持的状态，页面状态不是 SSH 就绪检查 |
| 视频失败 | 核对 SFU / `/rtc*` 反代、TCP 7881 / UDP 7882、App 原生播放器及云端推流 venv；显式重试，不自动切截图 |
| 修改执行环境 TOML 不生效 | 已持久化定义优先；不要直接改 SQLite 重绑机器，使用新工作区重新配置 |
