import { Children, createContext, isValidElement, useContext, useState } from 'react';
import { Linking, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { useCSSVariable } from 'uniwind';
import { Text } from '@/components/ui/text.tsx';
import type { GatewayApi } from '@/gateway/api.ts';
import type { z } from 'zod';
import type { componentSchemas } from './spec.ts';
import type { MediaLocation } from './media.tsx';
import { LinkThumbnail } from './media.tsx';
import { sourceSite } from './source-site.ts';
import { richGeometry } from './tokens.ts';

const HasPreviousLink = createContext(false);

/** json-render passes immediate children as ElementRenderer elements. Wrap only adjacent
 * LinkCards; leave all other child elements untouched and in their original order. */
export function groupLinks(children: React.ReactNode): React.ReactNode {
  const items = Children.toArray(children);
  const grouped: React.ReactNode[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    const isLink = isValidElement<{ element?: { type?: string } }>(item) && item.props.element?.type === 'LinkCard';
    if (!isLink) { grouped.push(item); index++; continue; }
    const start = index;
    while (index < items.length) {
      const next = items[index];
      if (!isValidElement<{ element?: { type?: string } }>(next) || next.props.element?.type !== 'LinkCard') break;
      index++;
    }
    grouped.push(<View key={`links-${start}`} testID="rich-link-list">
      {items.slice(start, index).map((link, offset) =>
        <HasPreviousLink.Provider key={start + offset} value={offset > 0}>{link}</HasPreviousLink.Provider>)}
    </View>);
  }
  return grouped;
}

/** A standalone LinkCard is the same unframed row as a list entry. The thumbnail receives
 * authenticated message coordinates, never the model-supplied image URL. */
export function LinkCardDisplay({ props, api, location }: {
  props: z.infer<typeof componentSchemas.LinkCard>; api?: GatewayApi; location?: MediaLocation;
}) {
  const host = new URL(props.url).hostname;
  const site = sourceSite(host);
  const divided = useContext(HasPreviousLink);
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  // Decorative art must not consume the text column in a narrow parent, regardless of its layout.
  const showThumbnail = width >= 64 + 14 + 160 * fontScale;
  const muted = String(useCSSVariable('--color-muted-foreground'));
  const underline = { textDecorationLine: 'underline', textDecorationColor: muted,
    textDecorationStyle: Platform.OS === 'android' ? 'solid' : 'dotted' } as const;
  return <Pressable testID="rich-link-card" accessibilityRole="link" accessibilityLabel={`${props.title}，${host}`}
    onPress={() => void Linking.openURL(props.url)}
    className={divided ? 'border-border border-t' : undefined}
    onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    style={{ minHeight: richGeometry.touch, flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14 }}>
    {showThumbnail ? <LinkThumbnail api={api} location={location}
      letter={site.letter} color={site.color} /> : null}
    <View pointerEvents="none" style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <Text numberOfLines={3} className="text-foreground" style={{ fontSize: 16, lineHeight: 23, fontWeight: '600',
        // Web emergency wrapping breaks even Unicode glue; break words normally without overriding it.
        ...(Platform.OS === 'web' ? { overflowWrap: 'normal' as const, wordBreak: 'break-all' as const } : {}) }}>
        <Text style={underline}>{props.title}</Text>
        {/* Keep the text arrow on the last character's line without Android inline-view baseline layout.
            WORD JOINER + NBSP prevents a break; VS15 requests a text glyph rather than an emoji. */}
        {'\u2060\u00a0↗\ufe0e'}
      </Text>
      <Text numberOfLines={1} className="text-muted-foreground" style={{ fontSize: 13, lineHeight: 18 }}>
        {host.replace(/^www\./, '')}{props.tags?.length ? ` · ${props.tags.join(' · ')}` : ''}
      </Text>
      {props.description ? <Text numberOfLines={4} className="text-foreground" style={{ fontSize: 15, lineHeight: 23 }}>
        {props.description}
      </Text> : null}
    </View>
  </Pressable>;
}
