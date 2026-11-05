import { ImageFormat, Skia } from '@shopify/react-native-skia';

/** Synthetic Chrome boundary image; CSS geometry is independent of these small encoded pixels. */
export function browserFixturePicture(): Uint8Array {
  const surface = Skia.Surface.MakeOffscreen(8, 6);
  if (!surface) throw new Error('fake-browser-surface-unavailable');
  const image = surface.makeImageSnapshot();
  try { return image.encodeToBytes(ImageFormat.JPEG, 80); }
  finally { image.dispose(); surface.dispose(); }
}
