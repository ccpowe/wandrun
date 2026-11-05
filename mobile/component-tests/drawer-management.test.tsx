import * as BottomSheetModule from '@gorhom/bottom-sheet';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ComponentProps, ReactNode } from 'react';
import { Text } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';

import { ConversationDrawer, type DrawerConversation } from '../src/components/chat/conversation-drawer';
import { SceneProviders } from '../src/dev/scene-providers';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('@gorhom/bottom-sheet', () => {
  const React = jest.requireActual('react');
  const official = jest.requireActual('@gorhom/bottom-sheet/mock');
  const { View } = jest.requireActual('react-native');
  // The official mock omits backdrop render slots and their children. Preserve those
  // public children through a native View; tap behavior comes from the real app control.
  class Sheet extends official.default {
    render() {
      return React.createElement(React.Fragment, null, super.render(), this.props.backdropComponent?.({
        animatedIndex: { value: 0 }, animatedPosition: { value: 0 },
      }));
    }
  }
  return { __esModule: true, ...official, default: Sheet, BottomSheetBackdrop: View };
});

type DrawerProps = ComponentProps<typeof ConversationDrawer>;
type NativeSheetProps = ComponentProps<typeof BottomSheetModule.default>;
const nativeSheet = jest.requireMock('@gorhom/bottom-sheet').default as {
  prototype: { render(): ReactNode; close(): void };
};
let sheetRender: jest.SpyInstance;
let sheetClose: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  sheetRender = jest.spyOn(nativeSheet.prototype, 'render');
  sheetClose = jest.spyOn(nativeSheet.prototype, 'close');
  jest.spyOn(KeyboardController, 'dismiss').mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

function sheetProps(): NativeSheetProps {
  const instance = sheetRender.mock.contexts.at(-1) as { props: NativeSheetProps } | undefined;
  if (!instance) throw new Error('Native sheet has not rendered');
  return instance.props;
}
function publicPress(testID: string) {
  const props = screen.getByTestId(testID).props;
  const callback = props.onPress ?? props.onClick;
  if (typeof callback !== 'function') throw new Error(`Public press event missing: ${testID}`);
  return () => callback({ nativeEvent: {}, target: 1, currentTarget: 1 });
}
const row: DrawerConversation = { id: 'same', title: 'Original', unread: false, running: false,
  activityAt: 1, agent: { name: 'Agent', avatar: 0 }, collaborationCount: 0 };

async function fixture(overrides: Partial<DrawerProps> = {}) {
  let props: DrawerProps = {
    children: <Text>Chat content</Text>, open: true, closing: false, closeTicket: null, drawerVisit: {},
    onOpen: jest.fn(), agents: [], connected: true, conversations: [row], currentId: row.id,
    onSelect: jest.fn(), onNewConversation: jest.fn(), onRename: jest.fn(async () => true),
    onDelete: jest.fn(async () => true), failureMessage: () => 'Please retry', onRequestClose: jest.fn(), ...overrides,
  };
  const view = await render(<SceneProviders><ConversationDrawer {...props} /></SceneProviders>);
  return {
    async update(changes: Partial<DrawerProps>) {
      props = { ...props, ...changes };
      await view.rerender(<SceneProviders><ConversationDrawer {...props} /></SceneProviders>);
    },
  };
}
async function openManagement(kind: 'rename' | 'delete') {
  await fireEvent(screen.getByTestId(`conversation-${row.id}`), 'longPress', { nativeEvent: { pageX: 44, pageY: 300 } });
  await fireEvent.press(screen.getByTestId(`conversation-menu-${kind}`));
}

for (const source of ['backdrop', 'pan-down'] as const) {
  test(`rename ${source}: native close-start rejects confirm and IME in the same commit, then waits for native completion`, async () => {
    const dismiss = Promise.withResolvers<void>();
    jest.mocked(KeyboardController.dismiss).mockReturnValue(dismiss.promise);
    const onRename = jest.fn(async () => true);
    await fixture({ onRename });
    await openManagement('rename');
    const confirm = publicPress('conversation-rename-confirm');
    const ime = screen.getByTestId('conversation-rename-input').props.onSubmitEditing;
    const native = sheetProps();
    const backdrop = publicPress('conversation-rename-backdrop');
    await act(() => {
      if (source === 'backdrop') backdrop();
      else native.onAnimate?.(0, -1, 300, 800);
      confirm();
      ime();
    });
    expect(screen.getByTestId('conversation-rename-confirm')).toBeDisabled();
    expect(screen.getByTestId('conversation-rename-input')).toHaveProp('editable', false);
    expect(onRename).not.toHaveBeenCalled();
    expect(sheetClose).not.toHaveBeenCalled();
    await act(async () => { dismiss.resolve(); await dismiss.promise; });
    expect(sheetClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('conversation-rename-input')).toBeOnTheScreen();
    await act(() => native.onClose?.());
    expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
}

test('rename IME + confirm sends one command; failure keeps the draft and explicit retry sends one new command', async () => {
  const first = Promise.withResolvers<boolean>();
  const retry = Promise.withResolvers<boolean>();
  const onRename = jest.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => retry.promise);
  await fixture({ onRename });
  await openManagement('rename');
  await fireEvent.changeText(screen.getByTestId('conversation-rename-input'), 'Edited');
  const ime = screen.getByTestId('conversation-rename-input').props.onSubmitEditing;
  const confirm = publicPress('conversation-rename-confirm');
  await act(() => { ime(); confirm(); });
  expect(onRename).toHaveBeenCalledTimes(1);
  expect(onRename).toHaveBeenLastCalledWith('same', 'Edited');
  expect(screen.getByTestId('conversation-rename-confirm')).toBeDisabled();
  await act(async () => { first.resolve(false); await first.promise; });
  expect(screen.getByText('Please retry')).toBeOnTheScreen();
  expect(screen.getByTestId('conversation-rename-input')).toHaveProp('value', 'Edited');
  expect(screen.getByTestId('conversation-rename-confirm')).toBeEnabled();
  const retryPress = publicPress('conversation-rename-confirm');
  await act(() => { retryPress(); retryPress(); });
  expect(onRename).toHaveBeenCalledTimes(2);
  await act(async () => { retry.resolve(true); await retry.promise; });
  expect(sheetClose).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('conversation-rename-confirm')).toBeDisabled();
  await act(() => sheetProps().onClose?.());
  expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
});

