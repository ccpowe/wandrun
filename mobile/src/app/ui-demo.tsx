import {
  ArrowUp,
  Check,
  ChevronRight,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Plus,
  Send,
  Settings,
  Square,
  Users,
  WifiOff,
} from "lucide-react-native";
import { Image, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";

// 颜色 token：className 必须是字面量，Tailwind 才能扫描到。
const TOKENS = [
  { name: "background", cls: "bg-background" },
  { name: "foreground", cls: "bg-foreground" },
  { name: "card", cls: "bg-card" },
  { name: "muted", cls: "bg-muted" },
  { name: "muted-fg", cls: "bg-muted-foreground" },
  { name: "border", cls: "bg-border" },
  { name: "primary", cls: "bg-primary" },
  { name: "secondary", cls: "bg-secondary" },
  { name: "accent", cls: "bg-accent" },
  { name: "destructive", cls: "bg-destructive" },
  { name: "live", cls: "bg-live" },
  { name: "scrim", cls: "bg-scrim" },
] as const;

const ICONS = [ArrowUp, Check, ChevronRight, Monitor, MoreHorizontal, Paperclip, Plus, Send, Settings, Square, Users, WifiOff];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-3">
      <Text className="text-sm text-muted-foreground">{title}</Text>
      {children}
    </View>
  );
}

export default function UiDemo() {
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-8 p-4 pb-16">
      <View className="gap-1">
        <Text className="text-title font-semibold">UI 底座</Text>
        <Text className="text-muted-foreground">Uniwind + React Native Reusables。亮暗跟随系统。</Text>
      </View>

      <Section title="字号阶梯 28/36 · 20/28 · 17/24 · 16/24 · 14/20 · 12/16">
        <Text className="text-title font-semibold">title 28</Text>
        <Text className="text-xl font-semibold">xl 20</Text>
        <Text className="text-lg font-medium">lg 17</Text>
        <Text className="text-base">base 16</Text>
        <Text className="text-sm">sm 14</Text>
        <Text className="text-xs">xs 12</Text>
      </Section>

      <Section title="颜色 token">
        <View className="flex-row flex-wrap gap-3">
          {TOKENS.map((t) => (
            <View key={t.name} className="w-20 items-center gap-1">
              <View className={`h-12 w-20 rounded-sm border border-border ${t.cls}`} />
              <Text className="text-xs text-muted-foreground">{t.name}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="圆角 sm 8 / md 14 / lg 20">
        <View className="flex-row gap-3">
          <View className="size-16 rounded-sm bg-secondary" />
          <View className="size-16 rounded-md bg-secondary" />
          <View className="size-16 rounded-lg bg-secondary" />
        </View>
      </Section>

      <Section title="按钮（48 高胶囊；sm 36）">
        <View className="flex-row flex-wrap items-center gap-2">
          <Button><Text>default</Text></Button>
          <Button variant="outline"><Text>outline</Text></Button>
          <Button variant="secondary"><Text>secondary</Text></Button>
          <Button variant="ghost"><Text>ghost</Text></Button>
          <Button variant="destructive"><Text>destructive</Text></Button>
          <Button variant="link"><Text>link</Text></Button>
          <Button size="sm"><Text>sm</Text></Button>
          <Button size="sm" variant="outline"><Text>sm outline</Text></Button>
          <Button disabled><Text>disabled</Text></Button>
          <Button size="icon" variant="ghost"><Icon as={Settings} /></Button>
          <Button size="icon"><Icon as={Plus} /></Button>
        </View>
      </Section>

      <Section title="图标（lucide，描边 1.75）">
        <View className="flex-row flex-wrap gap-4">
          {ICONS.map((I, i) => (
            <Icon key={i} as={I} className="size-6" />
          ))}
        </View>
      </Section>

      <Section title="头像（白底，深色也不变）与插图">
        <View className="flex-row flex-wrap items-center gap-3">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <WandrunAvatar key={n} index={n} alt={`avatar-b${n + 1}`} size={52} />
          ))}
        </View>
        <View className="flex-row items-end gap-3">
          <WandrunAvatar index={0} alt="88" size={88} />
          <WandrunAvatar index={1} alt="52" size={52} />
          <WandrunAvatar index={2} alt="40" size={40} />
          <WandrunAvatar index={3} alt="28" size={28} />
        </View>
        <Image source={require("../../assets/empty-together.png")} className="h-[130px] w-[260px]" resizeMode="contain" />
      </Section>

      <Section title="输入">
        <Input placeholder="Input" />
        <Textarea placeholder="Textarea" />
      </Section>

      <Section title="卡片 / 分隔线">
        <Card className="rounded-md py-0 shadow-none">
          <CardHeader className="pt-4">
            <CardTitle className="text-lg font-medium">Card</CardTitle>
            <CardDescription>bg-card + border，圆角 md 14</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <Separator />
            <Text className="pt-3 text-sm text-muted-foreground">内容</Text>
          </CardContent>
        </Card>
      </Section>

      <Section title="Dialog / DropdownMenu（Portal）">
        <View className="flex-row gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline"><Text>打开 Dialog</Text></Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>标题</DialogTitle>
                <DialogDescription>弹窗内容跟随亮暗主题。</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button><Text>好</Text></Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline"><Text>菜单</Text></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-44">
              <DropdownMenuItem><Text>新对话</Text></DropdownMenuItem>
              <DropdownMenuItem><Text>设置</Text></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </Section>
    </ScrollView>
  );
}
