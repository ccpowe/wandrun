import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

import type { PickedUpload } from "./upload-drafts.ts";
import { UserFacingError } from "./user-error.ts";

export type AttachmentSource = "camera" | "photos" | "video" | "file";

export async function pickUploads(source: AttachmentSource): Promise<PickedUpload[]> {
  if (source === "file") {
    // Expo Go's scoped file permissions reject the picker cache file on Android.
    // Keep the SAF grant and let File.copy stream it natively into our Documents draft.
    const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: Platform.OS !== "android" });
    return result.canceled ? [] : result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size }));
  }
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new UserFacingError("请在系统设置中允许使用相机");
  }
  // On iOS unedited passthrough videos can require the original library permission after
  // selection; ask first, not during an unexpectedly long export/download.
  if (source === "video" && Platform.OS === "ios") {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new UserFacingError("请在系统设置中允许访问视频");
  }
  const result = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
    : await ImagePicker.launchImageLibraryAsync({
      mediaTypes: source === "video" ? ["videos"] : ["images"],
      allowsMultipleSelection: true,
      quality: 1,
      shouldDownloadFromNetwork: true,
    });
  return result.canceled ? [] : result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName || new File(asset.uri).name || (asset.type === "video" ? "video.mp4" : "photo.jpg"),
    mimeType: asset.mimeType,
    size: asset.fileSize,
  }));
}
