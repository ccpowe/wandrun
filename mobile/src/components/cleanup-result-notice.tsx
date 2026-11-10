import { Info } from 'lucide-react-native';
import { View } from 'react-native';
import { StatusBanner } from './status-banner.tsx';
import { useTranslation } from '../lib/i18n.ts';

export function CleanupResultNotice({ message }: { message: string | null }) {
  const { t } = useTranslation();
  return message ? <View testID="cleanup-result-notice"><StatusBanner icon={Info} accessibilityRole="alert" title={t(message)} /></View> : null;
}
