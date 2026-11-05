import { Children, isValidElement, useState, type ReactNode } from 'react';
import { Platform, ScrollView, View, useWindowDimensions, type ViewStyle } from 'react-native';
import type { z } from 'zod';
import { DrawerHorizontalGesture } from '@/components/chat/drawer-horizontal-gesture.tsx';
import { fractionWidth, gridChildWidth, scrollChildWidth } from './layout.ts';
import { groupLinks } from './link-card.tsx';
import type { componentSchemas, RichChildWidth } from './spec.ts';
import { richSpace } from './tokens.ts';

type Props<K extends 'Stack' | 'Grid' | 'ScrollRow'> = { props: z.infer<(typeof componentSchemas)[K]>; children?: ReactNode };
const gaps = { none: 0, sm: richSpace.sm, md: richSpace.md, lg: richSpace.lg };
const justify = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const;
const align = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const;

/** json-render 0.21 passes the validated child element on each ElementRenderer, as groupLinks already uses. */
function widthOf(child: ReactNode): RichChildWidth | undefined {
  return isValidElement<{ element?: { width?: RichChildWidth } }>(child) ? child.props.element?.width : undefined;
}

export function StackDisplay({ props, children }: Props<'Stack'>) {
  const [available, setAvailable] = useState(0);
  const horizontal = props.direction === 'horizontal';
  const gap = gaps[props.gap ?? 'md'];
  return <View testID="rich-stack" onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
    style={{ minWidth: 0, flexDirection: horizontal ? 'row' : 'column', gap,
      flexWrap: horizontal && props.wrap !== false ? 'wrap' : 'nowrap',
      justifyContent: justify[props.justify ?? 'start'], alignItems: align[props.align ?? (horizontal ? 'center' : 'stretch')] }}>
    {Children.toArray(groupLinks(children)).map((child, index) => {
      const width = widthOf(child);
      // Auto keeps native sizing in either direction; shrink-wrapping a measured child can collapse it to zero.
      if (width === undefined || width === 'auto') return child;
      const style: ViewStyle = { minWidth: 0, flexShrink: 0 };
      if (available > 0) {
        const target = fractionWidth(available, horizontal ? gap : 0, width);
        if (horizontal) {
          // Use Grid's rounding margin and cap growth at the requested fraction.
          style.flexBasis = Math.max(0, Math.floor(target) - 1);
          style.flexGrow = 1;
          style.maxWidth = target;
        } else style.width = target;
      }
      return <View key={isValidElement(child) ? child.key ?? index : index} style={style}>{child}</View>;
    })}
  </View>;
}

export function GridDisplay({ props, children }: Props<'Grid'>) {
  const [available, setAvailable] = useState(0);
  const { fontScale } = useWindowDimensions();
  const minimum = (props as typeof props & { __minimumWidth?: number }).__minimumWidth ?? 96;
  return <View testID="rich-grid" style={{ minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: richSpace.sm }}
    onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 && Children.toArray(groupLinks(children)).map((child, index) => {
      const width = gridChildWidth(available, props.columns, minimum, fontScale, widthOf(child));
      // Leave one physical rounding margin before growth, without changing child ancestry on resize.
      return <View key={isValidElement(child) ? child.key ?? index : index}
        style={{ flexGrow: 1, flexShrink: 0, flexBasis: Math.max(0, Math.floor(width) - 1), minWidth: 0, maxWidth: width }}>{child}</View>;
    })}
  </View>;
}

/** `ScrollRow.fits/.overflow`: the native ScrollView owns interception; never wrap a gesture around its parent. */
export function ScrollRowDisplay({ props, children }: Props<'ScrollRow'>) {
  const [available, setAvailable] = useState(0);
  const gap = gaps[props.gap ?? 'sm'];
  const items = Children.toArray(children);
  const widths = items.map(child => scrollChildWidth(available, gap, widthOf(child)));
  const contentWidth = widths.reduce((sum, width) => sum + width, gap * Math.max(0, items.length - 1));
  return <View style={{ minWidth: 0 }} onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    {available > 0 ? <DrawerHorizontalGesture><ScrollView horizontal directionalLockEnabled
      testID="rich-scroll-row" scrollEnabled={contentWidth > available + 1} showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, ...(Platform.OS === 'web' ? { touchAction: 'pan-x' as const, overscrollBehaviorX: 'contain' as const } : {}) }}
      contentContainerStyle={{ gap, alignItems: 'stretch' }}>
      {items.map((child, index) => <View key={isValidElement(child) ? child.key ?? index : index}
        style={{ width: widths[index], flexShrink: 0, minWidth: 0 }}>{child}</View>)}
    </ScrollView></DrawerHorizontalGesture> : null}
  </View>;
}
