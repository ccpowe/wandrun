import { Check } from "lucide-react-native";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { Carousel } from "react-native-reanimated-carousel";

import { SettingsComputerCard } from "./settings-computer-card.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";
import type { ChatSession } from "../gateway/session.ts";
import type { SavedComputer } from "../lib/credentials.ts";
import { useTranslation } from "../lib/i18n.ts";
import { duration, easing, reduceMotion } from "../lib/motion.ts";

type Props = {
  computers: readonly SavedComputer[]; current?: SavedComputer | null; session: ChatSession | null;
  name?: string; version?: string; busy: boolean;
  onManage(): void; onSwitch(computer: SavedComputer): void;
  /** settings.A11: an inactive server that needs pairing again opens its own detail. */
  onOpen(computer: SavedComputer): void;
};

/** Browsing never changes Credentials. Only the explicit action can select another session. */
export function SettingsServerCards({ computers, current, session, name, version, busy, onManage, onSwitch, onOpen }: Props) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [preview, setPreview] = useState(() => Math.max(0, computers.findIndex(computer => computer.computerId === current?.computerId)));
  if (computers.length < 2) return <SettingsComputerCard computer={current} session={session} name={name} version={version} onPress={onManage} />;
  return <View>
    <Carousel style={{ width, height: 228 }} itemSize={width - 48} data={[...computers]} loop={false}
      defaultIndex={Math.max(0, computers.findIndex(computer => computer.computerId === current?.computerId))}
      keyExtractor={computer => computer.computerId} onSnapToItem={setPreview}
      animation={{ type: "timing", duration: duration.enter, easing: easing.enter, reduceMotion }}
      renderItem={({ item }) => {
        const active = item.computerId === current?.computerId;
        const invalid = item.authStatus === "invalid";
        return <View testID={`settings-server-${item.computerId}`}>
          <SettingsComputerCard computer={item} session={active ? session : null} name={active ? name : undefined} version={active ? version : item.gatewayVersion}
            current={active} inset={false} testID={active ? undefined : `settings-server-open-${item.computerId}`}
            onPress={active ? onManage : invalid ? () => onOpen(item) : undefined}
            footer={<View className="flex-row justify-end">
              {active ? <View className="min-h-12 flex-row items-center gap-1"><Icon as={Check} size={14} className="text-device-foreground" /><Text variant="caption" className="text-device-foreground">{t("正在使用")}</Text></View>
                : <Button testID={`settings-server-use-${item.computerId}`} intent="quiet" disabled={busy} accessibilityLabel={t("使用这台：{name}", { name: item.localName || item.computerName || t("服务器") })}
                  onPress={() => onSwitch(item)}><Text className="text-device-foreground">{t(invalid ? "需要重新配对" : "使用这台")}</Text></Button>}
            </View>} />
        </View>;
      }} />
    <View className="mx-5 flex-row justify-between gap-3">
      <Text variant="caption" numberOfLines={1} className="min-w-0 flex-1 text-muted-foreground">{t("正在使用：{name}", { name: current?.localName || name || current?.computerName || t("服务器") })}</Text>
      <Text variant="caption" accessibilityLiveRegion="polite" accessibilityLabel={t("正在浏览第 {index} 台，共 {total} 台", { index: preview + 1, total: computers.length })} className="text-muted-foreground">{preview + 1} / {computers.length}</Text>
    </View>
  </View>;
}
