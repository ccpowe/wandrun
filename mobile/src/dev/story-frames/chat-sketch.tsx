import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { AlertCircle, ArrowUp, Camera, ChevronLeft, ChevronUp, CirclePlay, FileText, Image as ImageIcon, Images, Menu, Plus, RotateCw, SquarePen, WifiOff, X } from 'lucide-react-native';
import { TextInput, View } from 'react-native';
import { EmptyState } from '@/components/empty-state';
import { StatusBanner } from '@/components/status-banner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { Text } from '@/components/ui/text';
import { WandrunAvatar } from '@/components/wandrun-avatar';
import { ListGroup } from '@/components/list-group';
import { ListRow } from '@/components/list-row';
import { ChatSketchFrame, SketchDots, type ChatSketchBody, type ChatSketchTheme } from './chat-sketch-frame';

const AGENT = { id: 'editor', name: '资讯主编', avatar: 2 };
const LONG_AGENT = { id: 'long', name: '每日科技资讯与论文阅读主编', avatar: 2 };
const RESEARCHER = { id: 'researcher', name: '研究员', avatar: 0 };
const EXECUTOR = { id: 'executor', name: '执行者', avatar: 4 };
const TITLE = '本周阅读清单';
const DESCRIPTION = '每天整理值得关注的新闻和文章';
const QUOTE = '研究员已经看过三篇摘要，建议按这个顺序读：1. Agent 记忆的分层设计：和你正在做的记忆页最相关，先读。';

/**
 * 输入行统一的竖直度量：单行文字 body 20 高，上下留白让文字中心与左右按钮中心落在同一条线上；
 * 按钮 items-end 贴底，多行增长时仍贴着最后一行。
 */
function ComposerInput({ defaultValue, placeholder = '说点什么', editable = true }: { defaultValue?: string; placeholder?: string; editable?: boolean }) {
  return <TextInput multiline placeholder={placeholder} defaultValue={defaultValue} editable={editable} aria-label="消息"
    placeholderTextColorClassName="accent-muted-foreground"
    className="min-w-0 flex-1 text-body text-foreground"
    style={{ paddingVertical: 10, lineHeight: 20, includeFontPadding: false, textAlignVertical: 'center' }} />;
}

/* ---------- 定稿 B：透明顶栏 + 平铺输入 ---------- */

function QuietIconButton({ icon, label, disabled = false }: { icon: LucideIcon; label: string; disabled?: boolean }) {
  // 禁用只换灰色图标（chat.A6 空白对话禁用新对话），不叠 Button 的 50% 透明。
  return <Button intent="quiet" size="icon" aria-label={label} accessibilityState={{ disabled }}>
    <Icon as={icon} size={24} className={disabled ? 'text-muted-foreground/60' : 'text-foreground'} />
  </Button>;
}

