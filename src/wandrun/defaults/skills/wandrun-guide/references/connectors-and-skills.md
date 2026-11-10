# MCP 连接器与技能

App 基线：0.2.0；提交 `3226bed53ef73a60fc13d02fb440693979078077`；核对日期 2026-11-05。

## 区别

连接器通过 MCP 接入外部工具 / 服务；技能提供操作说明及资源。添加连接器、完成授权、测试可用、允许某 Agent 使用，是不同步骤。安装技能也不会自动为 Agent 勾选。提示词写“使用某服务”不能凭空获得它。

## 添加 MCP 连接器

入口：对话抽屉 › **设置 / Settings** › **连接器 / Connectors**。

- **可用 / Available**：网关提供的目录服务。点需要的服务 / “连接 / Connect”进入详情，按其声明方式连接：OAuth 在手机系统浏览器登录授权，GitHub 短码按页面指引输入，Key 型在 App 填密钥。实际目录有哪些服务以该服务器为准，不凭手册保证一长串产品全部可用。
- **已添加 / Added**：已配置连接器，点行看详情、工具、连接状态和参数。
- 自定义：页面右上 **＋** › **远程地址 / Remote URL** 或 **本地命令 / Local command**。没有单独“设置 › 应用”入口。

### 自定义远程服务

1. 在“添加远程连接器 / Add remote connector”填写 **网址 / URL**（服务提供的 MCP 地址，不是普通网站首页）。
2. 按服务选择 **认证方式 / Authentication**：**无需认证 / No authentication**、**密钥 / Key**、OAuth。地址失焦可能建议方式，最终按真实服务要求，不根据 URL 猜“肯定免密”。
3. Key 按服务要求填写请求头，如 Authorization / Bearer；OAuth 不在这里填静态请求头。“高级 / Advanced”可设自动 / Streamable HTTP / SSE；OAuth 需 Streamable HTTP。默认自动足够时不用展开。
4. 点 **连接 / Connect**；OAuth 按 App 打开的手机浏览器完成授权。遇到不支持预注册应用 / 安全 OAuth 的提示就如实解释，不伪造回调或自建账号绕开。

### 自定义本地服务

＋ › 本地命令 › 填 **命令（含参数）/ Command with arguments** 与所需 **环境变量 / Environment variables** › 连接。命令运行在网关服务器，不是手机，也不是每个 Agent 的云端执行环境；服务器需已有对应程序。引号 / 转义须完整，别把整条 shell 管道当作保证支持的命令格式。

密钥只在 App 对应密钥栏输入，不让用户贴进聊天。OAuth 授权是 App / 系统浏览器流程，不与 Agent 执行浏览器任务的“接管”混为一谈。授权链接、短码、回调仅按 App 指引在发起设备处理；不要求聊天公开凭据。

## 让某 Agent 真正用上它

连接成功后：抽屉 › Agent › 该 Agent 资料 › 右上铅笔 › **连接器 / Connectors** › 勾选该项 › 选携带方式 › **完成 / Done** › 主表单 **保存 / Save**。

| 中文 / English | 含义 |
|---|---|
| 直接携带 / Include directly | 首次请求即加载该服务全部工具 |
| 按需搜索 / Search on demand | Agent 在本服务工具目录内找到后才加载，不是互联网搜索；需连接器有说明 |
| 参数待重启生效 / Restart required for new settings | 活跃连接的静态连接参数修改需网关重启；当前测试可能仍用旧运行参数 |
| 测试连接 / Test connection | 测试当前已保存的连接，不能证明每个业务动作必定成功 |

同一服务不能同时直接携带和按需搜索。连接器详情“已连接的 Agent / Connected Agents”是只读使用者列表，不能在那里勾选授权。需要补说明时在连接器详情“编辑 / Edit”修改名字 / 说明；连接参数从“连接参数 / Connection settings”查看 / 修改，目录管理的字段可能只读。

删除连接器需确认，会从受影响 Agent 里移除引用，不删除 Agent。OAuth / Key 的断开不等于删除；服务方远端撤销失败时需用户到服务方设置核对，不把本地清除说成远端已撤销。

## 导入 / 使用技能

**不是**设置页上传。用户在聊天中把 `SKILL.md`、技能压缩包或下载链接交给带 skill-installer 的 **Local Agent**，让它按 installer 技能检查并安装。默认 wandrun 带此技能；不执行来路不明包的脚本，重名先取得替换同意，不能借安装去找网关令牌。

安装后：设置 › **技能 / Skills** 打开或下拉刷新确认；再到对应 Agent 编辑 › 技能 › 勾选 › 完成 › 主表单保存。导入成功不等于已授权该 Agent。新选择 / 更新在下一次执行边界生效，不要求用户为默认 Local 的每次勾选重启网关。

设置技能页没有 ＋、上传按钮或聊天导入快捷按钮，只有底部提示在聊天把技能发给 Agent。可看正文、位置、修改时间、使用者；App 不直接编辑 SKILL.md。

- **系统内置 / Built in**：如网关自动提供的 `wandrun-ui` 协议技能，随 Wandrun 更新，不可在 App 编辑 / 删除。
- **我的技能 / My skills**：workspace 技能；首次默认复制的 browser、skill-installer、wandrun-guide 也属于这里，不因“随包提供”就变成不可删除的系统能力技能。
- 只有未被 Agent 使用的 workspace 技能可删除，先到使用它的 Agent 编辑取消勾选并保存；删除是整个技能目录及文件，不是只清一条选择。
- 不假定默认提供 news-brief、agent-device 或 Reader；本手册不承诺未配置的第三方依赖存在。
