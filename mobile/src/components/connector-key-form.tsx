import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import type { ConnectorParameterDraft } from '@/lib/connector-add';
import { useTranslation } from '@/lib/i18n';

/** connector-auth.AU10: one secure Key field for a catalog key connector; address and auth stay catalog-owned. */
export function ConnectorKeyForm({ draft, keyUrl, disabled, onChange }: {
  draft: ConnectorParameterDraft; keyUrl: string; disabled: boolean;
  onChange: (fields: Partial<ConnectorParameterDraft>) => void;
}) {
  const { t } = useTranslation();
  const [openFailed, setOpenFailed] = useState(false);
  const row = draft.headers[0];
  if (!row) return null;
  const open = () => { setOpenFailed(false); Linking.openURL(keyUrl).catch(() => setOpenFailed(true)); };
  return <View className="mx-4 gap-2">
    <Text variant="caption" className="px-1 text-muted-foreground">Key</Text>
    <Input testID="connector-key" secureTextEntry accessibilityLabel="Key" value={row.value} editable={!disabled}
      autoCapitalize="none" autoCorrect={false} placeholder={t(row.existing ? '留空保持已有密钥' : '密钥值')}
      onChangeText={value => onChange({ headers: [{ ...row, value }] })} />
    <Button testID="connector-key-url" intent="quiet" className="self-start" onPress={open}><Text>{t('获取 Key')}</Text></Button>
    {openFailed ? <Text accessibilityRole="alert" variant="caption" className="px-1 text-destructive">{t('无法打开链接')}</Text> : null}
  </View>;
}
