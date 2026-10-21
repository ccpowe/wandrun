import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/utils.ts";

// 设计稿头像 b1..b8：白底圆形，深色模式也保持白底（不跟随主题变量）。
const AVATARS = [
  require("../../assets/avatar-b1.png"),
  require("../../assets/avatar-b2.png"),
  require("../../assets/avatar-b3.png"),
  require("../../assets/avatar-b4.png"),
  require("../../assets/avatar-b5.png"),
  require("../../assets/avatar-b6.png"),
  require("../../assets/avatar-b7.png"),
  require("../../assets/avatar-b8.png"),
] as const;

export const AVATAR_COUNT = AVATARS.length;

type Props = {
  /** 网关头像编号 0..7，对应头像 b1..b8；超范围按 8 取模。 */
  index: number;
  alt: string;
  /** Profile, list, header and compact collaboration identity sizes. */
  size?: 88 | 76 | 52 | 40 | 28 | 18;
  className?: string;
};

const SIZE_CLASS = { 88: "size-[88px]", 76: "size-[76px]", 52: "size-[52px]", 40: "size-10", 28: "size-7", 18: "size-[18px]" } as const;

export function WandrunAvatar({ index, alt, size = 40, className }: Props) {
  const n = ((Math.trunc(index) % AVATAR_COUNT) + AVATAR_COUNT) % AVATAR_COUNT;
  return (
    <Avatar alt={alt} className={cn("bg-white", SIZE_CLASS[size], className)}>
      <AvatarImage source={AVATARS[n]} />
      <AvatarFallback className="bg-white">
        <Text className="text-sm font-semibold text-neutral-500">{`B${n + 1}`}</Text>
      </AvatarFallback>
    </Avatar>
  );
}
