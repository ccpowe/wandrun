import { PortalHost } from '@rn-primitives/portal';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind, useUniwind } from 'uniwind';

import { AgentMessageContent } from '@/components/chat/agent-message-content';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { GatewayApi } from '@/gateway/api';
import { ChatSession } from '@/gateway/session';
import { uiSubmissionFromEvent } from '@/lib/agent-message';
import type { UiSubmission } from '@/lib/agent-message';
import { Credentials } from '@/lib/credentials';
import { SessionProvider } from '@/lib/session-context';
import { useMountEffect } from '@/lib/use-mount-effect';
import { FakeGateway } from '../fake-gateway';
import { SceneProviders } from '../scene-providers';
import { SketchPhoneFrame } from '../story-frames/sketch-phone-frame';
import type { RichFixture } from './rich-fixtures';

export type RichStoryProps = { fixture: RichFixture; mode?: 'editable' | 'submitted' | 'submitting' | 'error' | 'unknown' | 'checking'; actionId?: string };
const submittedAt = '2026-10-30T10:42:00+08:00';

function RichExample({ fixture, mode = 'editable', actionId }: RichStoryProps) {
  const { theme } = useUniwind();
  const firstSend = Object.entries(fixture.spec.elements).find(([, node]) => node.type === 'FollowUps' || node.props.send);
  const selectedAction = actionId ?? (firstSend ? firstSend[1].type === 'FollowUps' ? `${firstSend[0]}/0` : firstSend[0] : undefined);
  const [peer] = useState(() => {
    let failedCheck = false;
    const gateway = new FakeGateway({}, {
      'POST /conversations/:id/ui-submissions': () => mode === 'error'
        ? Response.json({ error: { code: 'rate_limited', message: '发送失败，请重试。' } }, { status: 429 })
        : undefined,
      'GET /conversations/:id/ui-submissions': () => {
        if (mode === 'unknown' && !failedCheck) { failedCheck = true; throw new Error('Storybook lookup interrupted'); }
        return undefined;
      },
    });
    gateway.state.histories.set('rich-story', [{ seq: 1, type: 'message.agent', at: 1, conversation_id: 'rich-story',
      data: { text: `\`\`\`wandrun-ui\n${JSON.stringify(fixture.spec)}\n\`\`\``, ui: [{ block: 0, valid: true }] } }]);
    return gateway;
  });
  const [submission, setSubmission] = useState<UiSubmission | undefined>(() => mode === 'submitted'
    ? { values: fixture.spec.state, createdAt: submittedAt, ...(selectedAction ? { actionId: selectedAction } : {}) } : undefined);
  // A state-only owner with an in-memory fetch: no streams, query bridge or native transports
  // are started. Hook subscriptions own their lifetime; there is no transport to close on remount.
  const [stateSession] = useState(() => {
    if (mode !== 'submitting' && mode !== 'unknown' && mode !== 'checking') return undefined;
    const session = new ChatSession({ baseUrl: 'https://rich-story.invalid', token: 'story', computerId: 'rich-story' }, peer.fetch);
    session.connection = 'open';
    session.saveUiDraft('rich-story', 1, 0, {
      values: fixture.spec.state,
      flow: { status: mode === 'checking' ? 'checking' : mode === 'unknown' ? 'unknown' : 'sending',
        attempt: { values: fixture.spec.state, clientId: 'story-pending', ...(selectedAction ? { actionId: selectedAction } : {}) } },
    });
    return session;
  });
  useMountEffect(() => {
    const previous = Uniwind.currentTheme;
    Uniwind.setTheme('light');
    return () => { Uniwind.setTheme(previous); };
  });
  return <SketchPhoneFrame><View className="flex-1 bg-background">
    <View className="flex-row items-center justify-between border-b border-border px-4 py-2">
      <Text className="text-xs text-muted-foreground">本地预览 · 不连接网关</Text>
      <Button size="sm" intent="soft" accessibilityLabel="切换富消息预览主题"
        onPress={() => Uniwind.setTheme(theme === 'dark' ? 'light' : 'dark')}><Text>{theme === 'dark' ? '浅色' : '深色'}</Text></Button>
    </View>
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled" contentContainerClassName="p-4 pb-16">
      <AgentMessageContent text={`\`\`\`wandrun-ui\n${JSON.stringify(fixture.spec)}\n\`\`\``}
        ui={[{ block: 0, valid: true, files: fixture.files }]} attachments={fixture.attachments}
        submissions={submission ? new Map([[0, submission]]) : undefined}
        draftOwner={stateSession ? { session: stateSession, conversationId: 'rich-story', messageSeq: 1 } : undefined}
        onSubmit={async (_block, values, clientId, actionId) => {
          const api = new GatewayApi({ baseUrl: 'https://rich-story.invalid', token: 'story' }, peer.fetch);
          try {
            const { event } = await api.submitUi('rich-story', clientId, 1, 0, values, actionId);
            setSubmission(uiSubmissionFromEvent(event)!.submission);
          } finally { api.close(); }
        }} />
    </ScrollView>
    <PortalHost />
  </View></SketchPhoneFrame>;
}

/** Real message fence parsing, Spec validation, json-render registry and local input state. */
export function RichStory(props: RichStoryProps) {
  const [runtime] = useState(() => {
    const storage = new Map<string, string>();
    return {
      credentials: new Credentials({
        getItemAsync: async key => storage.get(key) ?? null,
        setItemAsync: async (key, value) => { storage.set(key, value); },
        deleteItemAsync: async key => { storage.delete(key); },
      }),
      fetch: new FakeGateway().fetch,
    };
  });
  return <GestureHandlerRootView style={{ flex: 1 }}><SessionProvider runtime={runtime}><SceneProviders>
    <RichExample key={`${JSON.stringify(props.fixture)}:${props.mode ?? 'editable'}:${props.actionId ?? ''}`} {...props} />
  </SceneProviders></SessionProvider></GestureHandlerRootView>;
}