/** 现有子对话数量圆标的静态复刻（正式 ChildCountBadge 未导出）；展开时换成上箭头。 */
function ChildBadge({ count, expanded, attention }: { count: number; expanded: boolean; attention: boolean }) {
  return <View accessible accessibilityLabel={`${count} 个子对话`} className="relative size-6 items-center justify-center rounded-full bg-muted">
    {expanded ? <Icon as={ChevronUp} size={14} /> : <Text className="text-xs font-medium">{count}</Text>}
    {attention ? <View className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-destructive" /> : null}
  </View>;
}

type HeaderProps = {
  agent?: typeof AGENT;
  subtitle?: string;
  working?: boolean;
  pressed?: boolean;
  /** 空白新对话：新对话按钮禁用（chat.A6）。 */
  blank?: boolean;
  childCount?: number;
  /** 有子对话需要处理（如等你接管）时圆标带红点。 */
  childAttention?: boolean;
  expanded?: boolean;
  /** 协作子对话：左上返回主对话，不放新对话（chat.I8 / H2）。 */
  child?: boolean;
  /** 零 Agent：只有抽屉与灰色新对话，没有胶囊（chat.J4）。 */
  noAgent?: boolean;
  banner?: ReactNode;
};

export function Header({ agent = AGENT, subtitle = TITLE, working = false, pressed = false, blank = false, childCount = 0, childAttention = false, expanded = false, child = false, noAgent = false, banner }: HeaderProps) {
  // I1：卡片展开时左右按钮一起淡化（2026-10-28 用户修正）。
  const sides = expanded ? 'opacity-40' : '';
  return <View>
    <View className="flex-row items-center gap-1 px-1 pt-1">
      <View className={sides}>{child ? <QuietIconButton icon={ChevronLeft} label="返回主对话" /> : <QuietIconButton icon={Menu} label="对话列表" />}</View>
      <View className="min-w-0 flex-1 items-center">
        {noAgent ? null : <View className="max-w-full flex-row items-center">
          {/* 名称区只做一件事：点按进资料。无静态表面，按下时 7% 叠层显出全圆可点范围。 */}
          <SurfacePressable accessibilityRole="button" accessibilityLabel={`查看${agent.name}资料`} pressedPreview={pressed}
            className="min-h-12 min-w-0 shrink flex-row items-center gap-2.5 rounded-full px-3">
            <WandrunAvatar index={agent.avatar} alt={agent.name} size={28} />
            <View className="min-w-0 shrink">
              <Text variant="body" className="font-medium" numberOfLines={1}>{agent.name}</Text>
              <View className="min-w-0 flex-row items-center gap-1">
                {working ? <SketchDots compact /> : null}
                <Text className="min-w-0 shrink text-xs text-muted-foreground" numberOfLines={1}>{subtitle}</Text>
              </View>
            </View>
          </SurfacePressable>
          {/* 子对话提醒是独立按钮：只有点它才展开子对话列表；视觉 24，hitSlop 补到 48。 */}
          {childCount ? <Button intent="quiet" size="icon" aria-label={expanded ? '收起子对话' : `${childCount} 个子对话`} hitSlop={6}
            className="-ml-1 size-9 min-h-0">
            <ChildBadge count={childCount} expanded={expanded} attention={childAttention} />
          </Button> : null}
        </View>}
      </View>
      {/* 子对话没有新对话按钮，留同宽空位让胶囊居中。 */}
      <View className={sides}>{child ? <View className="size-12" /> : <QuietIconButton icon={SquarePen} label="新对话" disabled={blank || noAgent} />}</View>
    </View>
    {banner ? <View className="mt-1">{banner}</View> : null}
  </View>;
}

function SendButton({ ready }: { ready: boolean }) {
  return ready
    ? <Button intent="primary" size="icon" aria-label="发送" hitSlop={8} className="mb-1 size-8 min-h-0">
      <Icon as={ArrowUp} size={18} className="text-primary-foreground" />
    </Button>
    // 不可发送：只留灰箭头，不画实心；muted 字段里再叠 soft 灰底会看不见。
    : <Button intent="quiet" size="icon" aria-label="发送" accessibilityState={{ disabled: true }} hitSlop={8} className="mb-1 size-8 min-h-0">
      <Icon as={ArrowUp} size={18} className="text-muted-foreground" />
    </Button>;
}

/** 工作中且无待发内容：描边停止（design.md §7）；描边是按钮语义，不是表面边框。 */
function StopButton({ stopping = false }: { stopping?: boolean }) {
  // chat.B5 正在停止：按钮禁用，描边与方块转灰；进度由时间线底部“正在停止…”说明。
  return <Button intent="quiet" size="icon" aria-label="停止这一轮" accessibilityState={{ disabled: stopping }} hitSlop={8}
    className={`mb-1 size-8 min-h-0 border-[1.5px] ${stopping ? 'border-muted-foreground/40' : 'border-foreground'}`}>
    <View className={`size-2.5 rounded-[2px] ${stopping ? 'bg-muted-foreground/40' : 'bg-foreground'}`} />
  </Button>;
}

function QuoteDraft() {
  return <View className="flex-row items-start gap-1 pl-4 pr-1 pt-2">
    <View className="min-w-0 flex-1 border-l-2 border-muted-foreground/30 pl-2.5 pt-1">
      <Text variant="caption" numberOfLines={2} className="text-muted-foreground">{QUOTE}</Text>
    </View>
    <Button intent="quiet" size="icon" aria-label="取消引用" hitSlop={8} className="size-8 min-h-0">
      <Icon as={X} size={16} className="text-muted-foreground" />
    </Button>
  </View>;
}

function RemoveDot() {
  return <View accessibilityRole="button" accessibilityLabel="移除附件" className="absolute -right-1.5 -top-1.5 size-5 items-center justify-center rounded-full bg-muted-foreground">
    <Icon as={X} size={12} className="text-background" />
  </View>;
}

/** 附件草稿放在字段内顶部，card 小卡与 muted 字段区分；不再单独描边。 */
function AttachmentDraftsSketch({ failed = false }: { failed?: boolean }) {
  if (failed) return <View className="flex-row gap-2.5 px-2.5 pt-2.5">
    <View className="size-14 items-center justify-center rounded-md bg-card">
      <Icon as={ImageIcon} size={20} className="text-muted-foreground" />
      <RemoveDot />
    </View>
    {/* chat.B9：失败只用红字说明，不再红框；重试为卡内图标按钮。 */}
    <View className="h-14 max-w-[220px] flex-row items-center gap-2 rounded-md bg-card pl-3 pr-1">
      <Icon as={FileText} size={20} className="text-muted-foreground" />
      <View className="min-w-0 shrink">
        <Text variant="caption" numberOfLines={1}>分层记忆设计.pdf</Text>
        <Text className="text-xs text-destructive" numberOfLines={1}>上传失败</Text>
      </View>
      <Button intent="quiet" size="icon" aria-label="重试上传" hitSlop={4} className="size-10 min-h-0">
        <Icon as={RotateCw} size={18} />
      </Button>
      <RemoveDot />
    </View>
  </View>;
  return <View className="flex-row gap-2.5 px-2.5 pt-2.5">
    <View className="size-14 items-center justify-center rounded-md bg-card">
      <Icon as={ImageIcon} size={20} className="text-muted-foreground" />
      <RemoveDot />
    </View>
    <View className="h-14 max-w-[200px] flex-row items-center gap-2 rounded-md bg-card px-3">
      <Icon as={FileText} size={20} className="text-muted-foreground" />
      <View className="min-w-0 shrink">
        <Text variant="caption" numberOfLines={1}>分层记忆设计.pdf</Text>
        <Text className="text-xs text-muted-foreground">上传中 42%</Text>
      </View>
      <RemoveDot />
    </View>
  </View>;
}

type ComposerProps = {
  draft?: string;
  working?: boolean;
  quote?: boolean;
  attachments?: boolean;
  /** 协作子对话不提供附件（chat.H2 / B11）。 */
  textOnly?: boolean;
  /** chat.B9：有附件上传失败。 */
  failedUpload?: boolean;
  stopping?: boolean;
  /** chat.B7：附件菜单展开（静态复刻正式 filled 菜单）。 */
  menu?: boolean;
  /** 空白页离线发送失败：文字留在输入框，字段内就地提示（用户 2026-10-31）。 */
  sendFailed?: boolean;
};

/** chat.B7：与正式 DropdownMenuContent surface="filled" 同款（card、lg、柔和阴影、52 行、20 灰细图标），静态放在 + 上方。 */
function AttachmentMenu() {
  const items = [{ icon: Camera, label: '相机' }, { icon: Images, label: '照片' }, { icon: CirclePlay, label: '视频' }, { icon: FileText, label: '文件' }];
  return <View className="absolute left-3 w-[176px] overflow-hidden rounded-lg bg-card py-1.5 shadow-sm shadow-foreground/5" style={{ bottom: '100%', marginBottom: 8, elevation: 3 }}>
    {items.map(item => <SurfacePressable key={item.label} accessibilityRole="menuitem" accessibilityLabel={item.label} className="min-h-[52px] flex-row items-center gap-3 px-4">
      <Icon as={item.icon} size={20} className="text-muted-foreground" />
      <Text variant="body">{item.label}</Text>
    </SurfacePressable>)}
  </View>;
}

export function SketchComposer({ draft, working = false, quote = false, attachments = false, textOnly = false, failedUpload = false, stopping = false, menu = false, sendFailed = false }: ComposerProps) {
  const placeholder = working ? '补充要求' : '说点什么';
  // 上传未完成 / 失败不能发送（chat.B8 / B9）。
  const action = draft && !attachments && !failedUpload ? 'send' : working && !draft ? 'stop' : 'disabled';
  // + 在字段内左侧（2026-10-31 用户选定，参考 ChatGPT）：字段外没有悬空图标，底部渐隐可以很短。
  return <View className="relative px-3">
    {menu ? <AttachmentMenu /> : null}
    <View className="min-h-10 min-w-0 rounded-[20px] bg-muted">
      {quote ? <QuoteDraft /> : null}
      {attachments || failedUpload ? <AttachmentDraftsSketch failed={failedUpload} /> : null}
      {sendFailed ? <View accessibilityRole="alert" className="flex-row items-center gap-1.5 pl-4 pr-3 pt-2.5">
        <Icon as={AlertCircle} size={14} className="text-destructive" />
        <Text className="text-xs text-destructive">发送失败，恢复连接后再发送</Text>
      </View> : null}
      <View className={`flex-row items-end pr-1 ${textOnly ? 'pl-4' : 'pl-1'}`}>
        {textOnly ? null : <Button intent="quiet" size="icon" aria-label="添加附件" hitSlop={8} className="mb-1 size-8 min-h-0">
          <Icon as={Plus} size={22} />
        </Button>}
        <View className={`min-w-0 flex-1 ${textOnly ? '' : 'pl-1'}`}><ComposerInput defaultValue={draft} placeholder={placeholder} /></View>
        {action === 'stop' ? <StopButton stopping={stopping} /> : <SendButton ready={action === 'send'} />}
      </View>
    </View>
  </View>;
}

/**
 * chat.B12 / C7 就地提示：沿用 StatusBanner 外观，关闭改为横幅内右侧的 × 按钮（G7 关闭方式待确认，
 * 草图提出这一种；正式需给 StatusBanner 加可选 trailing 操作）。
 */
function LocalNotice({ title, description }: { title: string; description: string }) {
  return <View className="relative">
    <StatusBanner icon={AlertCircle} title={title} description={description} accessibilityRole="alert" />
    <View className="absolute bottom-2 right-4 top-0 justify-center">
      <Button intent="quiet" size="icon" aria-label="关闭提示" hitSlop={4} className="size-10 min-h-0">
        <Icon as={X} size={18} className="text-muted-foreground" />
      </Button>
    </View>
  </View>;
}

const PICKER = [EXECUTOR, RESEARCHER, AGENT, { id: 'planner', name: '规划师', avatar: 1 }, { id: 'writer', name: '写作者', avatar: 3 }];

/**
 * 空白新对话的 Agent 选择器（键盘收起时）：默认居中上一个对话的 Agent，左右滑或点两侧头像切换；
 * 第一条消息发出即确认。静态帧只画居中态，滑动 / 环形由正式实现沿用已认可的轮播手感。
 */
function AgentPicker() {
  return <View className="items-center gap-2">
    <View accessibilityRole="adjustable" accessibilityLabel={`选择 Agent，当前 ${AGENT.name}`} className="mb-3 flex-row items-center gap-3">
      {PICKER.map((agent, index) => {
        const distance = Math.abs(index - 2);
        const size = distance === 0 ? 88 : distance === 1 ? 52 : 40;
        return <View key={agent.id} className={distance === 0 ? '' : distance === 1 ? 'opacity-60' : 'opacity-30'}>
          <WandrunAvatar index={agent.avatar} alt={agent.name} size={size} />
        </View>;
      })}
    </View>
    <Text className="w-full text-center text-xl font-semibold" numberOfLines={2}>{AGENT.name}</Text>
    <Text variant="caption" className="text-center text-muted-foreground">{DESCRIPTION}</Text>
  </View>;
}

/** 加附件后 Agent 已确认（对话已在电脑上建好）：选择器两侧消失，只留居中 Agent，不能再切换。 */
function LockedAgent() {
  return <View className="items-center gap-2">
    <WandrunAvatar index={AGENT.avatar} alt={AGENT.name} size={88} className="mb-3" />
    <Text className="w-full text-center text-xl font-semibold" numberOfLines={2}>{AGENT.name}</Text>
    <Text variant="caption" className="text-center text-muted-foreground">{DESCRIPTION}</Text>
  </View>;
}

/** 键盘弹起：选择器收起，只留当前 Agent 的小头像与名字，把空间让给输入。 */
function PickedAgent() {
  return <View className="items-center gap-2">
    <WandrunAvatar index={AGENT.avatar} alt={AGENT.name} size={52} />
    <Text variant="body" className="font-medium">{AGENT.name}</Text>
  </View>;
}

const TASKS = [
  { member: EXECUTOR, title: '整理阅读笔记模板', status: '等你接管', time: '刚刚', attention: true, working: false },
  { member: RESEARCHER, title: '核对三篇论文的发表时间', status: '进行中', time: '2 分钟前', attention: false, working: true },
  { member: RESEARCHER, title: '检索相关综述', status: '已完成', time: '10:42', attention: false, working: false },
];

/**
 * 子对话列表：用标准分组列表（design.md §3.5，`ListGroup` filled + inset、`ListRow` 默认紧凑双行 60），
 * 与设置 / 资料页同一套；不放“子对话 N”标题。浮在聊天内容上，外层加菜单同款柔和阴影；宽 320 居中，不铺满。
 */
function ChildCard() {
  // 菜单式窄浮层：宽 320（不超过容器），居中挂在顶栏圆标下方，不再左右铺满。
  return <View className="mt-1 w-[320px] max-w-full self-center rounded-lg bg-card shadow-sm shadow-foreground/5" style={{ elevation: 3 }}>
    <ListGroup surface="filled" divider="inset" className="-mx-4 mt-0">
      {TASKS.map(task => <ListRow key={task.title} title={task.title} alert={task.attention}
        leading={<WandrunAvatar index={task.member.avatar} alt={task.member.name} size={28} />}
        trailing={task.working ? <SketchDots compact /> : undefined}
        subtitle={<Text numberOfLines={1} className="shrink">{task.member.name} · {task.status} · {task.time}</Text>} />)}
    </ListGroup>
  </View>;
}

function ZeroAgent() {
  return <View className="self-stretch flex-1">
    <EmptyState title="还没有 Agent" description="新建一个 Agent，就可以和它聊天">
      <Button intent="soft"><Text>新建 Agent</Text></Button>
    </EmptyState>
  </View>;
}

export type ChatSketchState =
  | 'ready' | 'pressed' | 'long' | 'draft' | 'blank' | 'blankLocked' | 'blankKeyboard'
  | 'working' | 'stopping' | 'readOld' | 'menu' | 'uploadFailed' | 'localNotice' | 'targetMissing' | 'blankSendFailed' | 'quote' | 'attachments' | 'keyboard' | 'childrenCollapsed' | 'childrenQuiet' | 'children' | 'child' | 'childNested' | 'longTitle' | 'offline' | 'zero';

type Scene = { header: HeaderProps; composer?: ComposerProps; body?: ChatSketchBody; blank?: ReactNode; overlay?: ReactNode; keyboard?: boolean; readOld?: boolean };

/** 每个状态只描述与平时不同的部分；表现约定见 chat.md 对应编号。 */
const SCENES: Record<ChatSketchState, Scene> = {
  ready: { header: {}, composer: {} },
  pressed: { header: { pressed: true }, composer: {} },
  long: { header: {}, composer: {}, body: 'long' },
  draft: { header: {}, composer: { draft: '帮我把第一篇的要点整理成一页笔记，重点写清楚为什么要分三层' } },
  blank: { header: { blank: true, subtitle: '新对话' }, composer: {}, blank: <AgentPicker /> },
  blankLocked: { header: { subtitle: '新对话' }, composer: { attachments: true }, blank: <LockedAgent /> },
  blankKeyboard: { header: { blank: true, subtitle: '新对话' }, composer: {}, blank: <PickedAgent />, keyboard: true },
  working: { header: { working: true }, composer: { working: true }, body: 'working' },
  stopping: { header: { working: true }, composer: { working: true, stopping: true }, body: 'stopping' },
  readOld: { header: {}, composer: {}, readOld: true },
  menu: { header: {}, composer: { menu: true } },
  uploadFailed: { header: {}, composer: { failedUpload: true, draft: '帮我看看这两份材料' } },
  localNotice: { header: { banner: <LocalNotice title="无法添加附件" description="无法读取所选文件" /> }, composer: {} },
  targetMissing: { header: { banner: <LocalNotice title="消息不存在" description="已加载全部历史，未找到目标消息。" /> }, composer: {} },
  blankSendFailed: {
    header: { blank: true, subtitle: '新对话', banner: <StatusBanner icon={WifiOff} title="连接断开，正在重连…" /> },
    composer: { draft: '帮我整理这周要读的论文', sendFailed: true }, blank: <AgentPicker />,
  },
  quote: { header: {}, composer: { quote: true } },
  attachments: { header: {}, composer: { attachments: true, draft: '帮我看看这两份材料' } },
  keyboard: { header: {}, composer: { draft: '好的，先读第一篇' }, keyboard: true },
  childrenCollapsed: { header: { childCount: 3, childAttention: true }, composer: {} },
  childrenQuiet: { header: { childCount: 2 }, composer: {} },
  children: { header: { childCount: 3, childAttention: true, expanded: true }, composer: {}, overlay: <ChildCard /> },
  child: { header: { child: true, agent: RESEARCHER, subtitle: `${AGENT.name} 发起 · ${TITLE}` }, composer: { textOnly: true } },
  /** 子对话自己也委派了下级：同一套圆标，点它展开下级列表（chat.I8“有下级则可继续进入”）。 */
  childNested: { header: { child: true, agent: RESEARCHER, subtitle: `${AGENT.name} 发起 · ${TITLE}`, childCount: 1 }, composer: { textOnly: true } },
  /** 长名称与长对话名：名称、对话名各一行截断，圆标与左右按钮不被挤走。 */
  longTitle: { header: { agent: LONG_AGENT, subtitle: '帮我把这周要读的三篇论文按优先级排一下，并整理成一页笔记', childCount: 12, childAttention: true }, composer: {} },
  offline: { header: { banner: <StatusBanner icon={WifiOff} title="连接断开，正在重连…" /> }, composer: {} },
  zero: { header: { noAgent: true }, blank: <ZeroAgent /> },
};

export function ChatSketch({ state = 'ready', theme = 'light' }: { state?: ChatSketchState; theme?: ChatSketchTheme }) {
  const scene = SCENES[state];
  return <ChatSketchFrame theme={theme} body={scene.body} blank={scene.blank} overlay={scene.overlay} keyboard={scene.keyboard} readOld={scene.readOld}
    header={<Header {...scene.header} />} composer={scene.composer ? <SketchComposer {...scene.composer} /> : undefined} />;
}
