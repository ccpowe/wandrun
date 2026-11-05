import { useRef, useState, type ReactNode } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import { Uniwind, useCSSVariable } from 'uniwind';
import { ArrowDown, Check, ChevronRight } from 'lucide-react-native';
import { AgentMessageContent } from '@/components/chat/agent-message-content';
import { ChatFade } from '@/components/chat/chat-fade';
import { CHAT_FLOATING_SURFACE } from '@/components/chat/chat-surface';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { ProgressRow } from '@/components/chat/progress-row';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useMountEffect } from '@/lib/use-mount-effect';

export type ChatSketchTheme = 'light' | 'dark';

function ThemeMount({ theme, children }: { theme: ChatSketchTheme; children: ReactNode }) {
  useMountEffect(() => {
    const previous = Uniwind.currentTheme;
    Uniwind.setTheme(theme);
    return () => Uniwind.setTheme(previous);
  });
  return children;
}

const REPLY = `研究员已经看过三篇摘要，建议按这个顺序读：

1. **Agent 记忆的分层设计**：和你正在做的记忆页最相关，先读。
2. **长任务的取消与恢复**：第 4 节的状态图值得对照。
3. **工具调用的评测方法**：可以放到周末。

快速读的时候，先只看结论和图：

\`\`\`python
for paper in reading_list:
    skim(paper.abstract, paper.figures)
\`\`\`

需要的话，我可以把每篇的要点整理成一页笔记。`;

const LONG_REPLY = `三篇我都读完了，先把结论放在前面，细节按论文分开写。

**Agent 记忆的分层设计** 把记忆分成工作记忆、情节记忆和长期知识三层。工作记忆只保留当前任务需要的上下文；情节记忆按对话保存，检索时带上时间和来源；长期知识只有在多次出现、并经过确认后才写入。作者认为分层的主要好处不是省 token，而是让“该忘的”有明确的出口。

**长任务的取消与恢复** 讨论的是 Agent 执行到一半被打断时怎么办。它把每一步拆成“准备、执行、确认”三段，只有确认之后才算完成；取消时只撤回还没确认的步骤，已经确认的不重做。第 4 节的状态图和你现在的停止按钮逻辑很像，可以对照着看。

**工具调用的评测方法** 提出用固定的任务集和录制好的工具响应做回放评测，这样同一个任务可以反复比较不同提示词的效果，而不受外部服务波动影响。缺点是录制数据会过期，需要定期更新。

如果只有半小时，我建议先读第一篇的第 2、3 节，再看第二篇的状态图。`;

const EARLIER = '早上好！今天日程里有两件事：上午整理阅读清单，下午看一下定时任务的失败记录。先从阅读清单开始吧。';

/** 正式 TypingDots 依赖导航聚焦（useFocusEffect），草图没有导航容器；静态复刻同尺寸的三点。 */
export function SketchDots({ compact = false }: { compact?: boolean }) {
  const dot = compact ? 'size-1 rounded-full bg-muted-foreground' : 'size-1.5 rounded-full bg-muted-foreground';
  return <View accessible accessibilityLabel="进行中" className={compact ? 'flex-row items-center gap-0.5' : 'flex-row items-center gap-1'}>
    <View className={dot} /><View className={`${dot} opacity-60`} /><View className={`${dot} opacity-30`} />
  </View>;
}

export function UserBubble({ children }: { children: string }) {
  // Same metrics as MessageRow's user bubble; the message area is not part of this sketch.
  return <View className="max-w-[78%] self-end rounded-[20px] rounded-br-[6px] bg-muted px-3.5 py-2.5">
    <Text className="text-base text-foreground">{children}</Text>
  </View>;
}

export type ChatSketchBody = 'messages' | 'long' | 'working' | 'stopping';

/** Message area copied from the current timeline so the header and composer are judged in context. */
function Conversation({ body }: { body: ChatSketchBody }) {
  const noop = async () => {};
  if (body === 'long') return <View className="gap-5 px-4">
    <UserBubble>三篇都读完了吗？帮我总结一下</UserBubble>
    <View className="px-0.5"><AgentMessageContent text={LONG_REPLY} onSubmit={noop} /></View>
  </View>;
  return <View className="gap-5 px-4">
    <UserBubble>今天先做什么？</UserBubble>
    <View className="px-0.5"><AgentMessageContent text={EARLIER} onSubmit={noop} /></View>
    <UserBubble>帮我把这周要读的三篇论文按优先级排一下</UserBubble>
    <ProgressRow>
      {body === 'working' || body === 'stopping' ? <SketchDots /> : <Icon as={Check} className="size-4 text-muted-foreground" />}
      <Text numberOfLines={1} className="shrink text-sm">{body === 'working' || body === 'stopping' ? '委派 研究员 · 进行中' : '委派 研究员 · 已完成'}</Text>
      <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
    </ProgressRow>
    {body === 'working' || body === 'stopping' ? null : <View className="px-0.5"><AgentMessageContent text={REPLY} onSubmit={noop} /></View>}
    {/* chat.B5：底部工作行显示“正在停止…”。 */}
    {body === 'stopping' ? <ProgressRow><SketchDots /><Text className="text-sm text-muted-foreground">正在停止…</Text></ProgressRow> : null}
  </View>;
}

