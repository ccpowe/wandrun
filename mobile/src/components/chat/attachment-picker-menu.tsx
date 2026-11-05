import { Camera, CirclePlay, FileText, Images, Plus } from "lucide-react-native";
import { useEffectEvent, useRef, useState } from "react";
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
import { useMountEffect } from "@/lib/use-mount-effect.ts";

const OPTIONS = [
  { source: "camera", label: "相机", icon: Camera, testID: "attachment-picker-camera" },
  { source: "photos", label: "照片", icon: Images, testID: "attachment-picker-photos" },
  { source: "video", label: "视频", icon: CirclePlay, testID: "attachment-picker-video" },
  { source: "file", label: "文件", icon: FileText, testID: "attachment-picker-file" },
] as const;

export function AttachmentPickerMenu({ onPick, disabled = false }: {
  onPick(source: AttachmentSource): void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const trigger = useRef<TriggerRef>(null);
  const [open, setOpen] = useState(false);
  const remeasure = useEffectEvent(() => {
    if (open) trigger.current?.open?.();
  });
  useMountEffect(() => {
    // The primitive remeasures after the keyboard moves the composer.
    const shown = Keyboard.addListener("keyboardDidShow", remeasure);
    const hidden = Keyboard.addListener("keyboardDidHide", remeasure);
    return () => { shown.remove(); hidden.remove(); };
  });

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger ref={trigger} asChild disabled={disabled}>
        <Button testID="composer-add" disabled={disabled} intent="quiet" size="icon-sm" className="mb-1" aria-label={t("添加附件")}>
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
        className="min-w-[176px]"
      >
        {OPTIONS.map(({ source, label, icon, testID }) => (
          <DropdownMenuItem key={source} testID={testID} accessibilityLabel={t(label)} icon={icon}
            // rn-primitives closes its portal before invoking this user event.
            onPress={() => onPick(source)}>
            <Text variant="body">{t(label)}</Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
