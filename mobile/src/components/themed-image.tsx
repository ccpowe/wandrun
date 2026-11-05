import { Image, type ImageProps, type ImageSourcePropType } from 'react-native';
import { useUniwind } from 'uniwind';

/**
 * One illustration per theme. Line art with solid black patches cannot be recoloured with
 * tintColor (the patches would invert), so dark mode gets its own asset.
 */
export function ThemedImage({ light, dark, ...props }: Omit<ImageProps, 'source'> & { light: ImageSourcePropType; dark: ImageSourcePropType }) {
  const { theme } = useUniwind();
  return <Image {...props} source={theme === 'dark' ? dark : light} />;
}
