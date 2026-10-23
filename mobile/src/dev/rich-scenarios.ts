// Design-board examples, kept outside the route so the same Specs can be used in smoke checks.
type Node = { type: string; props: Record<string, unknown>; children: Node[] };
type PreviewSpec = {
  root: string;
  elements: Record<string, { type: string; props: Record<string, unknown>; children: string[] }>;
  state: Record<string, unknown>;
};
const node = (type: string, props: Record<string, unknown> = {}, ...children: Node[]): Node => ({ type, props, children });
function spec(root: Node, state: Record<string, unknown> = {}): PreviewSpec {
  const elements: PreviewSpec["elements"] = {};
  let count = 0;
  function visit(value: Node): string {
    const id = `n${count++}`;
    elements[id] = { type: value.type, props: value.props, children: value.children.map(visit) };
    return id;
  }
  return { root: visit(root), elements, state };
}
const card = (title: string, ...children: Node[]) => node("Card", { title }, ...children);
const fence = (value: PreviewSpec) => `\n\n\`\`\`wandrun-ui\n${JSON.stringify(value)}\n\`\`\`\n\n`;

const travel = spec(card("选一个方案",
  node("ChoiceGroup", { stateKey: "plan", label: "你选了", options: [
    { value: "lake", label: "杭州西湖两日", tags: ["¥1,280", "2 天"], description: "高铁 1 小时，景点集中；周末人多" },
    { value: "mountain", label: "莫干山民宿", tags: ["¥1,450", "2 天"], description: "安静、适合休息；需要自驾或包车" },
    { value: "city", label: "留在城里", tags: ["¥600", "1 天"], description: "美术馆加咖啡馆，不用赶路" },
  ] }),
  node("TextInput", { stateKey: "note", label: "补充要求（可选）", placeholder: "可选", multiline: true }),
  node("Submit", { label: "提交选择" }),
), { plan: "mountain", note: "想住带院子的，周六下午出发" });

const weekly = spec(card("周报设置",
  node("Segmented", { stateKey: "length", label: "篇幅", options: [
    { value: "short", label: "简短" }, { value: "standard", label: "标准" }, { value: "long", label: "详细" },
  ] }),
  node("MultiSelect", { stateKey: "sources", label: "资料来源（多选）", variant: "chips", options: [
    { value: "official", label: "官方博客" }, { value: "papers", label: "论文" },
    { value: "social", label: "社交媒体" }, { value: "podcast", label: "播客" },
  ] }),
  node("Switch", { stateKey: "screenshots", label: "配图使用原帖截图" }),
  node("Slider", { stateKey: "tone", label: "语气：正式 ↔ 轻松", min: 0, max: 1, step: 0.1 }),
  node("TextInput", { stateKey: "extra", label: "另外想写的", placeholder: "可选" }),
  node("Submit", { label: "开始写" }),
), { length: "standard", sources: ["official", "papers"], screenshots: true, tone: 0.7, extra: "" });

const appointment = spec(card("预约体检",
  node("DateInput", { stateKey: "date", label: "日期" }),
  node("ChoiceGroup", { stateKey: "time", label: "时段", options: [
    { value: "8", label: "08:00 – 09:00", description: "剩 2 个" },
    { value: "9", label: "09:00 – 10:00", description: "剩 5 个" },
    { value: "10", label: "10:00 – 11:00", description: "已约满", disabled: true },
  ] }),
  node("TextInput", { stateKey: "note", label: "备注" }), node("Submit", { label: "提交预约意向" }),
), { date: "2026-10-20", time: "9", note: "需要空腹项目" });

const files = spec(card("选择要发送的文件",
  node("MultiSelect", { stateKey: "files", variant: "checklist", options: [
    { value: "plan", label: "方案说明.pdf", note: "2.1 MB" },
    { value: "quote", label: "报价单.xlsx", note: "86 KB" },
    { value: "image", label: "效果图.png", note: "4.3 MB" },
    { value: "cost", label: "内部成本测算.xlsx", note: "120 KB" },
    { value: "minutes", label: "会议纪要.md", note: "9 KB" },
  ] }), node("Submit", { label: "确认文件选择" }),
), { files: ["plan", "quote", "image"] });

