import { router } from "expo-router";
import { Clock, Pencil, Plus, Search, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { BackHandler, Keyboard, Pressable, ScrollView, type GestureResponderEvent, useWindowDimensions, View } from "react-native";
import { Drawer } from "react-native-drawer-layout";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button.tsx";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { TypingDots } from "./typing-dots.tsx";
import { cn } from "@/lib/utils.ts";
import { useTranslation } from "@/lib/i18n.ts";

export type DrawerConversation = {
  id: string; title: string; unread: boolean; source?: "user" | "schedule";
  kind: "conversation" | "task"; running: boolean; updatedAt: number;
  counterpart?: { name: string; avatar: number };
};

type Props = {
  /** Wraps the entire chat; the library owns the drag, overlay and animation. */
  children: ReactNode;
  /** Controlled target. onClosed is called only after this target actually finishes closing. */
  open: boolean;
  /** Flow has requested a close; block interaction until actual animation completion. */
  closing: boolean;
  onOpen(): void;
  swipeEnabled?: boolean;
  agentName: string;
  conversations: DrawerConversation[];
  collaborations: DrawerConversation[];
  loadError?: string;
  onReload(): void;
  agentId: string;
  currentId: string;
  onSelect(id: string): void;
  onNewConversation(): void;
  onRename(id: string, title: string): Promise<boolean>;
  onDelete(id: string): Promise<boolean>;
  failureMessage(): string | null;
  onRequestClose(): void;
  /** Real close completion retains the callback/Flow owner from the closing target. */
  onClosed(): void;
};

type Target = { id: string; title: string };
type Menu = Target & { top: number };

/** The library owns drawer gestures/scrim. Rows, search, menus and dialogs retain their appearance. */
export function ConversationDrawer({
  children,
  open,
  closing,
  onOpen,
  swipeEnabled = true,
  agentName,
  agentId,
  conversations,
  collaborations,
  loadError,
  onReload,
  currentId,
  onSelect,
  onNewConversation,
  onRename,
  onDelete,
  failureMessage,
  onRequestClose,
  onClosed,
}: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<"conversations" | "collaborations">("conversations");
  const groups = tab === "conversations" ? [{ title: "最近对话", rows: conversations }] : [
    { title: "进行中", rows: collaborations.filter((row) => row.running) },
    { title: "已结束", rows: collaborations.filter((row) => !row.running) },
  ];
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(300, width * 0.82);
  const configureGestureHandler = useCallback((gesture: Parameters<NonNullable<ComponentProps<typeof Drawer>["configureGestureHandler"]>>[0]) =>
    gesture.activeOffsetX([-12, 12]).failOffsetY([-10, 10])
      // iOS system-back arbitration cannot be guaranteed by JS hitSlop; keep its edge clear and verify on device.
      .hitSlop(open ? { left: 0 } : { left: -20, width: Math.max(0, width - 20) }), [open, width]);
  const drawerContent = useRef<View>(null);
  const [drawerHeight, setDrawerHeight] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const longPressed = useRef(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const operation = useRef(false);
  const openedTarget = useRef<string | null>(null);
  const titleValid = title.trim().length > 0 && Array.from(title.trim()).length <= 200;
  const openMenu = (conversation: DrawerConversation, event: GestureResponderEvent) => {
    if (!open || operation.current || conversation.kind === "task") return;
    const touchY = event.nativeEvent.pageY;
    drawerContent.current?.measureInWindow((_x, y) => {
      setMenu({
        id: conversation.id,
        title: conversation.title || t("新对话"),
        top: Math.max(insets.top + 8, Math.min(touchY - y - 12, drawerHeight - insets.bottom - 130)),
      });
    });
  };
  const beginRename = () => {
    if (!menu) return;
    openedTarget.current = menu.id;
    setEditing({ id: menu.id, title: menu.title });
    setTitle(menu.title);
    setError("");
    setMenu(null);
  };
  const beginDelete = () => {
    if (!menu) return;
    openedTarget.current = menu.id;
    setDeleting({ id: menu.id, title: menu.title });
    setError("");
    setMenu(null);
  };
  const save = async () => {
    if (!editing || operation.current || !titleValid) return;
    operation.current = true;
    setSaving(true);
    const id = editing.id;
    try {
      const success = await onRename(id, title.trim());
      if (openedTarget.current !== id) return;
      if (success) {
        openedTarget.current = null;
        setEditing(null);
        Keyboard.dismiss();
      } else setError(failureMessage() ?? t("重命名失败，请重试"));
    } catch (cause) {
      if (openedTarget.current === id) setError(cause instanceof Error ? cause.message : t("重命名失败，请重试"));
    } finally {
      operation.current = false;
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!deleting || operation.current) return;
    operation.current = true;
    setRemoving(true);
    const id = deleting.id;
    try {
      const success = await onDelete(id);
      if (openedTarget.current !== id) return;
      if (success) {
        openedTarget.current = null;
        setDeleting(null);
      } else setError(failureMessage() ?? t("删除失败，请重试"));
    } catch (cause) {
      if (openedTarget.current === id) setError(cause instanceof Error ? cause.message : t("删除失败，请重试"));
    } finally {
      operation.current = false;
      setRemoving(false);
    }
  };
  // SSE 可先于命令响应到达，也可能是另一台设备删除；不要留下针对已删除资源的菜单。
  if (menu && (!open || !conversations.some((c) => c.id === menu.id))) setMenu(null);
  if (editing && (!open || !conversations.some((c) => c.id === editing.id))) setEditing(null);
  if (deleting && (!open || !conversations.some((c) => c.id === deleting.id))) setDeleting(null);
  useLayoutEffect(() => {
    if (!editing && !deleting) openedTarget.current = null;
  }, [editing, deleting]);
  useEffect(() => {
    if (editing) return () => Keyboard.dismiss();
  }, [editing]);
  const pendingClose = useRef<{ notify: () => void; started: boolean } | null>(null);
  const previousOpen = useRef(open);
  const onClosedRef = useRef(onClosed);
  useLayoutEffect(() => { onClosedRef.current = onClosed; });
  // Capture the Flow owner at the controlled close, not when the library later reports completion.
  useLayoutEffect(() => {
    if (previousOpen.current !== open) {
      pendingClose.current = open ? null : { notify: onClosedRef.current, started: false };
      previousOpen.current = open;
      if (open) Keyboard.dismiss();
    }
  }, [open]);
  const handleTransitionStart = useCallback((isClosing: boolean) => {
    if (isClosing && !previousOpen.current && pendingClose.current) pendingClose.current.started = true;
  }, []);
  const handleTransitionEnd = useCallback((isClosing: boolean) => {
    const pending = pendingClose.current;
    if (!isClosing || previousOpen.current || !pending?.started) return;
    pendingClose.current = null;
    pending.notify();
  }, []);
  useEffect(() => () => { pendingClose.current = null; }, []);

  // 退出动画仍可见时继续消费返回键，但不覆盖已经选定的切换动作。
  useEffect(() => {
    if (!open && !closing) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (deleting) {
        if (!operation.current) {
          openedTarget.current = null;
          setDeleting(null);
        }
      } else if (editing) {
        if (!operation.current) {
          openedTarget.current = null;
          setEditing(null);
          Keyboard.dismiss();
        }
      } else if (menu) setMenu(null);
      else if (open) onRequestClose();
      return true;
    });
    return () => subscription.remove();
  }, [open, closing, onRequestClose, menu, editing, deleting]);

  const { progress: keyboardProgress, height: keyboardHeight } = useReanimatedKeyboardAnimation();
  // This sheet is above the drawer and chat; keyboard-controller moves only the editing panel.
  const sheetInset = useAnimatedStyle(() => ({
    paddingBottom: 24 + insets.bottom * (1 - keyboardProgress.value),
    transform: [{ translateY: keyboardHeight.value }],
  }));

  return (
    <View className="flex-1" pointerEvents={closing ? "box-only" : "auto"}
      onStartShouldSetResponder={() => closing}>
      {/* onClose fires at spring start; onTransitionEnd reports actual completion.
          Swipes are native-only; Web retains the menu button/overlay.
          The half-width threshold is finger travel, not visible progress on far-right starts. */}
      <Drawer
        open={open}
        onOpen={() => { if (!open) onOpen(); }}
        onClose={() => { if (open) onRequestClose(); }}
        onTransitionStart={handleTransitionStart}
        onTransitionEnd={handleTransitionEnd}
        drawerType="front"
        drawerPosition="left"
        drawerStyle={{ width: drawerWidth }}
        overlayStyle={{ backgroundColor: "rgba(0, 0, 0, 0.4)" }}
        overlayAccessibilityLabel={t("关闭对话列表")}
        swipeEnabled={swipeEnabled && !closing}
        swipeEdgeWidth={width}
        swipeMinDistance={drawerWidth / 2}
        swipeMinVelocity={500}
        keyboardDismissMode="on-drag"
        configureGestureHandler={configureGestureHandler}
        renderDrawerContent={() => (
          <View ref={drawerContent} className="flex-1 border-r border-border bg-background shadow-lg"
            style={{ paddingTop: insets.top + 16 }} onLayout={(event) => setDrawerHeight(event.nativeEvent.layout.height)}>
        <View className="flex-row items-center gap-2 px-6 pb-2">
          <Text className="min-w-0 flex-1 text-[26px] font-bold leading-[34px] tracking-tight" numberOfLines={1}>{agentName}</Text>
          <Button testID="drawer-search" variant="ghost" size="icon" aria-label={t("搜索此 Agent")} onPress={() => router.push({ pathname: "/search", params: { agent_id: agentId } })}>
            <Icon as={Search} className="size-5" />
          </Button>
        </View>
        <View className="mx-4 mb-2 mt-3 flex-row gap-1 rounded-[22px] bg-muted p-1">
          {(["conversations", "collaborations"] as const).map((value) => (
            <Pressable key={value} testID={`drawer-tab-${value}`} accessibilityRole="tab"
              accessibilityState={{ selected: tab === value }} accessibilityLabel={value === "conversations" ? t("对话") : t("协作")}
              className={cn("h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-[18px]", tab === value && "bg-background shadow-sm")}
              onPress={() => { setTab(value); setMenu(null); }}>
              <Text className={tab === value ? "text-[15px] font-semibold" : "text-[15px] text-muted-foreground"}>
                {value === "conversations" ? t("对话") : t("协作")}
              </Text>
              {(value === "conversations" ? conversations : collaborations).some((row) => row.unread && row.id !== currentId) &&
                <View accessibilityLabel={t("需要查看")} className="size-2 rounded-full bg-destructive" />}
            </Pressable>
          ))}
        </View>
        <ScrollView
          onScrollBeginDrag={() => setMenu(null)}
          contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        >
          {loadError && <Pressable accessibilityRole="button" accessibilityLabel={t("重新加载会话列表")} onPress={onReload} className="px-6 py-3">
            <Text className="text-sm text-destructive">{t("{error} · 重试", { error: t(loadError) })}</Text>
          </Pressable>}
          {groups.map((group) => <View key={group.title}>
          <Text className="px-6 pb-2 pt-4 text-sm text-muted-foreground">{t(group.title)}</Text>
          {group.rows.length === 0 && <Text className="px-6 py-4 text-sm text-muted-foreground">
            {tab === "conversations" ? t("还没有对话") : group.title === "进行中" ? t("没有进行中的协作") : t("没有已结束的协作")}
          </Text>}
          {group.rows.map((conversation) => (
            <Pressable
              key={conversation.id}
              testID={`conversation-${conversation.id}`}
              accessibilityLabel={`${conversation.counterpart ? `${conversation.counterpart.name}${t("，")}` : ""}${conversation.source === "schedule" ? t("定时，") : ""}${conversation.title || t("新对话")}${conversation.id === currentId ? t("，当前对话") : ""}`}
              onPressIn={() => { longPressed.current = false; }}
              onLongPress={conversation.kind === "task" ? undefined : (event) => {
                longPressed.current = true;
                openMenu(conversation, event);
              }}
              onPress={() => {
                if (open && !longPressed.current && !menu) onSelect(conversation.id);
              }}
              className={cn(
                "mx-2.5 min-h-[50px] flex-row items-center gap-2.5 rounded-[25px] px-3.5 active:bg-muted",
                conversation.id === currentId && "bg-muted",
              )}
            >
              {conversation.source === "schedule" && <Icon as={Clock} className="size-4 text-muted-foreground" />}
              {conversation.counterpart && <View className="h-[22px] max-w-[104px] flex-row items-center gap-1 rounded-full bg-muted pl-0.5 pr-2">
                <WandrunAvatar index={conversation.counterpart.avatar} alt={conversation.counterpart.name} size={18} className="border border-border" />
                <Text numberOfLines={1} className="shrink text-xs font-medium">{conversation.counterpart.name}</Text>
              </View>}
              <Text
                numberOfLines={1}
                className={cn("min-w-0 flex-1 text-base", conversation.id === currentId && "font-medium")}
              >
                {conversation.title || t("新对话")}
              </Text>
              {conversation.unread && conversation.id !== currentId
                ? <View accessibilityLabel={t("需要查看")} className="size-2 rounded-full bg-destructive" />
                : conversation.running ? <TypingDots /> : null}
            </Pressable>
          ))}
          </View>)}
        </ScrollView>
        <View className="absolute right-[18px]" style={{ bottom: insets.bottom + 30 }}>
          <Button
            testID="new-conversation"
            variant="outline"
            onPress={() => { if (open) onNewConversation(); }}
            className="h-[52px] gap-2 border-[1.5px] border-foreground bg-background px-[22px] shadow-lg"
          >
            <Icon as={Plus} className="size-5" strokeWidth={1.75} />
            <Text>{t("新对话")}</Text>
          </Button>
        </View>
        {menu && (
          <View className="absolute inset-0">
            <Pressable className="absolute inset-0" onPress={() => setMenu(null)} accessibilityLabel={t("关闭对话菜单")} />
            <View
              style={{ top: menu.top, left: 44, width: Math.min(220, drawerWidth - 54) }}
              className="absolute rounded-[20px] border border-border bg-card px-1.5 py-2 shadow-lg"
            >
              <Pressable
                testID="conversation-menu-rename"
                accessibilityLabel={t("重命名对话")}
                className="min-h-[50px] flex-row items-center gap-3.5 rounded-xl px-3.5 active:bg-muted"
                onPress={beginRename}
              >
                <Icon as={Pencil} className="size-[22px] text-foreground" strokeWidth={1.75} />
                <Text className="text-base">{t("重命名")}</Text>
              </Pressable>
              <Pressable
                testID="conversation-menu-delete"
                accessibilityLabel={t("删除对话")}
                className="min-h-[50px] flex-row items-center gap-3.5 rounded-xl px-3.5 active:bg-muted"
                onPress={beginDelete}
              >
                <Icon as={Trash2} className="size-[22px] text-destructive" strokeWidth={1.75} />
                <Text className="text-base text-destructive">{t("删除")}</Text>
              </Pressable>
            </View>
          </View>
        )}
        </View>
        )}
      >
        {children}
      </Drawer>
      {editing && (
        <View className="absolute inset-0">
          <Pressable
            className="absolute inset-0 bg-black/40"
            accessibilityLabel={t("关闭重命名")}
            onPress={() => {
              if (operation.current) return;
              openedTarget.current = null;
              setEditing(null);
              Keyboard.dismiss();
            }}
          />
          <Animated.View
            style={sheetInset}
            className="absolute bottom-0 left-0 right-0 gap-3.5 rounded-t-3xl border-t border-border bg-card px-4 pt-2.5"
          >
            <View className="h-[5px] w-9 self-center rounded-full bg-border" />
            <Text className="text-xl font-semibold">{t("重命名")}</Text>
            <Input
              testID="conversation-rename-input"
              accessibilityLabel={t("对话名称")}
              value={title}
              onChangeText={(value) => { setTitle(value); setError(""); }}
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              className="border-border"
            />
            {error && <Text className="text-sm text-destructive">{t(error)}</Text>}
            <View className="flex-row gap-3">
              <Button
                testID="conversation-rename-cancel"
                variant="outline"
                className="flex-1 border-foreground bg-card"
                disabled={saving}
                onPress={() => {
                  openedTarget.current = null;
                  setEditing(null);
                  Keyboard.dismiss();
                }}
              ><Text>{t("取消")}</Text></Button>
              <Button
                testID="conversation-rename-confirm"
                variant="outline"
                className="flex-1 border-foreground bg-card"
                disabled={!titleValid || saving}
                onPress={() => void save()}
              ><Text>{t("确定")}</Text></Button>
            </View>
          </Animated.View>
        </View>
      )}
      <AlertDialog open={!!deleting} onOpenChange={(next) => {
        if (!next && !operation.current) {
          openedTarget.current = null;
          setDeleting(null);
        }
      }}>
        <AlertDialogContent className="w-full max-w-[360px] rounded-[20px] border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("删除这个对话？")}</AlertDialogTitle>
            <AlertDialogDescription>{t("正在进行的工作会停止；Agent 发给你的文件仍留在电脑上。")}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <Text className="text-sm text-destructive">{t(error)}</Text>}
          <AlertDialogFooter className="flex-row justify-end">
            <AlertDialogCancel
              testID="conversation-delete-cancel"
              disabled={removing}
              className="border-foreground bg-card"
              onPress={() => { openedTarget.current = null; setDeleting(null); }}
            ><Text>{t("取消")}</Text></AlertDialogCancel>
            <Button
              testID="conversation-delete-confirm"
              variant="outline"
              disabled={removing}
              className="border-destructive bg-card"
              onPress={() => void remove()}
            ><Text className="text-destructive">{t("删除")}</Text></Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
