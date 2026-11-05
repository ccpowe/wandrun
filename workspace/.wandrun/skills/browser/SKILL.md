---
name: browser
description: 使用 agent-browser 在当前任务专属的浏览器页面中浏览、阅读、搜索、填写与交互；需要当前执行环境已接入浏览器。
---

# 任务浏览器

运行时为已接入浏览器的任务注入 `WANDRUN_BROWSER_CDP`（任务专属 CDP 接入地址）和
`AGENT_BROWSER_SESSION`（含租约代际的会话名）。**每次**在当前任务的 `exec_command` 或
Code Mode `execute` 中运行 `agent-browser --cdp "$WANDRUN_BROWSER_CDP" …`；
不要覆盖会话名，不要使用原始 Chrome CDP 端口、工作区中的旧 `agent-browser.json` 配置或其他任务的地址。
命令环境由运行时按真实 task_id 注入，无需手动设置变量。Local 连接外部已启动的 Chrome；
Instabox 通过宿主网关的同一租约关口连接环境内的共享 Chrome。
若 `WANDRUN_BROWSER_CDP` 未注入或为空，停止浏览器操作并说明执行环境尚未配置浏览器；
不要回退到默认端口或旧配置，也不要手动设置启动变量。
第一次使用前可运行 `agent-browser skills get core` 了解命令。

**Instabox 的 Chrome 不可达或 agent-browser 不存在（command not found）时运行启动脚本。** 仅当运行时已注入 `WANDRUN_BROWSER_PORT` 和
`WANDRUN_BROWSER_PROFILE` 时，运行 `python3 "$WANDRUN_BROWSER_START"`；
`WANDRUN_BROWSER_START` 是运行时注入的远端真实脚本路径，不猜宿主工作区路径。
若未提供该路径，可用 `python3 "<本技能目录>/scripts/start_browser.py"`，按下文方式定位本技能目录。
Local 不注入这些启动变量：Chrome 不可达时说明外部浏览器不可用，不运行启动脚本。
脚本用 Python 标准库与已有 npm / uv，先确保固定版本 CLI 和视频推流依赖可用，再复用或启动 Chrome。
CLI 安装在环境持久目录 `/data/home/wandrun-browser/agent-browser/`（运行时已加入 PATH）；
视频依赖固定为 `livekit==1.2.0`、`pillow==13.0.0`、`websockets==17.4`，装在
`/data/home/wandrun-browser/video-publisher/venv/`，不进入任务 Python 环境。
两类依赖各用独立安装锁、暂存目录与原子发布，失败保留上一份；依赖导入 / 版本校验通过才发布。
已有依赖就复用，不下载 Chrome；运行时只启动推流程序，绝不安装软件。安装失败会明确说明原因。
它再取得 Chrome 文件锁并检查真实 CDP 发现响应，已就绪即复用；否则以 headless 模式启动，
通过独立 session 和三路标准流重定向脱离当前命令。CLI 与视频依赖的安装锁、每条安装命令各最多 180 秒；
Chrome 启动锁及就绪等待各最多 10 秒，
可用 `--timeout <秒>` 调整；Chrome 启动失败会明确返回私有 `chrome.log` 路径，不把超时当作成功。
脚本创建的 profile 目录权限为 0700，日志与启动锁为 0600；失败的新启动会收尾，不结束已有 Chrome。
可执行文件探测顺序：先 `/usr/lib/chromium/chromium`，再 PATH 中的
`chromium`、`chromium-browser`、`google-chrome`、`google-chrome-stable`。
启动成功后仍只经 `WANDRUN_BROWSER_CDP` 操作，不使用启动端口直连。

**新建页面前先检查。** 首次连接，以及 `open` 新标签、`tab new` 等建页操作前，
在当前执行环境运行 `python3 "<本技能目录>/scripts/browser_status.py"`：
用技能目录中公布的本次 `SKILL.md` 绝对路径的父目录替换占位符，不猜宿主路径。
Local 使用本机技能路径，Instabox 使用分发后的远端技能路径；脚本检查其所在环境的内存。
可加 `--json`；退出码 0 表示检查完成（可能有提示），2 表示无法完整检查，须说明原因。
可用内存低于 1 GiB 或有效总量的 15% 会提示：先关闭自己不再需要的页面，
或告知用户情况后再决定。达到页面上限时如实说明，不绕开接入点。
脚本只读状态、不分配租约；内存阈值只是提示，不是限制，也不代替服务端最终裁决。