const display = spec(node("Stack", { gap: "md" },
  card("发布进展",
    node("Status", { title: "发布 v1.4", badge: { text: "进行中", tone: "active" }, progress: 60, caption: "部署 3 / 5 台 · 约 4 分钟" }),
    node("Steps", { items: [
      { label: "构建镜像", state: "done", note: "2 分 10 秒" },
      { label: "运行测试", state: "done", note: "318 项通过" },
      { label: "部署 3 / 5 台", state: "current", note: "约 4 分钟" },
      { label: "线上验证", state: "todo" },
    ] })),
  card("本周任务",
    node("Metrics", { items: [{ label: "已完成", value: "12", hint: "本周累计" }, { label: "进行中", value: "3" }, { label: "失败", value: "1" }] }),
    node("Table", { columns: ["任务", "负责", "状态"], rows: [
      ["公众号周报", "writer", { badge: { text: "已完成", tone: "neutral" } }],
      ["竞品价格整理", "search_agent", { badge: { text: "进行中", tone: "active" } }],
      ["发票归档", "executor", { badge: { text: "失败", tone: "error" } }],
    ] })),
));

const steps = spec(card("步骤条 · 长说明与失败",
  node("Steps", { items: [
    { label: "构建镜像", state: "done", note: "镜像已构建并上传，测试环境已经完成准备。" },
    { label: "运行测试", state: "done" },
    { label: "部署服务", state: "current", note: "正在逐台部署并等待健康检查，每台服务都需要确认可用后才会继续下一台。" },
    { label: "同步附件", state: "failed", note: "远端连接已断开，附件未能同步。恢复连接后需要重新运行这一步，已部署的服务不受影响。" },
    { label: "线上验证", state: "todo", note: "等待前面的步骤完成。" },
  ] })));

const detail = spec(card("dev-box",
  node("Stack", { direction: "horizontal", gap: "sm" },
    node("Heading", { text: "电脑状态" }), node("Badge", { text: "在线", tone: "neutral" })),
  node("Text", { text: "一切正常，负载不高。" }), node("Divider"),
  node("KeyValue", { items: [
    { label: "系统", value: "Ubuntu 26.04" }, { label: "CPU", value: "8 核 · 23%" },
    { label: "内存", value: "9.6 / 32 GB" }, { label: "浏览器槽位", value: "1 / 2 在用" },
    { label: "网关运行", value: "3 小时 12 分" },
  ] }), node("Progress", { value: 30, caption: "内存使用 30%" }),
  node("Text", { text: "失败状态示例", tone: "muted" }),
  node("Steps", { items: [{ label: "发票归档", state: "failed", note: "邮箱登录已过期" }] }),
));

const trend = spec(card("近一周趋势",
  node("LineChart", { title: "任务完成数", xLabels: ["周一", "周二", "周三", "周四", "周五"],
    series: [{ name: "已完成", values: [12, 18, 15, 24, 29] }, { name: "新增", values: [8, 13, 12, 19, 21] },
      { name: "待办变化", values: [-4, -5, -3, -5, -8] }], unit: "项" })));
const comparison = spec(card("渠道效果",
  node("BarChart", { title: "咨询量", labels: ["官网", "社群", "搜索", "活动"], values: [45, 72, 38, 56], unit: "次" })));
const maximumLine = spec(card("折线容量边界 · 24 点 × 3 系列",
  node("LineChart", { xLabels: Array.from({ length: 24 }, (_, index) => `L${index + 1}`),
    series: [1, 2, 3].map((series) => ({
      name: `系列 ${series}`, values: Array.from({ length: 24 }, (_, index) => (index + 1) * series),
    })) })));
const maximumBar = spec(card("柱状容量边界 · 12 项",
  node("BarChart", { labels: Array.from({ length: 12 }, (_, index) => `B${index + 1}`),
    values: Array.from({ length: 12 }, (_, index) => index + 1) })));
const portions = spec(card("预算构成",
  node("PieChart", { title: "支出占比", items: [
    { label: "住宿", value: 3200 }, { label: "交通", value: 1800 },
    { label: "餐饮", value: 1200 }, { label: "其他", value: 800 },
  ], unit: "元" })));
const disclosure = spec(card("发布信息",
  node("Tabs", { tabs: [{ label: "概览" }, { label: "详情" }, { label: "截图" }] },
    node("Stack", {}, node("Text", { text: "部署 3 / 5 台，整体进展 60%。" }),
      node("Accordion", { title: "查看当前问题", defaultOpen: false },
        node("Text", { text: "暂无阻塞项，剩余两台等待健康检查。" }))),
    node("Accordion", { title: "版本详情", defaultOpen: true },
      node("KeyValue", { items: [{ label: "版本", value: "v1.4" }, { label: "环境", value: "生产" }] })),
    node("Stack", {}, node("Text", { text: "检查项：响应时间、错误率、回滚条件。" }),
      node("Image", { attachment: "preview.png", alt: "两只小生物举着一张白纸", caption: "上线报告的附件图片示例。" })))));
