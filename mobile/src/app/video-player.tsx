import { Stack, useLocalSearchParams } from "expo-router";

import { VideoPlayerScreen } from "@/components/chat/attachment-media.tsx";
import { useSession } from "@/lib/session-context.tsx";

export default function VideoPlayerRoute() {
  const { file_id } = useLocalSearchParams<{ file_id?: string }>();
  const session = useSession();
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <VideoPlayerScreen fileId={file_id} api={session?.api} />
  </>;
}
