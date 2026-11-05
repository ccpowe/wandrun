import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '../src/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../src/components/ui/dialog';
import { Text } from '../src/components/ui/text';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('确认框取消不执行删除，确认执行一次并关闭', async () => {
    const remove = jest.fn();
    function Confirmation() {
      const [open, setOpen] = useState(true);
      return <><AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent portalHost="test-alert"><AlertDialogTitle>删除对话？</AlertDialogTitle><AlertDialogDescription>删除不能恢复。</AlertDialogDescription>
          <AlertDialogCancel><Text>取消</Text></AlertDialogCancel>
          <AlertDialogAction destructive onPress={remove}><Text>删除</Text></AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog><PortalHost name="test-alert" /></>;
    }
    const view = await render(<Confirmation />);
    await fireEvent.press(screen.getByText('取消'));
    await act(() => jest.runAllTimers());
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByText('删除对话？')).toBeNull();
    await view.unmount();
    await render(<Confirmation />);
    await fireEvent.press(screen.getByText('删除'));
    await act(() => jest.runAllTimers());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('删除对话？')).toBeNull();
  });

test('filled 对话框关闭入口保留原语行为', async () => {
  function Information() {
    const [open, setOpen] = useState(true);
    return <><Dialog open={open} onOpenChange={setOpen}><DialogContent surface="filled" portalHost="test-dialog"><DialogTitle>连接器详情</DialogTitle><DialogDescription>说明</DialogDescription></DialogContent></Dialog><PortalHost name="test-dialog" /></>;
  }
  await render(<Information />);
  await fireEvent.press(screen.getByLabelText('关闭'));
  await act(() => jest.runAllTimers());
  expect(screen.queryByText('连接器详情')).toBeNull();
});