const gridState = spec(card("换列保留展开状态",
  node("Grid", { columns: 2 }, ...["第一项", "第二项"].map((title) =>
    node("Accordion", { title: `${title}详情` },
      node("Text", { text: `${title}仍保持展开` }),
      node("Table", { columns: ["项目", "状态"], rows: [[title, "待确认"]] }))))));
const picture = spec(card("设计预览",
  node("Image", { attachment: "preview.png", alt: "两只小生物举着一张白纸", caption: "已交付图片的示意。点击真实消息图片会打开原文件。" })));
const networkImage = spec(card("地球实拍",
  node("Image", { url: "https://upload.wikimedia.org/wikipedia/commons/9/97/The_Earth_seen_from_Apollo_17.jpg",
    alt: "阿波罗17号拍摄的地球", caption: "来源示例；仅真实网关消息可加载代理图片。" })));
const mediaLayout = spec(node("Stack", {},
  node("MediaCard", { attachment: "preview.png", alt: "两只小生物举着一张白纸", title: "横排图文卡片",
    description: "较窄视口下标题与文字保持可读。", tags: ["附件", "本消息"], direction: "horizontal" }),
  node("MediaCard", { attachment: "preview.png", alt: "两只小生物举着一张白纸", title: "竖排图文卡片", direction: "vertical" }),
  node("Gallery", { items: [
    { attachment: "preview.png", alt: "第一张示意图片", caption: "第一张" },
    { attachment: "preview.png", alt: "第二张示意图片", caption: "第二张" },
    { attachment: "preview.png", alt: "第三张示意图片", caption: "第三张" },
  ] })));
const mermaidPreview = spec(card("流程图", node("Mermaid", {
  source: "flowchart LR\n  A[收到消息] --> B{校验}\n  B -->|通过| C[显示]",
  title: "消息处理流程",
})));
const mermaidInvalid = spec(node("Mermaid", { source: "flowchart LR\n  A -->", title: "语法错误" }));
const mermaidTall = spec(node("Mermaid", {
  title: "30 步纵向流程",
  source: "flowchart TD\n" + Array.from({ length: 29 }, (_, i) => `N${i}[步骤 ${i + 1}] --> N${i + 1}[步骤 ${i + 2}]`).join("\n"),
}));
const mermaidWide = spec(node("Mermaid", {
  title: "18 步横向流程",
  source: "flowchart LR\n" + Array.from({ length: 17 }, (_, i) => `N${i}[环节 ${i + 1}] --> N${i + 1}[环节 ${i + 2}]`).join("\n"),
}));
const mermaidMixed = spec(node("Stack", {}, ...Array.from({ length: 6 }, (_, index) =>
  card(`本地图表 ${index + 1}`, node("Mermaid", {
    source: `flowchart LR\n  A[消息 ${index + 1}] --> B[模型判断] --> C[回复]`,
  }), node("Math", { tex: `E_${index + 1}=mc^2`, display: true })))));

const semanticColors = spec(card("语义颜色 · 状态与数据",
  node("Stack", { direction: "horizontal", gap: "sm" },
    ...["neutral", "active", "success", "warning", "error", "info"].map((tone) => node("Badge", { text: tone, tone }))),
  node("Table", { columns: ["检查", "状态"], rows: [
    ["连接", { badge: { text: "成功", tone: "success" } }],
    ["容量", { badge: { text: "接近上限", tone: "warning" } }],
    ["版本", { badge: { text: "新版本可用", tone: "info" } }],
  ] }),
  node("LineChart", { xLabels: ["低值", "高值"], series: [
    { name: "精确小数", values: [0.000000123456789, 0.000000987654321] },
    { name: "负数", values: [-0.000000223456789, -0.000000887654321] },
  ] }),
  node("BarChart", { labels: ["大数 A", "大数 B"], values: [1.23456789012345e100, 9.87654321098765e100] })));
