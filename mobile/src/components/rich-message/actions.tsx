import { useContext, useReducer } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check } from 'lucide-react-native';
import type { z } from 'zod';
import { Button } from '@/components/ui/button.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useTranslation } from '../../lib/i18n.ts';
import { copyReducer, type CopyEvent } from '../../lib/ui-draft.ts';
import { useMountEffect } from '../../lib/use-mount-effect.ts';
import { RichInteractionContext } from './inputs.tsx';
import type { componentSchemas } from './spec.ts';
import { richSpace, richType } from './tokens.ts';

/** Only a mounted done-state owns its reset timer; late clipboard results cannot create one. */
function CopyReset({ operation, dispatch }: { operation: string; dispatch: (event: CopyEvent) => void }) {
  useMountEffect(() => {
    const timer = setTimeout(() => dispatch({ type: 'reset', operation }), 2000);
    return () => clearTimeout(timer);
  });
  return null;
}

/** Copy.idle/done/failed: clipboard is the only side effect; all feedback stays inline. */
export function CopyAction({ props }: { props: z.infer<typeof componentSchemas.Copy> }) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(copyReducer, { status: 'idle' });
  const copy = async () => {
    if (state.status === 'copying') return;
    const operation = `${Date.now()}-${Math.random()}`;
    dispatch({ type: 'start', operation });
    try {
      const copied = await Clipboard.setStringAsync(String(props.text));
      dispatch({ type: copied ? 'done' : 'failed', operation });
    } catch {
      dispatch({ type: 'failed', operation });
    }
  };
  return <View style={{ gap: richSpace.xs, flexShrink: 1 }}>
    {state.status === 'done' ? <CopyReset key={state.operation} operation={state.operation} dispatch={dispatch} /> : null}
    <Button intent="soft" disabled={state.status === 'copying'} onPress={() => void copy()} accessibilityLabel={props.label}>
      {state.status === 'done' ? <Icon as={Check} size={16} className="text-foreground" /> : null}
      <Text>{state.status === 'done' ? t('已复制') : props.label}</Text>
    </Button>
    {state.status === 'failed' ? <Text variant="caption" className="text-muted-foreground">{t('无法复制')}</Text> : null}
  </View>;
}

/** One group = one submission slot. A durable receipt keeps just the chosen suggestion. */
export function FollowUpsDisplay({ props, elementId }: { props: z.infer<typeof componentSchemas.FollowUps>; elementId: string }) {
  const { t } = useTranslation();
  const { submitted, submitDisabled, pending, send, actionId, sentActionId } = useContext(RichInteractionContext);
  return <View className="flex-row flex-wrap" style={{ gap: richSpace.sm }}>
    {props.items.map((item, index) => {
      const id = `${elementId}/${index}`;
      if (submitted) return id === sentActionId ? <Text key={id} style={richType.body}>{item.label}</Text> : null;
      return <Button key={id} intent="soft" disabled={submitDisabled} onPress={() => send!(id)} accessibilityLabel={item.label}>
        <Text>{pending && actionId === id ? t('正在发送…') : item.label}</Text>
      </Button>;
    })}
  </View>;
}
