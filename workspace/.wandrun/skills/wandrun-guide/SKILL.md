---
name: wandrun-guide
description: Wandrun App 使用手册，解释聊天与富交互、创建 Agent 与好提示词、团队委派、浏览器观看和接管、定时、MCP 连接器、技能、执行环境、记忆及服务器。用户问 Wandrun 是什么、在哪里操作、某字段含义或怎样使用时读取；普通日常任务无需先读整本手册。
---

# Wandrun 使用手册

App 基线：0.2.0，源码提交 `3226bed53ef73a60fc13d02fb440693979078077`，核对日期 2026-11-05。

这是产品使用事实，不是用户当前配置、授权、机器或任务状态的证明。按下面索引只读相关主题，路径相对本技能目录；不一次加载所有文件。标签写作“中文 / English”，回复时选用户界面对应的一种，不把整张标签表抄给用户。界面不同先核对用户所见，不凭旧手册猜按钮。

| 用户想做什么 | 读取 |
|---|---|
| 第一次使用、发消息/附件、换 Agent、搜索、富交互、文件下载 | [start-and-chat.md](references/start-and-chat.md) |
| 创建/编辑 Agent、字段含义、起草好提示词、团队成员与委派 | [agents-and-teams.md](references/agents-and-teams.md) |
| 观看浏览器、接管、登录/付款、交还、关闭页面 | [browser.md](references/browser.md) |
| 定时创建、查看/暂停/编辑/删除、时区、运行记录 | [schedules.md](references/schedules.md) |
| 添加 MCP、应用授权、给 Agent 勾选、导入/删除技能 | [connectors-and-skills.md](references/connectors-and-skills.md) |
| Local/Instabox、服务器资源、配对切换、模型额度、App 语言 | [environments-and-server.md](references/environments-and-server.md) |
| 记住/忘记、关于你、Agent 工作记忆、索引和详情编辑 | [memory.md](references/memory.md) |

只给当前目标需要的路径与下一步。手册中的“点”“保存”是让用户操作，不代表你已代办。Agent 配置由用户在 App 修改；你可起草文本，但不改 TOML 或调用未提供接口代建 Agent。浏览器实际操作读 browser 技能；富交互组件用运行时提供的 wandrun-ui 技能，不在此手册发明协议。