const math = spec(card("物理公式 $E=mc^2$",
  node("Text", { text: "同一段内合并公式：速度 $v=at$，动能 $E_k=\\frac12mv^2$。不是逐公式创建视图。" }),
  node("Math", { tex: "\\int_0^t a\\tau\\,d\\tau=\\frac12at^2", display: true }),
  node("Text", { text: "文字中的块公式：\n$$F=\\frac{dp}{dt}$$\n保持上下文。" }),
  node("Badge", { text: "$F=ma$", tone: "success" }),
  node("KeyValue", { items: [{ label: "动能 $E_k$", value: "$144\\,\\mathrm{J}$" }] }),
  node("Math", { tex: "s=24\\,\\mathrm{m}。", display: true }),
  node("Math", { tex: "\\frac{1}{", display: true })));
const mathMarkdown = String.raw`速度 $v=at$ 与位移 $s=\frac12at^2$ 在同一段中排版；**能量** $E=mc^2$。

$$
\begin{pmatrix}1&2\\3&4\end{pmatrix}
$$

> 引用中的公式 $F=ma$。

- 第一项：$p=mv$。
- 第二项：$E_k=\frac12mv^2$。

| 量 | 公式 |
| --- | --- |
| 功 | $W=Fs$ |

转义美元 \$20 不应变成公式。未闭合 $x 保留源码。` + "\n\n行内代码 `$x$` 不渲染。\n\n```text\n$$x$$\n```\n\n" + fence(math);

const sources = spec(card("搜索后带来源的回答",
  node("Text", { text: "模型提供的来源不等于已经核实的事实；展开后可横滑查看，点按来源在系统浏览器打开。" }),
  node("Source", { items: [
    { title: "Expo 57", url: "https://docs.expo.dev/versions/v57.0.0/sdk/webview/" },
    { title: "KaTeX", url: "https://katex.org/docs/options" },
    { title: "Wikimedia Commons", url: "https://commons.wikimedia.org/wiki/Main_Page" },
  ] }),
  node("LinkCard", { title: "WebView · Expo SDK 57", url: "https://docs.expo.dev/versions/v57.0.0/sdk/webview/",
    description: "内置于 Expo Go；链接仅在点击后打开，不自动抓网页和图标。" })));
const components = spec(card("发布检查",
  node("Stack", { direction: "horizontal" }, node("Icon", { name: "shield-check", label: "安全检查", size: "lg" }),
    node("Heading", { text: "按步骤发布" })),
  node("List", { ordered: true, items: [
    { text: "构建并验证产物。", icon: "code-xml" },
    { text: "先灰度部署，核查失败率。", icon: "activity" },
    { text: "确认后发布；保留可回滚版本。", icon: "circle-check" },
  ] }),
  node("Grid", { columns: 2 },
    node("Callout", { tone: "info", title: "说明", text: "先 **验证** 再扩大范围。" }),
    node("Callout", { tone: "warning", title: "注意", text: "操作前运行 `backup`。" }),
    node("Callout", { tone: "success", title: "通过", text: "*健康检查*已通过。" }),
    node("Callout", { tone: "error", title: "错误", text: "检测失败时停止发布。" })),
  node("Quote", { text: "可 **回滚**，比盲目继续更重要。", attribution: "发布原则" }),
  node("Select", { stateKey: "release", label: "发布范围", options: [
    { value: "canary", label: "灰度" }, { value: "production", label: "正式" },
    { value: "locked", label: "暂不可用", disabled: true },
  ] }),
  node("Submit", { label: "确认选择" })), { release: "" });

const responsive = spec(card("窄屏回归：顶部应能完整滚入",
  node("Source", { items: [
    { title: "Google reCAPTCHA 演示与完整体验说明，长标题应换行而不是越出聊天区域", url: "https://recaptcha-demo.appspot.com/" },
    { title: "超长域名", url: "https://abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefgh.example.com/full/address" },
  ] }),
  node("Metrics", { items: [
    { label: "已完成", value: "12" }, { label: "进行中", value: "3" },
    { label: "失败", value: "1" }, { label: "待确认", value: "4" },
  ] }),
  node("Steps", { items: [{ label: "核验备份", state: "todo",
    note: "先确认备份已经完成，再逐项检查原文件与归档记录，避免删除仍在使用的文件。" }] }),
  node("Grid", { columns: 2 },
    node("LineChart", { title: "全正", xLabels: ["2020", "2021", "2022", "2023", "2024"], unit: "%",
      series: [{ name: "正值", values: [10, 12, 11, 15, 13] }] }),
    node("LineChart", { title: "全负", xLabels: ["2020", "2021", "2022", "2023", "2024"], unit: "%",
      series: [{ name: "负值", values: [-10, -9.6, -10.6, -17.2, -14] }] })),
  node("LineChart", { title: "跨零 24 点", xLabels: Array.from({ length: 24 }, (_, i) => `${2001 + i}`),
    series: [{ name: "原始值", values: Array.from({ length: 24 }, (_, i) => i - 10) }] }),
));

