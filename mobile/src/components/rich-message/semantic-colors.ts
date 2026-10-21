import { useCSSVariable } from 'uniwind';

export type RichTone = 'neutral' | 'active' | 'success' | 'warning' | 'error' | 'info';
type ToneColors = { foreground: string; background: string; border: string };
const tones: RichTone[] = ['neutral', 'active', 'success', 'warning', 'error', 'info'];
const variables = tones.flatMap((tone) => [`--color-rich-${tone}`, `--color-rich-${tone}-bg`, `--color-rich-${tone}-border`]);

/** The theme owns both palettes. Chart marks use border colors, not badge foregrounds;
 * labels always remain alongside colored marks. */
export function useRichColors(): Record<RichTone, ToneColors> {
  const values = useCSSVariable(variables);
  return Object.fromEntries(tones.map((tone, index) => [tone, {
    foreground: String(values[index * 3] ?? '#737373'),
    background: String(values[index * 3 + 1] ?? 'transparent'),
    border: String(values[index * 3 + 2] ?? '#737373'),
  }])) as Record<RichTone, ToneColors>;
}
