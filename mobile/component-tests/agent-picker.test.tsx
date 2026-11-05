import { render, screen } from '@testing-library/react-native';

import { NewChatAgentChips } from '../src/components/chat/agent-picker';

// gorhom's own Jest mock (its testing guide): the sheet's native layout/animation does not run under Jest.
jest.mock('@gorhom/bottom-sheet', () => ({ __esModule: true, ...jest.requireActual('@gorhom/bottom-sheet/mock') }));

const agents = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, avatar) => ({ id, name: `Agent ${id.toUpperCase()}`, avatar, description: `说明 ${id}` }));


test('chat.N2 胶囊行保留最近窗口，并准确标记当前选择', async () => {
  await render(<NewChatAgentChips recent={agents} selectedId="c" onSelect={() => {}} onOpenAll={() => {}} />);
  expect(screen.getAllByRole('radio')).toHaveLength(5);
  expect(screen.queryByTestId('new-chat-agent-f')).toBeNull();
  expect(screen.getByTestId('new-chat-agent-c')).toBeSelected();
  expect(screen.getByTestId('new-chat-agent-a')).not.toBeSelected();
});

test('chat.N2 目录超过最近窗口才提供全部列表入口', async () => {
  const view = await render(<NewChatAgentChips recent={agents} selectedId="a" onSelect={() => {}} onOpenAll={() => {}} />);
  expect(screen.getByTestId('new-chat-agent-all')).toBeOnTheScreen();
  await view.rerender(<NewChatAgentChips recent={agents.slice(0, 5)} selectedId="a" onSelect={() => {}} onOpenAll={() => {}} />);
  expect(screen.queryByTestId('new-chat-agent-all')).toBeNull();
  expect(screen.getAllByRole('radio')).toHaveLength(5);
});

test('chat.N2 当前 Agent 不在最近 5 个时放到行首', async () => {
  await render(<NewChatAgentChips recent={agents} selectedId="g" onSelect={() => {}} onOpenAll={() => {}} />);
  const chips = screen.getAllByRole('radio');
  expect(chips[0]).toBe(screen.getByTestId('new-chat-agent-g'));
  expect(chips[0]).toBeSelected();
  expect(screen.queryByTestId('new-chat-agent-e')).toBeNull();
});