// Mirrors the section order of ChatGPT's self-described component showcase (2026-10-19
// screenshot) with our catalog, so both can be compared side by side on the same device.
const showcaseText = node("Stack", {},
  node("Heading", { text: "普通标题" }),
  node("Text", { text: "这是普通正文 Text，**重要信息加粗**，*补充语气斜体*，命令写作 `npm install`。" }),
  node("Text", { text: "这是弱化文字，用于说明、辅助信息和来源备注。", tone: "muted" }),
  node("Divider"),
  node("Text", { text: "公式 $E=mc^2$ 与 **粗体**共存，代码里的 `$x$` 保持原样。" }),
  node("Divider"),
  node("Stack", { direction: "horizontal", gap: "sm" },
    node("Badge", { text: "默认", tone: "neutral" }), node("Badge", { text: "成功", tone: "success" }),
    node("Badge", { text: "警告", tone: "warning" }), node("Badge", { text: "错误", tone: "error" }),
    node("Badge", { text: "信息", tone: "info" })),
  node("Divider"),
  node("Quote", { text: "好的 **UI** 不只是展示信息，还应该帮助用户完成 *操作*。" }),
  node("Math", { tex: "E=mc^2", display: true }));
const showcaseLayout = spec(card("Card / Grid / Stack",
  card("Card 卡片容器", node("Text", { text: "用于包裹一组相关的信息。", tone: "muted" }),
    node("Stack", { direction: "horizontal", gap: "sm" },
      node("Badge", { text: "Agent", tone: "neutral" }), node("Badge", { text: "React Native", tone: "neutral" }))),
  node("Metrics", { items: [{ label: "任务", value: "1,248" }, { label: "成功率", value: "98%" }, { label: "延迟", value: "320ms" }] }),
  node("Grid", { columns: 3 }, ...["模块 A", "模块 B", "模块 C"].map((text) => card(text))),
  node("Divider"),
  node("Stack", { direction: "horizontal", justify: "between" }, node("Text", { text: "左侧内容" }), node("Text", { text: "右侧内容" })),
  node("Divider"),
  node("List", { ordered: true, items: [{ text: "**分析**任务" }, { text: "调用 `工具`" }, { text: "*生成*结果" }] })));
const showcaseForm = spec(card("按钮、表单和输入",
  node("TextInput", { stateKey: "name", label: "Input 单行输入框", placeholder: "输入 Agent 名称" }),
  node("TextInput", { stateKey: "task", label: "Textarea 多行输入", placeholder: "描述你的 Agent 要执行的任务", multiline: true }),
  node("Segmented", { stateKey: "platform", label: "Segmented 分段选择", options: [{ value: "android", label: "Android" }, { value: "ios", label: "iOS" }] }),
  node("Select", { stateKey: "mode", label: "Select 下拉选择", options: [{ value: "fast", label: "快速" }, { value: "balanced", label: "均衡" }, { value: "deep", label: "深度" }] }),
  node("ChoiceGroup", { stateKey: "speed", label: "Radio Group 单选组", options: [{ value: "fast", label: "快速" }, { value: "balanced", label: "均衡" }, { value: "deep", label: "深度" }] }),
  node("Slider", { stateKey: "level", label: "Slider 滑块", min: 0, max: 100, step: 10 }),
  node("Switch", { stateKey: "experimental", label: "启用实验性功能" }),
  node("MultiSelect", { stateKey: "checks", label: "Checkbox 复选框", variant: "checklist", options: [{ value: "exp", label: "启用实验性功能" }, { value: "log", label: "保存详细日志" }] }),
  node("DateInput", { stateKey: "date", label: "Date Picker 日期选择器" }),
  node("Submit", { label: "预览配置" })),
{ name: "", task: "", platform: "android", mode: "balanced", speed: "balanced", level: 40, experimental: true, checks: ["exp"], date: "2026-10-15" });
const week = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const showcaseData = spec(card("数据图表与表格",
  node("Tabs", { tabs: [{ label: "折线" }, { label: "柱状" }, { label: "饼图" }] },
    node("LineChart", { xLabels: week, series: [{ name: "成功任务", values: [45, 62, 52, 98, 82, 120, 105] },
      { name: "失败任务", values: [8, 6, 9, 5, 7, 4, 6] }] }),
    node("BarChart", { labels: week, values: [45, 62, 52, 98, 82, 120, 105] }),
    node("PieChart", { items: [{ label: "成功", value: 564 }, { label: "失败", value: 45 }] })),
  node("Text", { text: "同一图表区域按选择切换。", tone: "muted" }),
  node("Divider"),
  node("Table", { columns: ["设备", "任务", "状态"], rows: [
    ["Android 15", "32", { badge: { text: "正常", tone: "success" } }],
    ["iOS 18", "18", { badge: { text: "待检查", tone: "warning" } }],
  ] })));
