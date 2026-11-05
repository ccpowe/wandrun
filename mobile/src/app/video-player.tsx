import { Stack, useLocalSearchParams } from "expo-router";

import { VideoPlayerScreen } from "@/components/chat/attachment-media.tsx";
import { useSession } from "@/lib/session-context.tsx";
import { useImmersiveStatusBar } from "@/lib/use-status-bar-appearance.tsx";

export default function VideoPlayerRoute() {
  const { file_id } = useLocalSearchParams<{ file_id?: string }>();
  const session = useSession();
  useImmersiveStatusBar();
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <VideoPlayerScreen fileId={file_id} api={session?.api} />
  </>;
}
