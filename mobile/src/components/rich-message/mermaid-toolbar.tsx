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
  return <View className="shrink-0 flex-row items-center" style={{ gap: richSpace.xs }} testID={`${prefix}-toolbar`}>
    <ToggleGroup type="single" value={view} onValueChange={(next) => {
      if (next === 'code' || next === 'preview' && canPreview) onViewChange(next);
    }} className="bg-muted" style={{ borderRadius: richRadius.medium, padding: richSpace.xs }}>
      <ToggleGroupItem value="code" isFirst testID={`${prefix}-view-code`}
        accessibilityLabel={t('查看流程图源码')} style={{ height: richGeometry.touch, minWidth: richGeometry.touch, borderRadius: richRadius.small, paddingHorizontal: richSpace.sm }}
        className={`shadow-none ${view === 'code' ? 'bg-background' : 'bg-transparent'}`}>
        <Icon as={Code2} className="size-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="preview" isLast disabled={!canPreview} testID={`${prefix}-view-preview`}
        accessibilityLabel={t('预览流程图')} style={{ height: richGeometry.touch, minWidth: richGeometry.touch, borderRadius: richRadius.small, paddingHorizontal: richSpace.sm }}
        className={`shadow-none ${view === 'preview' ? 'bg-background' : 'bg-transparent'}`}>
        <Icon as={Play} className="size-4" />
      </ToggleGroupItem>
    </ToggleGroup>
    {full && view === 'preview' && controls?.zoomed ? <Button variant="ghost" size="icon" onPress={controls.onReset} disabled={!controls.ready}
      style={{ width: richGeometry.touch, height: richGeometry.touch, borderRadius: richRadius.full }}
      testID={`${prefix}-reset`} accessibilityLabel={t('重置流程图缩放')}>
      <Icon as={RotateCcw} className="size-5" />
    </Button> : null}
  </View>;
}