const showcaseDisclosure = spec(card("导航、弹出层与可点击容器",
  node("Accordion", { title: "查看任务详情", defaultOpen: false }, node("Text", { text: "折叠后查看 **任务** 的具体内容。" })),
  node("ChoiceGroup", { stateKey: "plan", label: "Pressable 选择卡片", options: [
    { value: "native", label: "方案 A", description: "原生 UI" }, { value: "webview", label: "方案 B", description: "WebView" }] }),
  node("Submit", { label: "选择方案" })),
{ plan: "webview" });
const showcaseMedia = spec(card("图片、图标",
  node("Grid", { columns: 3 }, ...["house", "search", "settings", "bell", "user", "cloud", "shield-check", "file-text", "code-xml",
    "calendar-days", "camera", "map-pin", "globe", "mail", "star"].map((name) => node("Icon", { name, size: "lg" }))),
  node("Text", { text: "图片与图标可在同一消息中组合。", tone: "muted" }),
  node("Gallery", { items: [{ attachment: "preview.png", alt: "示意图片一" }, { attachment: "preview.png", alt: "示意图片二" }] }),
  node("Gallery", { items: [{ attachment: "preview.png", alt: "横滑图片一" }, { attachment: "preview.png", alt: "横滑图片二" },
    { attachment: "preview.png", alt: "横滑图片三" }] })));
const showcaseMermaid = spec(node("Mermaid", { source:
  "flowchart TD\n  A[用户输入] --> B[AI Agent] --> C{选择输出}\n  C --> D[Markdown]\n  C --> E[UI Spec] --> F[json-render]\n  D --> G[Expo 消息列表]\n  F --> G" }));
const showcaseExternal = spec(card("依赖外部数据的组件",
  node("List", { items: [{ text: "**地图**与路线", icon: "map-pin" }, { text: "*视频*内容", icon: "image" },
    { text: "文件、引用和资源导航：见下方来源与链接卡片", icon: "link" }] }),
  node("Source", { items: [{ title: "Expo 57", url: "https://docs.expo.dev/versions/v57.0.0/" }] }),
  node("LinkCard", { title: "React Native Reusables", url: "https://reactnativereusables.com", description: "我们基础控件来自的 shadcn 移植。" })));
const showcase = `# Wandrun UI 组件展示册

照着 ChatGPT 展示册的顺序，用现有组件逐节展示。

## 01. 文本与排版组件
${fence(spec(card("Heading / Text / Badge / Quote / Math", showcaseText)))}
行内代码也可以放在界面块外的 Markdown：\`npm install\`。

## 02. 布局与容器组件
这部分决定界面为什么有整齐的间距和层次。
${fence(showcaseLayout)}
## 03. 按钮、表单和输入组件
${fence(showcaseForm)}
## 04. 数据图表与表格
${fence(showcaseData)}
## 05. 导航、弹出层与可点击容器
${fence(showcaseDisclosure)}
## 06. 图片、图标与 SVG 组件
${fence(showcaseMedia)}
## 07. 代码、流程图与特殊内容
${fence(showcaseMermaid)}
## 08. 其他依赖外部数据的专用组件
${fence(showcaseExternal)}`;

