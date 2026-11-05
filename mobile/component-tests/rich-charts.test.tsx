import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView, State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { RichBarChart, RichLineChart, RichPieChart } from '../src/components/rich-message/charts';

jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));

async function measure(kind: 'line' | 'bar') {
  await fireEvent(screen.getByTestId(`rich-${kind}-chart`), 'layout', { nativeEvent: { layout: { width: 360, height: 300, x: 0, y: 0 } } });
}
async function tap(x: number, y = 50) {
  await act(() => fireGestureHandler(getByGestureTestId('drawer-content-tap'), [
    { state: State.BEGAN, x, y }, { state: State.ACTIVE, x, y }, { state: State.END, x, y },
  ]));
}
function readoutHeight(id = 'rich-chart-readout') {
  const height = StyleSheet.flatten(screen.getByTestId(id).props.style).height;
  expect(typeof height).toBe('number');
  expect(height).toBeGreaterThan(0);
  return height;
}
const series = [{ name: '收入', values: [12, -4, 29] }, { name: '支出', values: [8, -2, 21] }];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('Chart.default / held 与 rich.T7a/b：初始只放图例，点选/取消与拖动保持，读数槽高度不变', async () => {
  await render(<GestureHandlerRootView><RichLineChart props={{ title: '本周变化', unit: '元', xLabels: ['周一', '周二', '周三'], series }} /></GestureHandlerRootView>);
  await measure('line');
  const height = readoutHeight();
  let readout = within(screen.getByTestId('rich-chart-readout'));
  expect(readout.getByText('收入')).toBeOnTheScreen();
  expect(readout.queryByText('周三')).toBeNull();
  expect(readout.queryByText('29')).toBeNull();
  await tap(100);
  expect(within(screen.getByTestId('rich-chart-readout')).getByText('12')).toBeOnTheScreen();
  expect(readoutHeight()).toBe(height);
  await tap(100);
  expect(within(screen.getByTestId('rich-chart-readout')).queryByText('12')).toBeNull();
  expect(readoutHeight()).toBe(height);
  await act(() => fireGestureHandler(getByGestureTestId('drawer-content-scrub'), [
    { state: State.BEGAN, x: 100, y: 50 }, { state: State.ACTIVE, x: 100, y: 50 },
    { state: State.ACTIVE, x: 210, y: 50 }, { state: State.CANCELLED, x: 210, y: 50 },
  ]));
  readout = within(screen.getByTestId('rich-chart-readout'));
  expect(readout.getByText('周二')).toBeOnTheScreen();
  expect(readout.getByText('-4')).toBeOnTheScreen();
  expect(readout.getByText('-2')).toBeOnTheScreen();
  expect(readoutHeight()).toBe(height);
  await tap(210);
  expect(within(screen.getByTestId('rich-chart-readout')).queryByText('周二')).toBeNull();
  expect(readoutHeight()).toBe(height);
});

test('Chart.data：类别为行、系列为列，精确原值逐格可读，再按收起', async () => {
  await render(<RichLineChart props={{ xLabels: ['周一', '周二'], unit: '元', series: [{ name: '原值', values: [1.23456789e-7, Number.MAX_VALUE] }] }} />);
  await fireEvent.press(screen.getByRole('button', { name: '查看图表数据' }));
  const table = within(screen.getByTestId('rich-line-data-table'));
  expect(table.getByText('类别')).toBeOnTheScreen();
  expect(table.getByText('原值')).toBeOnTheScreen();
  expect(table.getByLabelText('周一 · 原值：1.23456789e-7 元')).toBeOnTheScreen();
  expect(table.getByLabelText(`周二 · 原值：${Number.MAX_VALUE} 元`)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '查看图表数据' }));
  expect(screen.queryByTestId('rich-line-data-table')).toBeNull();
});