/**
 * 顶部长过渡（2026-10-31 用户选定）：从状态栏下就开始变淡；透明标题那一段保留约 88% 底色，
 * 正文只透出很淡的影子；顶栏下方再用 40 慢慢淡出。草图手机框不含状态栏，statusBar 为 0。
 */
function TopFade({ top, statusBar = 0 }: { top: number; statusBar?: number }) {
  const background = String(useCSSVariable('--color-background'));
  const height = top + 40;
  return <LinearGradient pointerEvents="none"
    colors={[background, background, `${background}E0`, `${background}99`, `${background}00`]}
    locations={[0, statusBar / height, (top - 4) / height, (top + 14) / height, 1]}
    style={{ position: 'absolute', left: 0, right: 0, top: 0, height }} />;
}

/** 键盘示意高度：静态草图不弹真实键盘，只看输入框在键盘上方的间距与层次；真实避让由正式页面的 keyboard-controller 负责。 */
const KEYBOARD_HEIGHT = 280;
const KEYBOARD_GAP = 8;

/** 393 宽手机框：时间线在下，顶栏与输入框浮在上面，和正式页面一样共用上下渐隐。 */
export function ChatSketchFrame({ theme, header, composer, composerBottom = 12, body = 'messages', content, blank, overlay, keyboard = false, readOld = false }: {
  theme: ChatSketchTheme;
  /** 替代默认时间线的消息区（富消息方向草图用）；给出时从顶部开始看，不自动滚到底。 */
  content?: ReactNode;
  header: ReactNode;
  /** 零 Agent 等不显示输入框时为空。 */
  composer?: ReactNode;
  composerBottom?: number;
  body?: ChatSketchBody;
  /** 空白新对话 / 空状态：不渲染时间线，内容在顶栏与输入框之间居中。 */
  blank?: ReactNode;
  /** 顶栏下展开的浮层（子对话卡片），覆盖在时间线与渐隐之上。 */
  overlay?: ReactNode;
  keyboard?: boolean;
  /** chat.C4 阅读旧消息：不贴底（停在顶部），输入框上方显示回到最新。 */
  readOld?: boolean;
}) {
  const { height } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const [headerHeight, setHeaderHeight] = useState(60);
  const [composerHeight, setComposerHeight] = useState(48);
  const bottom = keyboard ? KEYBOARD_HEIGHT + KEYBOARD_GAP : composerBottom;
  const bottomSpace = (composer ? composerHeight : 0) + bottom;
  return <ThemeMount key={theme} theme={theme}><GestureHandlerRootView style={{ flex: 1 }}>
    <View className="flex-1 items-center justify-center bg-border">
      <View testID="sketch-phone-frame" className="overflow-hidden bg-background" style={{ width: 393, height: Math.min(812, height - 112) }}>
        {blank ? <View className="absolute inset-0 items-center justify-center px-8" style={{ paddingTop: headerHeight, paddingBottom: bottomSpace + 24 }}>{blank}</View>
        : <ScrollView ref={scroll} showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: headerHeight + 12, paddingBottom: bottomSpace + 16 }}
          onContentSizeChange={() => { if (!readOld && !content) scroll.current?.scrollToEnd({ animated: false }); }}>
          {content ?? <Conversation body={body} />}
        </ScrollView>}
        <TopFade top={headerHeight} />
        {/* 底部只在输入条上方留 24 轻过渡：字段本身不透明，+ 在字段内，没有悬空图标需要垫底。 */}
        {composer ? <ChatFade edge="bottom" height={bottomSpace + 24} solidHeight={bottom} /> : null}
        <View className="absolute inset-x-0 top-0" onLayout={({ nativeEvent }) => setHeaderHeight(nativeEvent.layout.height)}>{header}</View>
        {overlay ? <View className="absolute inset-x-0" style={{ top: headerHeight }}>{overlay}</View> : null}
        {readOld && composer ? <View className="absolute inset-x-0 items-center" style={{ bottom: bottomSpace + 12 }}>
          {/* 回到最新：悬浮在内容上的小圆按钮，card + 聊天浮层阴影、无描边；40 视觉，hitSlop 补 48。 */}
          <SurfacePressable accessibilityRole="button" accessibilityLabel="回到最新消息" hitSlop={4}
            className="size-10 items-center justify-center rounded-full bg-card" style={CHAT_FLOATING_SURFACE}>
            <Icon as={ArrowDown} size={20} />
          </SurfacePressable>
        </View> : null}
        {composer ? <View className="absolute inset-x-0" style={{ bottom }}
          onLayout={({ nativeEvent }) => setComposerHeight(nativeEvent.layout.height)}>{composer}</View> : null}
        {keyboard ? <View accessibilityLabel="系统键盘（示意）" className="absolute inset-x-0 bottom-0 items-center justify-center bg-muted" style={{ height: KEYBOARD_HEIGHT }}>
          <Text variant="caption" className="text-muted-foreground">系统键盘（示意）</Text>
        </View> : null}
      </View>
    </View>
  </GestureHandlerRootView></ThemeMount>;
}
