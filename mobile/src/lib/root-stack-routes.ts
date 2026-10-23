// Declare every file route; undeclared routes are otherwise added without protection by Expo Router.
export const sharedScreens = [
  { name: "connect", options: { title: "连接电脑", headerShown: false } },
  { name: "gateway-connection", options: { title: "关于与连接", headerShown: false } },
  { name: "settings-appearance", options: { title: "外观", headerShown: false } },
] as const;

// No navigation entry; deep links are accepted only by a development build.
export const developmentScreens = [
  { name: "dev/rich-preview", options: { title: "富交互预览", headerShown: false } },
  { name: "dev/attachment-preview", options: { title: "附件预览", headerShown: false } },
] as const;

export const authenticatedScreens: readonly {
  name: string;
  options?: { title?: string; headerShown?: boolean };
}[] = [
  { name: "index", options: { title: "首页" } },
  { name: "agents", options: { title: "全部 Agent" } },
  { name: "agents/[id]" },
  { name: "agent-editor" },
  { name: "agent-capabilities" },
  { name: "settings", options: { title: "设置", headerShown: false } },
  { name: "settings-about-you", options: { title: "关于你", headerShown: false } },
  { name: "settings-models", options: { title: "模型", headerShown: false } },
  { name: "settings-computer" },
  { name: "settings-connectors" },
  { name: "settings-apps" },
  { name: "apps/[id]" },
  { name: "settings-skills" },
  { name: "skill-detail" },
  { name: "builtin-skill-detail" },
  { name: "connector-editor" },
  { name: "c/[id]", options: { title: "" } },
  { name: "search", options: { headerShown: false } },
  { name: "files/[id]", options: { headerShown: false } },
  { name: "media-viewer", options: { headerShown: false } },
  { name: "video-player", options: { headerShown: false } },
  { name: "memory-editor" },
  { name: "memory-detail" },
  { name: "schedule-editor" },
  { name: "browser-viewer" },
  { name: "browser-takeover" },
  { name: "ui-demo", options: { title: "UI 底座" } },
];
