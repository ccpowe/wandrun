import { Clapperboard, File, FileText, Image } from "lucide-react-native";

import { Icon } from "@/components/ui/icon.tsx";

/** File category is independent of whether the app can safely preview its content. */
export function FileTypeIcon({ mediaType, className }: { mediaType: string; className?: string }) {
  const type = mediaType.split(";", 1)[0].trim().toLowerCase();
  const icon = type.startsWith("image/") ? Image
    : type.startsWith("video/") ? Clapperboard
    : type.startsWith("text/") || type === "application/json" || type === "application/xml" ? FileText
    : File;
  return <Icon as={icon} className={className} />;
}
