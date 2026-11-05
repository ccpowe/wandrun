import { fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectorIcon } from '../src/components/connector-icon';

const svg = 'https://mcp.notion.com/notion-logo-block-sticker.svg';

test.each(['notion', 'github', 'amap'] as const)('ConnectorIcon.builtin %s ignores server SVG even after an image error', async appId => {
  const view = await render(<ConnectorIcon name="品牌连接器" appId={appId} uri={svg} />);
  const local = appId === 'notion' ? require('../assets/apps/notion.png') : appId === 'amap' ? require('../assets/apps/amap.png') : require('../assets/apps/github.png');
  // Image source is the native rendering boundary: a remote SVG must never be requested.
  expect(screen.getByTestId('connector-icon-image').props.source).toEqual(local);
  await fireEvent(screen.getByTestId('connector-icon-image'), 'error', { nativeEvent: { error: 'decode failed' } });
  expect(screen.getByTestId('connector-icon-image').props.source).toEqual(local);
  expect(screen.queryByText('品')).toBeNull();
  await view.rerender(<ConnectorIcon name="品牌连接器" appId={appId} uri="https://example.invalid/new.svg" large />);
  expect(screen.getByTestId('connector-icon-image').props.source).toEqual(local);
});

test('ConnectorIcon.remote SVG failure keeps the initial visible and changing sources retries', async () => {
  const view = await render(<ConnectorIcon name="自定义" uri={svg} />);
  expect(screen.getByText('自')).toBeOnTheScreen();
  expect(screen.getByTestId('connector-icon-image', { includeHiddenElements: true }).props.source).toEqual({ uri: svg });
  expect(screen.getByTestId('connector-icon-image', { includeHiddenElements: true })).toHaveStyle({ opacity: 0 });
  await fireEvent(screen.getByTestId('connector-icon-image', { includeHiddenElements: true }), 'error', { nativeEvent: { error: 'unsupported SVG' } });
  expect(screen.getByText('自')).toBeOnTheScreen();
  expect(screen.queryByTestId('connector-icon-image', { includeHiddenElements: true })).toBeNull();
  await view.rerender(<ConnectorIcon name="自定义" uri="https://example.invalid/logo.png" />);
  expect(screen.getByText('自')).toBeOnTheScreen();
  expect(screen.getByTestId('connector-icon-image', { includeHiddenElements: true }).props.source).toEqual({ uri: 'https://example.invalid/logo.png' });
  await fireEvent(screen.getByTestId('connector-icon-image', { includeHiddenElements: true }), 'load', { nativeEvent: { source: { width: 32, height: 32 } } });
  expect(screen.queryByText('自')).toBeNull();
  expect(screen.getByTestId('connector-icon-image')).not.toHaveStyle({ opacity: 0 });
});

test('ConnectorIcon.fallback handles invalid URLs and Unicode initials', async () => {
  const view = await render(<ConnectorIcon name="  😀应用" uri="file:///not-a-server-icon" />);
  expect(screen.getByText('😀')).toBeOnTheScreen();
  expect(screen.queryByTestId('connector-icon-image', { includeHiddenElements: true })).toBeNull();
  await view.rerender(<ConnectorIcon name=" " />);
  expect(screen.getByText('?')).toBeOnTheScreen();
});
