import { Camera, CirclePlay, FileText, Images, Plus } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";
import type { TriggerRef } from "@rn-primitives/dropdown-menu";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { AttachmentSource } from "@/lib/pick-upload.ts";
import { useTranslation } from "@/lib/i18n.ts";

const OPTIONS = [
  { source: "camera", label: "相机", icon: Camera, testID: "attachment-picker-camera" },
  { source: "photos", label: "照片", icon: Images, testID: "attachment-picker-photos" },
  { source: "video", label: "视频", icon: CirclePlay, testID: "attachment-picker-video" },
  { source: "file", label: "文件", icon: FileText, testID: "attachment-picker-file" },
] as const;

export function AttachmentPickerMenu({ onPick }: {
  onPick(source: AttachmentSource): void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const trigger = useRef<TriggerRef>(null);
  const open = useRef(false);
  const [pendingPick, setPendingPick] = useState<AttachmentSource | null>(null);

  useEffect(() => {
    // The primitive measures on opening; refresh after the keyboard moves the composer.
    const remeasure = () => {
      if (open.current) trigger.current?.open?.();
    };
    const shown = Keyboard.addListener("keyboardDidShow", remeasure);
    const hidden = Keyboard.addListener("keyboardDidHide", remeasure);
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  useEffect(() => {
    if (!pendingPick) return;
    // Item closes the portal first. Present the system picker after that commit.
    // No native Modal remains, so iOS no longer needs an onDismiss callback.
    const frame = requestAnimationFrame(() => {
      setPendingPick(null);
      onPick(pendingPick);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingPick, onPick]);

  return (
    <DropdownMenu onOpenChange={(value) => { open.current = value; }}>
      <DropdownMenuTrigger ref={trigger} asChild>
        <Button testID="composer-add" variant="ghost" size="icon" className="size-10 bg-transparent" aria-label={t("添加附件")}>
          <Icon as={Plus} size={22} className="text-foreground" style={{ width: 22, height: 22 }} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        testID="attachment-picker-menu"
        side="top"
        align="start"
        sideOffset={8}
        insets={insets}
        overlayTestID="attachment-picker-dismiss"
        className="min-w-[176px] rounded-[18px] p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.18)] shadow-black/18"
      >
        {OPTIONS.map(({ source, label, icon, testID }) => (
          <DropdownMenuItem key={source} testID={testID} accessibilityLabel={t(label)}
            onPress={() => setPendingPick(source)}
            className="min-h-12 gap-3.5 rounded-xl px-3.5">
            <Icon as={icon} className="size-[22px] text-foreground" strokeWidth={1.75} />
            <Text className="text-base">{t(label)}</Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
