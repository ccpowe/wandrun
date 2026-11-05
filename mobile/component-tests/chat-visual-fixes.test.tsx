import { fireEvent, render, screen } from '@testing-library/react-native';
import { useSharedValue } from 'react-native-reanimated';

import { AttachmentDrafts, CHIP, REMOVE, RETRY } from '../src/components/chat/attachment-drafts';
import { ConversationCard, type ConversationCardTask } from '../src/components/chat/conversation-card';
import { Button } from '../src/components/ui/button';
import { Icon } from '../src/components/ui/icon';

const seen: { className?: string }[] = [];
function ProbeIcon(props: { className?: string }) { seen.push(props); return null; }

test('quiet 图标按钮禁用：调用方写死的颜色（如沉浸白、灰）也转为淡灰；启用时保留调用方颜色', async () => {
  seen.length = 0;
  await render(<>
    <Button intent="quiet" size="icon" disabled accessibilityLabel="下载图片"><Icon as={ProbeIcon as never} className="size-5 text-immersive-foreground" /></Button>
    <Button intent="quiet" size="icon" disabled accessibilityLabel="引用"><Icon as={ProbeIcon as never} className="size-[18px] text-muted-foreground" /></Button>
    <Button intent="quiet" size="icon" accessibilityLabel="分享图片"><Icon as={ProbeIcon as never} className="size-5 text-immersive-foreground" /></Button>
  </>);
  const [download, quote, share] = seen.map(props => props.className ?? '');
  expect(download).toMatch(/text-muted-foreground\/60$/);
  expect(download).not.toContain('text-immersive-foreground');
  expect(quote).toMatch(/text-muted-foreground\/60$/);
  expect(share).toContain('text-immersive-foreground');
  expect(share).not.toContain('/60');
});

const failed = { id: 'f1', name: 'notes.pdf', mediaType: 'application/pdf', size: 10, uploadUrl: null, fileId: null, progress: 0, error: '上传失败' };

test('chat.B9 失败附件卡：重试与移除各自命中，移除的扩展触区够不到重试按钮', async () => {
  // Vertical reach measured from the chip top: the × sits at the corner, retry at the bottom.
  const removeBottom = REMOVE.size - REMOVE.offset + REMOVE.hitSlop.bottom;
  const retryTop = CHIP - RETRY.bottom - RETRY.size;
  expect(removeBottom).toBeLessThanOrEqual(retryTop);
  expect(REMOVE.size + REMOVE.hitSlop.top + REMOVE.hitSlop.bottom).toBeGreaterThanOrEqual(40);
  expect(REMOVE.size + REMOVE.hitSlop.left + REMOVE.hitSlop.right).toBeGreaterThanOrEqual(48);
  const onRetry = jest.fn();
  const onRemove = jest.fn();
  await render(<AttachmentDrafts items={[failed]} onRetry={onRetry} onRemove={onRemove} />);
  expect(screen.getByTestId('upload-remove-f1').props.hitSlop).toEqual(REMOVE.hitSlop);
  await fireEvent.press(screen.getByTestId('upload-retry-f1'));
  expect(onRetry).toHaveBeenCalledWith('f1');
  expect(onRemove).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('upload-remove-f1'));
  expect(onRemove).toHaveBeenCalledWith('f1');
  expect(screen.getByText('上传失败')).toBeOnTheScreen();
});

function Card({ tasks }: { tasks: ConversationCardTask[] }) {
  const progress = useSharedValue(1);
  return <ConversationCard tasks={tasks} progress={progress} now={new Date(2026, 10, 1, 12)} onSelect={() => {}} />;
}

test('chat.I1 子对话行的无障碍名称包含标题、成员、状态、时间与“需要处理”', async () => {
  const at = new Date(2026, 10, 1, 11, 58).getTime() / 1000;
  await render(<Card tasks={[
    { id: 't1', title: '整理阅读笔记模板', member: { name: '执行者', avatar: 4 }, status: 'requested', activityAt: at, attention: true, working: false },
    { id: 't2', title: '', member: { name: '研究员', avatar: 0 }, status: 'running', activityAt: at, attention: false, working: false },
  ]} />);
  const first = screen.getByTestId('chat-child-t1').props.accessibilityLabel as string;
  expect(first).toMatch(/^整理阅读笔记模板，执行者 · 等你接管 · .+，需要处理$/);
  const second = screen.getByTestId('chat-child-t2').props.accessibilityLabel as string;
  expect(second).toMatch(/^新对话，研究员 · 进行中 · /);
  expect(second).not.toContain('需要处理');
});
