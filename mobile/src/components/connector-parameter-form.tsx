import { Plus, X } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { GroupRow } from '@/components/group-row';
import { ListGroup } from '@/components/list-group';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import type { ConnectorAuthChoice, ConnectorParameterDraft } from '@/lib/connector-add';
import { useTranslation } from '@/lib/i18n';

export function ConnectorParameterForm({ draft, disabled, readOnly = false, onChange, onProbe, suggestion, mismatch }: {
  draft: ConnectorParameterDraft; disabled: boolean; readOnly?: boolean;
  onChange: (fields: Partial<ConnectorParameterDraft>, authTouched?: boolean) => void; onProbe?: () => void;
  suggestion?: ConnectorAuthChoice; mismatch?: boolean;
}) {
  const { t } = useTranslation(); const [advanced, setAdvanced] = useState(false);
  const locked = disabled || readOnly;
  const kind = draft.mode === 'local' ? 'env' : 'headers';
  const labels = { none: '无需认证', key: '密钥', oauth: 'OAuth' };
  return <View className="gap-5">
    <View className="mx-4 gap-2"><Text variant="caption" className="px-1 text-muted-foreground">{t(draft.mode === 'local' ? '命令' : '网址')}</Text>
      <Input testID={draft.mode === 'local' ? 'connector-command' : 'connector-url'} accessibilityLabel={t(draft.mode === 'local' ? '命令（含参数）' : '网址')}
        value={draft.mode === 'local' ? draft.commandLine : draft.url} editable={!locked} autoCapitalize="none" autoCorrect={false}
        placeholder={draft.mode === 'local' ? 'npx -y package --option' : 'https://example.com/mcp'}
        onChangeText={value => onChange(draft.mode === 'local' ? { commandLine: value } : { url: value })} onBlur={onProbe} />
    </View>
    {draft.mode === 'remote' ? <View className="gap-2"><Text variant="caption" className="mx-4 px-1 text-muted-foreground">{t('认证方式')}</Text>
      <ListGroup className="mt-0" inset="content">{(['none', 'key', 'oauth'] as const).map(auth => <GroupRow key={auth} title={t(labels[auth])}
        affordance="selected" selected={draft.auth === auth} disabled={locked} onPress={() => onChange({ auth }, true)} />)}</ListGroup>
      {suggestion ? <View className="mx-4 gap-2"><Text variant="caption" className="text-muted-foreground">{t(mismatch ? '服务要求的认证方式：{method}' : '建议使用{method}', { method: t(labels[suggestion]) })}</Text>
        {mismatch ? <Button intent="soft" disabled={locked} onPress={() => onChange({ auth: suggestion }, true)}><Text>{t('切换为{method}', { method: t(labels[suggestion]) })}</Text></Button> : null}</View> : null}
    </View> : null}
    {draft.mode === 'local' || draft.auth === 'key' ? <View className="mx-4 gap-3">
      <Text variant="caption" className="px-1 text-muted-foreground">{t(kind === 'env' ? '环境变量' : '请求头')}</Text>
      {draft[kind].map((row, index) => <View key={index} className="gap-2 rounded-lg bg-card p-3">
        <View className="flex-row items-center gap-2"><Input tone="muted" accessibilityLabel={t('{kind} {index} 名称', { kind: t(kind === 'env' ? '环境变量' : '请求头'), index: index + 1 })}
          className="flex-1" value={row.key} editable={!locked && !row.existing && !row.deleted} autoCapitalize="none" autoCorrect={false}
          onChangeText={key => onChange({ [kind]: draft[kind].map((item, position) => position === index ? { ...item, key } : item) })} />
          <Button intent="quiet" size="icon" disabled={locked} accessibilityLabel={t(row.deleted ? '撤销删除密钥项' : '删除密钥项')}
            onPress={() => onChange({ [kind]: row.existing ? draft[kind].map((item, position) => position === index ? { ...item, deleted: !item.deleted } : item) : draft[kind].filter((_, position) => position !== index) })}>
            {row.deleted ? <Text>{t('撤销')}</Text> : <Icon as={X} size={20} />}</Button>
        </View>
        {!row.deleted ? <Input tone="muted" secureTextEntry accessibilityLabel={t('{kind} {index} 值', { kind: t(kind === 'env' ? '环境变量' : '请求头'), index: index + 1 })}
          value={row.value} editable={!locked} autoCapitalize="none" autoCorrect={false} placeholder={t(row.existing ? '留空保持已有密钥' : '密钥值')}
          onChangeText={value => onChange({ [kind]: draft[kind].map((item, position) => position === index ? { ...item, value } : item) })} /> : <Text variant="caption">{t('保存后删除')}</Text>}
      </View>)}
      <Button intent="quiet" disabled={locked} onPress={() => onChange({ [kind]: [...draft[kind], { key: '', value: '', existing: false, deleted: false }] })}><Icon as={Plus} size={20} /><Text>{t(kind === 'env' ? '添加环境变量' : '添加请求头')}</Text></Button>
    </View> : null}
    {draft.mode === 'remote' ? <ListGroup className="mt-0" inset="content"><GroupRow title={t('高级')} affordance="disclose" expanded={advanced} onPress={() => setAdvanced(!advanced)} />
      {advanced ? <View>{['auto', 'streamable-http', 'sse'].map(transport => <GroupRow key={transport} title={transport === 'auto' ? t('自动') : transport === 'sse' ? 'SSE' : 'Streamable HTTP'}
        value={transport === 'auto' ? /\/sse\/?$/.test(draft.url.trim()) ? 'SSE' : 'Streamable HTTP' : undefined}
        affordance="selected" selected={draft.transport === transport} disabled={locked} onPress={() => onChange({ transport })} />)}</View> : null}
    </ListGroup> : null}
  </View>;
}
