import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/utils.ts";
import type { ImageStyle, StyleProp, ViewStyle } from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";

// 设计稿头像 b1..b8：白底圆形；avatar-surface 在浅深色都保持白底。
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
  size?: 88 | 76 | 64 | 52 | 40 | 28 | 18;
  className?: string;
  /** A caller may animate the image inside the same circular Avatar root. */
  animatedImageStyle?: StyleProp<AnimatedStyle<ImageStyle>>;
  /** Keeps one native Avatar while its own border changes during a morph. */
  animatedRootStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
};

const SIZE_CLASS = { 88: "size-[88px]", 76: "size-[76px]", 64: "size-16", 52: "size-[52px]", 40: "size-10", 28: "size-7", 18: "size-[18px]" } as const;

export function WandrunAvatar({ index, alt, size = 40, className, animatedImageStyle, animatedRootStyle }: Props) {
  const n = ((Math.trunc(index) % AVATAR_COUNT) + AVATAR_COUNT) % AVATAR_COUNT;
  const image = animatedImageStyle
    ? <AvatarImage source={AVATARS[n]} asChild><Animated.Image style={animatedImageStyle} /></AvatarImage>
    : <AvatarImage source={AVATARS[n]} />;
  const fallback = <AvatarFallback className="bg-avatar-surface">
    <Text className="text-sm font-semibold text-avatar-fallback-foreground">{`B${n + 1}`}</Text>
  </AvatarFallback>;
  return (
    <Avatar alt={alt} className={cn("bg-avatar-surface", SIZE_CLASS[size], className)} asChild={!!animatedRootStyle}>
      {animatedRootStyle
        ? <Animated.View style={animatedRootStyle}>{image}{fallback}</Animated.View>
        : <>{image}{fallback}</>}
    </Avatar>
  );
}
