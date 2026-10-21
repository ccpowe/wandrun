This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Regression on the phone

Run from the repo root with Metro (8081) and the gateway (8765) already running; the runner never restarts either service. An adb-connected Android phone, Expo Go, `agent-device` 0.21.16 and at least one Agent are required.

```bash
python3 mobile/e2e/run.py --list       # groups and coverage; no phone operations
python3 -m unittest discover -s mobile/e2e -p test_run_logic.py  # runner safety guards; no phone operations
python3 mobile/e2e/run.py home drawer  # selected groups, in the supplied order
python3 mobile/e2e/run.py              # all groups
```

定时页面可独立复测：`python3 mobile/e2e/run.py schedules`。该组会真实调用模型创建一至两分钟后的单次定时，并等待同一定时完成真实模型回复；临时 Agent、定时和对话由本组清理。UI 输入使用 ASCII 测试文本，真机无需切换测试输入法；中文模型请求通过 API 发送。停机错过的后端验证不在手机脚本里执行，脚本仍不负责停止网关。

若网关使用非默认 workspace，设置 `E2E_WORKSPACE` 为网关 `--workspace` 的同一本机路径，并用 `GATEWAY_URL` 指向该网关。记忆与文件组的外部文件编辑/删除场景需要直接访问该目录；默认仍为仓库的 `workspace/`，不根据端口猜测目录。App 的“网关连接”也必须切到同一服务，非默认端口要先配置对应 `adb reverse`；runner 不替 App 切换连接。例如隔离验收：`GATEWAY_URL=http://127.0.0.1:18765 E2E_WORKSPACE=/tmp/wandrun-qa python3 mobile/e2e/run.py`。临时盘配额不足时，用 `E2E_ARTIFACTS` 将本轮产物写到有空间的位置；不要在已占用设备的会话中改变 `TMPDIR`，它会改变 agent-device 的会话存储位置。

| Group / YAML in `mobile/e2e/` | Coverage |
| --- | --- |
| `home` | Home rows, swipe to hide/unhide, + menu and dismissal, All Agents |
| `drawer` | Conversation drawer, new/switch/back, rename with keyboard, delete current and non-current conversations |
| `profile` | Chat Agent/name/title header, profile tabs, member navigation/return, empty members |
| `memory` | 真实网关的 Markdown 查看/全屏编辑、并发冲突保留草稿、重新加载、真实模型委派修改的“已记住”根对话跳转及浅深色截图 |
| `schedules` | 定时列表/全屏新建编辑、列表启停与重新启用、每周/Cron 编辑、外部更新保留草稿、真实模型工具创建及同一定时到点完成、运行记录/首页/来源/对话跳转、删除及浅深色截图 |
| `files` | 真实模型相对路径交付、聊天附件卡片、Markdown 原文件预览与来源返回、当前 Agent/全局搜索、删对话保留文件、删除原文件后不可用及浅深色截图；系统分享面板另做人工验收 |
| `upload` | 系统文件选择 → tus 上传 → 纯附件用户消息 → 复用文件卡片与预览页，浅深色截图；仅此组的选择步骤允许 DocumentsUI，按根目录语义节点匹配 Downloads／下载／下载内容，独占夹具及文件登记在结束时清理。 |
| `agent` | Blank-template creation, prompt/model/skills/member editors, name/reasoning edits, external updates, referenced-Agent deletion blocking, unblock/cancel/delete, external deletion |
| `settings` | 设置、订阅额度与 Agent 用量、默认模型档位保存并用于新建表单、Agent 切换模型档位再恢复 |
| `connectors` | 设置 › 连接器浅深色、UI 添加远程 DeepWiki / 测试与密钥只写、Agent 直接选择与使用关系、阻止删除 / 解除引用后删除、外部增改删及编辑页删除返回 |
| `skills` | 设置技能计数、正常/错误目录、只读详情与 Agent 资料、引用删除冲突/解除/删除、外部删除事件刷新、默认入口预填草稿未发送及浅深色截图；夹具由 `E2E_WORKSPACE` 下独占目录持有并清理 |
| `pairing` | 隔离网关上的管理取码、App 手输配对、首页/关于与连接浅深色、自撤销回连接页与旧令牌 401；仅临时桥接内存保存兑换令牌，结束恢复原开发连接并撤销本组设备。扫码/权限弹窗的人工清单在 pairing.yaml；本组需管理凭据与开发令牌 |
| `browser` | 真实 browser 技能 Agent 打开隔离本机测试页；聊天卡片、观看、接管输入、交还系统行、资料电脑、设置电脑与左滑关闭整租约；浅深色截图。要求网关已连接独立 Chrome、有空闲槽位；runner 不启动 Chrome，结束只清理本组资源 |

