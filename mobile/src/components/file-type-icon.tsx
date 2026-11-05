import { Clapperboard, File, FileCode2, FilePenLine, FileSpreadsheet, FileText, FileType, Image, type LucideIcon } from "lucide-react-native";

import { Icon } from "@/components/ui/icon.tsx";

const mimeIcons: Record<string, LucideIcon> = {
  "application/pdf": FileType,
  "text/markdown": FileCode2,
  "text/x-markdown": FileCode2,
  "text/csv": FileSpreadsheet,
  "application/csv": FileSpreadsheet,
  "text/tab-separated-values": FileSpreadsheet,
  "application/vnd.ms-excel": FileSpreadsheet,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": FileSpreadsheet,
  "application/vnd.ms-excel.sheet.macroenabled.12": FileSpreadsheet,
  "application/msword": FilePenLine,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": FilePenLine,
  "application/vnd.ms-word.document.macroenabled.12": FilePenLine,
};

const extensionIcons: Record<string, LucideIcon> = {
  pdf: FileType, txt: FileText, md: FileCode2, markdown: FileCode2,
  csv: FileSpreadsheet, tsv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet, xlsm: FileSpreadsheet,
  doc: FilePenLine, docx: FilePenLine, docm: FilePenLine,
};

/** File category is independent of whether the app can safely preview its content. */
export function FileTypeIcon({ mediaType, name, className }: { mediaType: string; name: string; className?: string }) {
  const type = mediaType.split(";", 1)[0].trim().toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  const specific = Object.hasOwn(mimeIcons, type) ? mimeIcons[type] : undefined;
  const byExtension = Object.hasOwn(extensionIcons, extension) ? extensionIcons[extension] : undefined;
  // Specific MIME wins; names recover office/Markdown types reported as generic bytes or plain text.
  const icon = specific ?? (type.startsWith("image/") ? Image
    : type.startsWith("video/") ? Clapperboard
    : byExtension ??
      (type.startsWith("text/") || type === "application/json" || type === "application/xml" ? FileText : File));
  return <Icon as={icon} className={className} />;
}
