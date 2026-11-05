import { composeStories } from '@storybook/react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as stories from '../src/dev/rich/l3-layout.stories';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));

const { ScrollRowFits, ScrollRowFractions, FieldDefault } = composeStories(stories);

async function measure() {
  // Native measurement is the only injected boundary; actual fence parsing and Renderer still run.
  const blocks = screen.getByTestId('rich-block').queryAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
  for (const block of blocks) await fireEvent(block, 'layout', { nativeEvent: { layout: { width: 320, height: 160 } } });
}

test('ScrollRow.fits 单项不截走横滑，ScrollRow.overflow 半宽多项可滑', async () => {
  const view = await render(<ScrollRowFits />);
  await measure();
  expect(screen.getByText('本周完成')).toBeVisible();
  expect(screen.getByTestId('rich-scroll-row')).toHaveProp('scrollEnabled', false);
  await view.unmount();
  await render(<ScrollRowFractions />);
  await measure();
  expect(screen.getByText('方案四')).toBeOnTheScreen();
  expect(screen.getByTestId('rich-scroll-row')).toHaveProp('scrollEnabled', true);
});

test('Field.default 不重复 Slider 的当前值、Switch 的标签，输入仍可由读屏定位', async () => {
  await render(<FieldDefault />);
  expect(screen.getAllByText('预算')).toHaveLength(1);
  expect(screen.queryByText('预算滑块')).toBeNull();
  expect(screen.getByLabelText('预算滑块')).toHaveProp('value', 1500);
  await fireEvent(screen.getByLabelText('预算滑块'), 'valueChange', 1700);
  expect(screen.getByText('1700')).toBeVisible();
  expect(screen.getAllByText('通知')).toHaveLength(1);
  expect(screen.queryByText('接收通知')).toBeNull();
  expect(screen.getByLabelText('接收通知')).toBeChecked();
  await fireEvent.changeText(screen.getByLabelText('填写备注'), '只提交真实输入');
  expect(screen.getByLabelText('填写备注')).toHaveDisplayValue('只提交真实输入');
});