Each group owns and removes its temporary conversations/Agents and can run alone or in any combination/order. Settings saves the original global defaults and restores them in `finally`; it derives choices from the live catalog rather than naming model IDs or effort levels. The runner derives gateway/Metro `adb reverse` ports from `GATEWAY_URL` and `EXPO_URL` (defaults: 8765/8081), repairs missing mappings, and records before/after mappings in `reverse.json` and `result.json` without restarting Metro or the gateway. The drawer reuses a real replied conversation; if none exists, it seeds one with “只回复好的” and retains that shared baseline. Profile always creates its own parent/member Agents and conversations so both light/dark computer empty-state checks are isolated from user leases. App opening and shared setup/final restoration happen once per invocation; a failed group is reported and the remaining groups still run. Every phone operation checks the foreground: only the system launcher permits reopening Expo Go; another app stops phone operations and forbids screenshots. Backend cleanup can still proceed safely.

Each group captures its key pages in light and dark mode (visual evidence, not pixel assertions). Use semantic targets (`testID` / labels), never coordinates, and condition-based waits rather than fixed sleeps. `result.json`, per-group JSON, screenshots and `commands.log` are written under the printed artifact directory (`E2E_ARTIFACTS` can select a fresh directory). Terminal/JSON results include each group's PASS/FAIL, elapsed seconds and screenshot paths; total time includes shared setup and cleanup. Any group/setup/cleanup failure exits nonzero. Final restoration sets light mode, puts all Agents on home and returns the App to home, unless foreground safety forbids phone operations; restoration errors are reported rather than hidden.

During development, run the groups related to the changed behaviour; before committing, run all groups. New pages still require visual review against the design boards. After acceptance, add their regression to the corresponding page/function group above, or create a new independent YAML and register its coverage/fixture preparation in `run.py` when none fits. Update the flow in the same change as accepted behaviour.

OAuth 回归分层：`tests/test_gateway_oauth.py` 使用受控本地 HTTP OAuth/MCP peer，`tests/test_github_device_oauth.py` 在集成／存储边界模拟服务方响应；`node --test test/oauth_ui.test.ts`（在 `mobile/` 执行）验证授权界面状态。它们不依赖真实账号，也不代表真实服务方端到端验收。`run.py` 当前 19 组不包含 Notion／GitHub 的真实登录与同意授权。

真实服务方的首次授权、拒绝及二次验证按需单独验收；有效授权的只读调用、自动刷新与冷启动复用不要求重新登录。复用验收应由同一专用测试网关持有私有 state，不默认在每轮结束时撤销；撤销场景使用独立绑定，不把同一 refresh token 复制到并行实例，凭据不得进入 Git 或报告。

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

### Offline diagrams and formulas

- Structured `Mermaid` uses `rich-message/mermaid.tsx` and the existing `media-viewer` route; ordinary Markdown Mermaid fences remain code. Do not restore gateway PNG rendering.
- `render-budget.ts` and `render-visibility.ts` are shared with KaTeX: four committed renderers globally, FIFO cancellation, no offscreen prefetch. Remove the frame before returning its permit. Extra eligible blocks can wait indefinitely; the existing full-screen route releases the unfocused chat's frames.
- `mermaid-page` owns platform resource publication/disposal; `mermaid-document` owns source/bridge policy. The UTC day belongs to one render identity, including delayed completion. Keep source as inert JSON and SVG inside the restricted document.
- `MermaidViewer` owns native code/preview selection. Inline is a static 320-logical-pixel fit: no zoom/pan, viewport snapshots or separate expand control. Only the whole preview opens full screen; source/header do not. Reject moved, multi-touch and cancelled releases without claiming gestures from chat, while preserving non-touch accessibility activation. Full screen starts preview+fit and alone owns zoom/one-finger pan/controls. Code view removes the frame before releasing its permit; only full screen restores a matching layout/day/viewport snapshot. Do not add HTML controls or a second gesture owner.
- Update fixed source `rich-message/mermaid-renderer.js`, then run `node scripts/generate-pele-assets.mjs` from `mobile/`; never hand-edit generated native/Web assets. `pele` is pinned to 1.6.0; no CDN.
- Use `test/mermaid_component.test.ts`, `mermaid_resources.test.ts`, `math_budget.test.ts` and the `rich` device group for relevant regression. The dev-only `dev/rich-preview` includes local, invalid, tall, wide, and mixed scenarios; it is not a substitute for persisted-chat/full-screen verification.