const linkList = spec(node("Stack", { gap: "md" },
  node("Text", { text: "按和你当前问题的关联程度排序：" }),
  node("LinkCard", { title: "React Native Storybook", url: "https://storybookjs.github.io/react-native/",
    image: "https://storybookjs.github.io/react-native/preview.png",
    tags: ["组件隔离开发", "状态预览"], description: "最值得先学的工具。重点看 Stories、Mock 数据、组件状态和 Expo 集成。" }),
  node("LinkCard", { title: "React 状态管理官方教程（中文）", url: "https://zh-hans.react.dev/learn/managing-state",
    tags: ["状态设计"], description: "状态结构、Reducer、状态提升、保留与重置状态，决定页面是否容易测试和维护。" }),
  node("LinkCard", { title: "Expo Router 文档", url: "https://docs.expo.dev/router/introduction/",
    image: "https://docs.expo.dev/assets/not-available.png", tags: ["页面路由", "导航架构"],
    description: "路由组织、Layout、动态路由、路由分组以及导航边界。" }),
  node("Text", { text: "中间的文字结束上一组，下一条是独立链接。" }),
  node("LinkCard", { title: "Expo 官方博客：如何组织一个会持续增长的 React Native 项目目录，以及 features 与 shared 的边界该怎么划",
    url: "https://expo.dev/blog", tags: ["项目结构"],
    description: "从路由、功能模块、共享 UI 到工具函数，逐层说明每个目录该放什么、不该放什么。" })));

const fileTree = spec(node("FileTree", { title: "项目结构", nodes: [
  { path: "src/features/orders/screens/", note: "业务页面" },
  { path: "src/features/orders/components/", note: "订单专用组件" },
  { path: "src/features/orders/api/", note: "请求和数据转换" },
  { path: "src/features/orders/model/", note: "类型、纯业务规则" },
  { path: "src/features/orders/fixtures/", note: "开发和测试用固定数据" },
  { path: "src/features/orders/hooks/", note: "页面逻辑" },
  { path: "src/app/", note: "路由、布局、导航组装" },
  { path: "src/features/", note: "业务能力", collapsed: false },
  { path: "src/shared/ui/", note: "跨业务基础组件" },
  { path: "src/shared/theme/", note: "设计 Token" },
  { path: "src/shared/lib/", note: "公共基础函数" },
  { path: "src/App.tsx", note: "入口" },
] }));
const longFileTree = spec(node("FileTree", { title: "项目结构", nodes: [
  { path: "src/features/customer-profile-and-loyalty-points/useLoyaltyPointsBalanceWithOptimisticUpdates.ts",
    note: "乐观更新，失败时回滚" },
  { path: "src/features/customer-profile-and-loyalty-points/", note: "会员资料、积分与等级；和订单共用地址选择，但不共用支付状态", collapsed: false },
  ...Array.from({ length: 24 }, (_, index) => ({
    path: `src/features/orders/module-${String(index + 1).padStart(2, "0")}/index.ts`,
    note: `第 ${index + 1} 组业务功能与共享模块之间的集成说明，故意写得很长以观察换行`,
  })),
  { path: "src/features/orders/", collapsed: true },
  { path: "src/shared/index.ts", note: "跨业务入口" },
] }));

type Scenario = { id: string; title: string; text: string; state: Record<string, unknown>;
  submitted?: boolean; invalid?: boolean; files?: Record<string, string>;
  attachments?: { id: string; media_type: string }[] };