test('BarChart.multi / negative / horizontal：竖排类别拖选与横排类别拖选均保持整组原值', async () => {
  for (const horizontal of [false, true]) {
    const view = await render(<GestureHandlerRootView><RichBarChart props={{ labels: ['官网', '社群', '搜索'], series, horizontal }} /></GestureHandlerRootView>);
    await measure('bar');
    const height = readoutHeight();
    expect(within(screen.getByTestId('rich-chart-readout')).queryByText('搜索')).toBeNull();
    await act(() => fireGestureHandler(getByGestureTestId('drawer-content-scrub'), [
      { state: State.BEGAN, x: 100, y: 20 }, { state: State.ACTIVE, x: 100, y: 20 }, { state: State.END, x: 100, y: 20 },
    ]));
    const readout = within(screen.getByTestId('rich-chart-readout'));
    expect(readout.getByText('官网')).toBeOnTheScreen();
    expect(readout.getByText('12')).toBeOnTheScreen();
    expect(readout.getByText('8')).toBeOnTheScreen();
    expect(readoutHeight()).toBe(height);
    await tap(100, 20);
    expect(within(screen.getByTestId('rich-chart-readout')).queryByText('12')).toBeNull();
    expect(readoutHeight()).toBe(height);
    await fireEvent.press(screen.getByRole('button', { name: '查看图表数据' }));
    expect(screen.getByLabelText('社群 · 收入：-4')).toBeOnTheScreen();
    await view.unmount();
  }
});

test('Chart.empty / zero / single：空集合保留标题；全零有基线提示；单点点选读数', async () => {
  for (const chart of [
    <RichLineChart key="line" props={{ title: '空折线', xLabels: [], series: [] }} />,
    <RichBarChart key="bar" props={{ title: '空柱图', labels: [], series: [] }} />,
    <RichPieChart key="pie" props={{ title: '空饼图', items: [] }} />,
  ]) {
    const view = await render(chart);
    expect(screen.getByText(/^空(折线|柱图|饼图)$/)).toBeOnTheScreen();
    expect(screen.getByText('暂无数据')).toBeOnTheScreen();
    expect(screen.queryByTestId('rich-chart-readout')).toBeNull();
    await view.unmount();
  }
  for (const chart of [
    <RichLineChart key="line" props={{ xLabels: ['今天'], series: [{ name: '完成', values: [0] }] }} />,
    <RichBarChart key="bar" props={{ labels: ['今天'], series: [{ name: '完成', values: [0] }] }} />,
  ]) {
    const view = await render(chart);
    expect(within(screen.getByTestId('rich-chart-readout')).getByText('完成')).toBeOnTheScreen();
    expect(screen.getByText('本期都是 0')).toBeOnTheScreen();
    expect(screen.getByTestId('rich-chart-zero-baseline')).toBeOnTheScreen();
    await view.unmount();
  }
  await render(<GestureHandlerRootView><RichLineChart props={{ xLabels: ['今天'], series: [{ name: '完成', values: [8] }] }} /></GestureHandlerRootView>);
  await measure('line');
  await tap(200);
  expect(within(screen.getByTestId('rich-chart-readout')).getByText('8')).toBeOnTheScreen();
});

test('PieChart.selected / Chart.zero：图例选择显示原值，零占比无 NaN 并可打开数据表', async () => {
  const view = await render(<RichPieChart props={{ unit: '元', items: [{ label: '住宿', value: 3200 }, { label: '交通', value: 1800 }] }} />);
  const height = readoutHeight('rich-pie-readout-slot');
  expect(screen.queryByTestId('rich-chart-readout')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '交通：1800 元' }));
  expect(screen.getByTestId('rich-chart-readout')).toHaveTextContent('交通：1800 元');
  expect(screen.getByRole('button', { name: '交通：1800 元' })).toBeSelected();
  expect(readoutHeight('rich-pie-readout-slot')).toBe(height);
  await fireEvent.press(screen.getByRole('button', { name: '交通：1800 元' }));
  expect(screen.queryByTestId('rich-chart-readout')).toBeNull();
  expect(screen.getByRole('button', { name: '交通：1800 元' })).not.toBeSelected();
  expect(readoutHeight('rich-pie-readout-slot')).toBe(height);
  await view.rerender(<RichPieChart props={{ items: [{ label: '住宿', value: 0 }] }} />);
  expect(screen.getByText('暂无数据')).toBeOnTheScreen();
  expect(screen.getByText('0% · 0')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '查看图表数据' }));
  expect(screen.getByLabelText('住宿 · 数值：0')).toBeOnTheScreen();
});