### Browser surfaces

- `src/app/browser-viewer.tsx` 与 `browser-takeover.tsx` 是独立观看 / 全屏操作路由；正式界面在 `src/browser/`，不再使用实验桥地址。
- `src/browser/protocol.ts` / `stream.ts` 对接网关二进制 JPEG、显示 ACK、页面与控制代际；`pages.ts` 保存跨连接的最后确认页，路由参数仅用于首次选页，页面消失时回退。每个已显示帧都按当前视口限制指针。原型已验证的手势、坐标和键盘缓冲逻辑继续复用，网页新页面不自动抢走当前画面。
- `gateway/session.ts` 用全局 SSE 与带 `as_of_seq` 的浏览器任务快照维护共享状态；聊天同一租约只占一张卡片，`takeover.ended` 保留系统行。待接管红点独立于消息已读；`gateway/agents.ts` 仅在浏览器事件的 `entered_requested` 为真时触发首页活动重拉。
- `components/agent-computer-tab.tsx` 和 `app/settings-computer.tsx` 按 `entry_agent_id` 汇总页面（不是持有 Agent）；资料与设置的页面行均可左滑并确认关闭整租约，包括该租约的全部页面。`components/browser-thumbnail.tsx` 仅前台、聚焦且卡片可见时低频取鉴权截图。
- 关闭最后一页时，非 human 租约释放；human 接管中的租约保留零页，仍可在当前接管代际新建页面。零页交还会关闭租约，空闲超时也可关闭（超时设为 0 时禁用）。零页不能发送页面输入。横竖屏、软键盘和触控手感需在协调好的设备上验证；协议烟测不能替代原生视觉验收。


## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## 界面文案标准（2026-10-16 用户确定）

App 和网关下发给 App 显示的文字都按此写。

1. 标题写对象，按钮写动作；“确认”说不清后果时改成具体动作。
2. 默认不加说明小字；只为当前需要知道的条件、范围、生效时机或恢复方式补一句。
3. 一条提示只讲当前这一步，不预讲下一层规则，不解释“这里会显示什么”。
4. 普通说明尽量一句；风险提示（删除范围、不能恢复、草稿保留、整任务关闭）不限字数，不能漏。
5. 错误先说影响，再给当前能做的动作；结果未确认就写“未确认”。
6. 用用户看得见的对象和入口，少用实现名词（基线、快照、网关计算、内部路径）。
7. 同一概念同一叫法；文案里提到的入口必须与实际导航一致。
8. 可见文字与无障碍文字分开评判，不因屏幕上已显示就删 a11y。
9. 为双语准备：按完整句子写，变量与格式另记，避免用片段拼句。

## Keyboard avoidance

- Use `react-native-keyboard-controller` (`KeyboardProvider` in the root layout, `KeyboardAvoidingView` / `KeyboardEvents` in screens). Do not hand-roll keyboard insets from RN `Keyboard` events.
- Why: the app is edge-to-edge, so the system does not make room for the keyboard, and RN's numbers live in different coordinate systems. Measured on Android 16 (Xiaomi, Expo Go, 2026-10-08): screen 852.9dp, keyboard `height` 229.8 (excludes the gesture bar), `insets.bottom` 16, `screenY` 607.1 (screen coordinates), root `measureInWindow` y −46.8 (window coordinates, counted from below the status bar). Converting between them is fragile and iOS follows different rules.
- `KeyboardProvider` is set to `statusBarTranslucent navigationBarTranslucent`, so the library's `height` includes the bottom bar (same as iOS). Keep the bottom inset at `insets.bottom` when closed and 0 when open.