export const richScenarios: Scenario[] = [
  { id: "showcase", title: "ChatGPT 对照", text: showcase, state: {},
    files: { "preview.png": "rich-preview-image" }, attachments: [{ id: "rich-preview-image", media_type: "image/png" }] },
  { id: "semantic-colors", title: "语义颜色", text: fence(semanticColors), state: semanticColors.state },
  { id: "math", title: "公式", text: mathMarkdown, state: math.state },
  { id: "math-budget", title: "500 段公式", text: "价格 $20、$30；$20和$30；USD $20–$30。\n\n" +
    Array.from({ length: 500 }, (_, index) => `第 ${index + 1} 段公式 $x^2+${index + 1}$`).join("\n\n"), state: {} },
  { id: "sources", title: "来源", text: fence(sources), state: sources.state },
  { id: "link-list-v3", title: "链接列表 v3 · 图片失败与长标题", text: fence(linkList), state: linkList.state },
  { id: "file-tree-v3", title: "目录树 v3 · 缺失父目录", text: fence(fileTree), state: fileTree.state },
  { id: "file-tree-large", title: "目录树 v3 · 超过 24 项与长注释", text: fence(longFileTree), state: longFileTree.state },
  { id: "responsive", title: "窄屏回归", text: fence(responsive), state: responsive.state },
  { id: "grid-state", title: "换列状态", text: fence(gridState), state: gridState.state },
  { id: "components", title: "P2 组件", text: fence(components), state: components.state },
  { id: "components-done", title: "Select 只读", text: fence(components), state: { release: "canary" }, submitted: true },
  { id: "line", title: "折线", text: "近一周完成趋势：" + fence(trend), state: trend.state },
  { id: "bar", title: "柱状", text: "各渠道咨询量：" + fence(comparison), state: comparison.state },
  { id: "maximum-line", title: "折线满量", text: "全部 24 点同屏，数据入口保留完整标签和值：" + fence(maximumLine), state: maximumLine.state },
  { id: "maximum-bar", title: "柱状满量", text: "横向滚动至 B12：" + fence(maximumBar), state: maximumBar.state },
  { id: "pie", title: "饼图", text: "本次活动预算：" + fence(portions), state: portions.state },
  { id: "progressive", title: "选项卡与折叠", text: "按主题查看发布状态：" + fence(disclosure), state: disclosure.state,
    files: { "preview.png": "rich-preview-image" }, attachments: [{ id: "rich-preview-image", media_type: "image/png" }] },
  { id: "image", title: "图片", text: "这张图片作为附件交付：" + fence(picture), state: picture.state,
    files: { "preview.png": "rich-preview-image" }, attachments: [{ id: "rich-preview-image", media_type: "image/png" }] },
  { id: "network-image", title: "网络图片", text: "真实图像引用示例：" + fence(networkImage), state: networkImage.state },
  { id: "media-layout", title: "图文卡与图集", text: "图文横竖排及有界横滑：" + fence(mediaLayout), state: mediaLayout.state,
    files: { "preview.png": "rich-preview-image" }, attachments: [{ id: "rich-preview-image", media_type: "image/png" }] },
  { id: "mermaid", title: "Mermaid 本地图表", text: "图表由 App 本地绘制，源码始终可以查看：" + fence(mermaidPreview), state: mermaidPreview.state },
  { id: "mermaid-invalid", title: "Mermaid 错误", text: "解析失败仍保留源码：" + fence(mermaidInvalid), state: mermaidInvalid.state },
  { id: "mermaid-tall", title: "Mermaid 长图", text: "完整预览与图内缩放：" + fence(mermaidTall), state: mermaidTall.state },
  { id: "mermaid-wide", title: "Mermaid 宽图", text: "保留横向布局：" + fence(mermaidWide), state: mermaidWide.state },
  { id: "mermaid-mixed", title: "图表与公式混排", text: "离屏图表与公式共用活跃实例预算：" + fence(mermaidMixed), state: mermaidMixed.state },
  { id: "travel", title: "选择", text: "按你的预算整理了三个方案，交通和住宿都算进去了：" + fence(travel) + "提交后我按方案查车票和住宿；也可以直接说别的想法。", state: travel.state },
  { id: "weekly", title: "周报", text: "开始前确认几个设置，不改也可以直接提交：" + fence(weekly), state: weekly.state },
  { id: "appointment", title: "日期", text: "查到两家有号，先选日期和时段：" + fence(appointment) + "提交后我去官网确认，正式预约前还会问你。", state: appointment.state },
  { id: "files", title: "清单", text: "找到 5 个文件，勾选要发的：" + fence(files) + "“内部成本测算”我默认没勾，避免发给客户。", state: files.state },
  { id: "display", title: "展示", text: "还在部署，目前没有报错：" + fence(display) + "部署完我会跑一遍线上检查再告诉你。", state: display.state },
  { id: "steps", title: "步骤条", text: fence(steps), state: steps.state },
  { id: "detail", title: "详情", text: "电脑状态如下：" + fence(detail), state: detail.state },
  { id: "submitted", title: "已提交", text: "按你的预算整理了三个方案：" + fence(travel), state: travel.state, submitted: true },
  { id: "weekly-done", title: "表单只读", text: "开始前确认几个设置：" + fence(weekly), state: weekly.state, submitted: true },
  { id: "invalid", title: "无法显示", text: '三家的报价对比如下：\n\n```wandrun-ui\n{"root":"cmp","elements":{"cmp":{"type":"Table2","props":{},"children":[]}},"state":{}}\n```\n\n最低的是乙公司，每月 ¥3,200，但不含上门安装。\n\n普通代码仍显示为代码：\n```json\n{"example":true}\n```', state: {} },
  { id: "server-invalid", title: "服务端拒绝", text: "服务端标记此块无法显示：" + fence(travel), state: travel.state, invalid: true },
];