test('delete two public submissions in one act send once; explicit retry after failure sends once again', async () => {
  const first = Promise.withResolvers<boolean>();
  const retry = Promise.withResolvers<boolean>();
  const onDelete = jest.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => retry.promise);
  await fixture({ onDelete });
  await openManagement('delete');
  const confirm = publicPress('conversation-delete-confirm');
  await act(() => { confirm(); confirm(); });
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('conversation-delete-confirm')).toBeDisabled();
  await act(async () => { first.resolve(false); await first.promise; });
  expect(screen.getByText('Please retry')).toBeOnTheScreen();
  const retryPress = publicPress('conversation-delete-confirm');
  await act(() => { retryPress(); retryPress(); });
  expect(onDelete).toHaveBeenCalledTimes(2);
  await act(async () => { retry.resolve(true); await retry.promise; });
  expect(screen.queryByTestId('conversation-delete-confirm')).toBeNull();
});

for (const kind of ['rename', 'delete'] as const) {
  test(`${kind}: deletion from another consumer removes the editable surface before any command is admitted`, async () => {
    const command = jest.fn(async () => true);
    const f = await fixture(kind === 'rename' ? { onRename: command } : { onDelete: command });
    await openManagement(kind);
    await f.update({ conversations: [] });
    expect(screen.queryByTestId(`conversation-${kind}-confirm`)).toBeNull();
    expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });
  for (const success of [true, false]) {
    test(`${kind}: external deletion before the ${success ? 'success' : 'failure'} result wins and late completion cannot restore the overlay`, async () => {
      const result = Promise.withResolvers<boolean>();
      const command = jest.fn(() => result.promise);
      const f = await fixture(kind === 'rename' ? { onRename: command } : { onDelete: command });
      await openManagement(kind);
      await fireEvent.press(screen.getByTestId(`conversation-${kind}-confirm`));
      expect(command).toHaveBeenCalledTimes(1);
      await f.update({ conversations: [] });
      expect(screen.queryByTestId(`conversation-${kind}-confirm`)).toBeNull();
      await act(async () => { result.resolve(success); await result.promise; });
      expect(screen.queryByTestId(`conversation-${kind}-confirm`)).toBeNull();
      expect(screen.queryByText('Please retry')).toBeNull();
      expect(command).toHaveBeenCalledTimes(1);
    });
  }
}

test('reopening the same resource is a new overlay visit; old native start/end and write results cannot touch its draft', async () => {
  const oldResult = Promise.withResolvers<boolean>();
  const onRename = jest.fn(() => oldResult.promise);
  const f = await fixture({ onRename });
  await openManagement('rename');
  const previousNative = sheetProps();
  await fireEvent.press(screen.getByTestId('conversation-rename-confirm'));
  await f.update({ open: false, closing: true });
  await f.update({ open: true, closing: false, drawerVisit: {} });
  expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
  await openManagement('rename');
  await fireEvent.changeText(screen.getByTestId('conversation-rename-input'), 'New visit draft');
  await act(() => { previousNative.onAnimate?.(0, -1, 300, 800); previousNative.onClose?.(); });
  await act(async () => { oldResult.resolve(false); await oldResult.promise; });
  expect(screen.getByTestId('conversation-rename-input')).toHaveProp('value', 'New visit draft');
  expect(screen.getByTestId('conversation-rename-confirm')).toBeEnabled();
  expect(screen.queryByText('Please retry')).toBeNull();
  expect(sheetClose).not.toHaveBeenCalled();
  expect(onRename).toHaveBeenCalledTimes(1);
});

test('close phase and a later visit preserve the ScrollView, rows and minute clock instead of remounting content', async () => {
  const intervals = jest.spyOn(globalThis, 'setInterval');
  const f = await fixture();
  const scroll = screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onScrollBeginDrag === 'function')[0];
  if (!scroll) throw new Error('Drawer native ScrollView missing');
  const originalRow = screen.getByTestId('conversation-same');
  const clockSubscriptions = intervals.mock.calls.filter(([, delay]) => delay === 60_000).length;
  expect(clockSubscriptions).toBeGreaterThan(0);
  await fireEvent(scroll, 'scroll', { nativeEvent: { contentOffset: { x: 0, y: 360 }, contentSize: { width: 400, height: 1500 }, layoutMeasurement: { width: 400, height: 500 } } });
  await openManagement('rename');
  await f.update({ open: false, closing: true });
  expect(screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onScrollBeginDrag === 'function')[0]).toBe(scroll);
  expect(screen.getByTestId('conversation-same')).toBe(originalRow);
  expect(intervals.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(clockSubscriptions);
  await f.update({ open: false, closing: false });
  await f.update({ open: true, drawerVisit: {} });
  expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
  expect(screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onScrollBeginDrag === 'function')[0]).toBe(scroll);
  expect(screen.getByTestId('conversation-same')).toBe(originalRow);
  expect(intervals.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(clockSubscriptions);
});
