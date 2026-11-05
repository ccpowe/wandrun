import { act, render, screen } from '@testing-library/react-native';
import { StrictMode } from 'react';
import { AppState, Text, type AppStateStatus } from 'react-native';
import { useMinuteClock } from '../src/lib/use-minute-clock';

function Clock() { return <Text testID="clock">{useMinuteClock().toISOString()}</Text>; }
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-30T23:59:30Z')); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('G1 分钟时钟在跨日时更新，StrictMode 重放后仍按真实时刻显示', async () => {
  await render(<StrictMode><Clock /></StrictMode>);
  expect(screen.getByTestId('clock')).toHaveTextContent('2026-10-30T23:59:30.000Z');
  await act(() => jest.advanceTimersByTime(60_000));
  expect(screen.getByTestId('clock')).toHaveTextContent('2026-10-31T00:00:30.000Z');
});

test('G1 后台暂停计时后回前台立即刷新，不等下一分钟', async () => {
  let foreground: ((state: AppStateStatus) => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') foreground = listener;
    return { remove() {} };
  });
  await render(<Clock />);
  await act(() => { jest.setSystemTime(new Date('2026-11-01T08:00:00Z')); foreground?.('active'); });
  expect(screen.getByTestId('clock')).toHaveTextContent('2026-11-01T08:00:00.000Z');
});
