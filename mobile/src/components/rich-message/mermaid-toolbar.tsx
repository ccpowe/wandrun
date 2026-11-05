import { Code2, Play, RotateCcw } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import { richGeometry, richRadius, richSpace } from './tokens.ts';

export type MermaidView = 'code' | 'preview';

/** Native code/preview switch and fullscreen reset; changing view never toggles the active choice off. */
export function MermaidToolbar({ view, onViewChange, canPreview = true, controls, full = false }: {
  view: MermaidView;
  onViewChange: (view: MermaidView) => void;
  canPreview?: boolean;
  /** Only fullscreen exposes a viewport and its reset action. */
  controls?: { zoomed: boolean; ready: boolean; onReset: () => void };
  full?: boolean;
}) {
  const { t } = useTranslation();
  const prefix = full ? 'mermaid-full' : 'mermaid';
  // Inline (user 2026-11-01): a compact pill, 40×28 visual per segment; vertical hitSlop restores a 48 target.
  // Adjacent segments cannot extend sideways, so their target is 40 wide. Full screen keeps the 48 segments.
  // Radii are exact half-heights: a 9999 radius dropped the track's right-hand rounding on Android.
  const item = full
    ? { style: { height: richGeometry.touch, minWidth: richGeometry.touch, borderRadius: richRadius.small, paddingHorizontal: richSpace.sm } }
    : { style: { height: 28, width: 40, borderRadius: 14 }, hitSlop: { top: 10, bottom: 10 } };
  return <View className="shrink-0 flex-row items-center" style={{ gap: richSpace.xs }} testID={`${prefix}-toolbar`}>
    <ToggleGroup type="single" value={view} onValueChange={(next) => {
      if (next === 'code' || next === 'preview' && canPreview) onViewChange(next);
    }} className="bg-muted" style={full ? { borderRadius: richRadius.medium, padding: richSpace.xs } : { borderRadius: 16, padding: 2 }}>
      <ToggleGroupItem value="code" isFirst testID={`${prefix}-view-code`}
        accessibilityLabel={t('查看流程图源码')} {...item}
        className={`shadow-none ${view === 'code' ? 'bg-background' : 'bg-transparent'}`}>
        <Icon as={Code2} className={full ? 'size-4' : 'size-3.5'} />
      </ToggleGroupItem>
      <ToggleGroupItem value="preview" isLast disabled={!canPreview} testID={`${prefix}-view-preview`}
        accessibilityLabel={t('预览流程图')} {...item}
        className={`shadow-none ${view === 'preview' ? 'bg-background' : 'bg-transparent'}`}>
        <Icon as={Play} className={full ? 'size-4' : 'size-3.5'} />
      </ToggleGroupItem>
    </ToggleGroup>
    {full && view === 'preview' && controls?.zoomed ? <Button variant="ghost" size="icon" onPress={controls.onReset} disabled={!controls.ready}
      style={{ width: richGeometry.touch, height: richGeometry.touch, borderRadius: richRadius.full }}
      testID={`${prefix}-reset`} accessibilityLabel={t('重置流程图缩放')}>
      <Icon as={RotateCcw} className="size-5" />
    </Button> : null}
  </View>;
}