客户端真正连接时才分配租约并建首页；第一次快照使用运行时创建的页面。不另起任务专用浏览器。
首页、自己新建的页面、人的新建页和弹窗共用本环境 Chrome 的总页面上限。
达到上限立即拒绝、不排队；创建中、结果未知或关闭未确认仍占额度，如实告诉用户。
自己的页面与弹窗在 `tab list` 中可见，其他任务的页面不可见。
CDP 接入只支持显式附加的扁平会话（`flatten=true`）及已列入白名单的方法；
自动附加、嵌套消息和浏览器级全局操作明确拒绝，不要绕过拒绝直连 Chrome。
初始化失败会报告实际原因；确认清理后可在下次连接重新分配。

1. **先快照再操作。** `agent-browser --cdp "$WANDRUN_BROWSER_CDP" snapshot -i`
   得到当前引用；跳转、切换页面、超时或命令中断后重新快照。长页面可用
   `-c`、`-d <深度>`、`-s <选择器>` 缩小快照，用 `get text <选择器>` 取长文字。
2. **常规人机验证先自行尝试。** 先快照／截图观察，按页面提示正常点击勾选框、等待检查、
   拖动滑块或选图；提交验证后失败计 1 次，最多 2 次，单个验证从开始尝试起总计最多 3 分钟，
   到任一上限即请求接管并说明已尝试的操作。可用 `screenshot`、`mouse move <x> <y>`、
   `mouse down`／`mouse up` 或 `drag <源> <目标>`（均带上述 CDP 参数）观察和操作。
   不使用第三方打码／解题服务，不注入脚本伪造或绕过验证令牌，不直连原始 CDP，
   不为此修改浏览器指纹。仍失败，或遇到登录（账号密码、扫码、短信／2FA）、付款、
   账号安全设置、需要用户本人判断或确认的内容时，调用 `request_takeover(reason)`，
   说明需要完成什么及已尝试的操作，然后等待；无需指定某个“桌面角色”。
   接管中浏览器写入会被拒绝；任务没有被取消，也不要重试写入。
   接管先拒绝新写入，再等待 Chrome 已接收的命令结算；“收回未确认”不是接管成功。
   超时后可稍后重试；若提示连接断开导致无法确认，关闭该租约后重新打开，不必重启宿主。
   人的输入按整组手势尽力而为：已知导航会拒绝该组，与发送同时发生的导航不保证隔离。
   交还释放输入失败时仍由人控制，可重试交还；收到成功交还通知后才恢复操作。
3. **交还后重新确认。** 运行时通知发送给持有浏览器的当前任务。先
   `agent-browser --cdp "$WANDRUN_BROWSER_CDP" tab list --json`，用实际 targetId
   选定自己的页面，再快照核对状态；不要从旧位置或旧引用直接继续。页面可能已关闭；
   下一次使用被关闭的租约时，按返回原因向用户说明。
   若收到“接管结束，页面已关闭”，此次等待已结束；不要继续使用旧页面或旧代际。
   连接中断或平台恢复同样结束旧现场，不续用旧页面，也不重放中断的操作。
   用户已明确要求重新打开时，核对一次结束提示后，在**新一次终端调用**中重新打开；
   运行时会给出新租约。它是新现场，不是旧操作的自动重试。
4. **完成时关闭自己的页面。** 工作结束且用户不再需要观看，或用户要求放弃时，用
   `agent-browser --cdp "$WANDRUN_BROWSER_CDP" tab close` 关闭自己的页面。
   当前 CLI 拒绝关闭最后一张页；先从 `tab list --json` 取得实际 `targetId`，再用
   `curl --fail-with-body "$WANDRUN_BROWSER_CDP/json/close/<targetId>"` 关闭最后一页
   （把占位符替换为真实 targetId）。这是任务接入点的 CDP 关闭路径，同样检查页面归属、
   控制状态与代际；最后一张确认关闭后释放租约与页面额度。不另开新页规避 CLI 限制。
   用户仍要查看或接管时保留页面，等待期间不要因为一轮结束而关闭。
   Chrome 属于执行环境，任务结束不关闭它；不要执行浏览器级清理、`close --all`、杀死 Chrome。
5. **不可撤销的操作先确认。** `eval` 默认只做只读提取；修改网页、发起请求、
   下载文件、提交表单、付款或修改账号设置前先取得用户明确同意。不读取、转述密码：
   不对密码框执行 `get value`；若必须检查是否填写，只返回布尔值而非内容或长度。
