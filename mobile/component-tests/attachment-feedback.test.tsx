import { fireEvent, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AgentMemoryMarkdown } from '../src/components/agent-memory-markdown';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
jest.mock('expo-clipboard', () => ({ ...jest.requireActual('expo-clipboard') }));
function MarkdownPage() { return <AgentMemoryMarkdown selectable content="[参考资料](https://example.org/source)" />; }

test('markdown.A1 复制失败就地显示，菜单关闭但原正文与链接仍可用', async () => {
  jest.useFakeTimers();
  const peer = new FakeGateway(); seedGatewayAgent(peer);
  jest.spyOn(Clipboard, 'setStringAsync').mockRejectedValue(new Error('clipboard unavailable'));
  try {
    await renderGateway(peer, MarkdownPage, '/');
    await fireEvent(screen.getByText('参考资料'), 'longPress', { nativeEvent: { pageX: 40, pageY: 100 } });
    await tick();
    await fireEvent.press(screen.getByLabelText('复制链接')); await tick();
    expect(screen.getByTestId('markdown-link-error')).toHaveTextContent(/剪贴板不可用/);
    expect(screen.getByText('参考资料')).toBeOnTheScreen();
    expect(screen.queryByLabelText('复制链接')).toBeNull();
  } finally { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); }
});
