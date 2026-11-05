import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusBarAppearance, type StatusBarIconStyle } from '../src/lib/status-bar-appearance.ts';

test('media.B1 主题变化不覆盖聚焦黑底；离开恢复最新主题而非进入快照', () => {
  const styles: StatusBarIconStyle[] = [];
  const appearance = new StatusBarAppearance(style => styles.push(style));
  appearance.setThemeStyle('light');
  const leave = appearance.enterImmersive();
  appearance.setThemeStyle('dark');
  assert.equal(styles.at(-1), 'light');
  leave();
  assert.equal(styles.at(-1), 'dark');
});

test('media.B1/video.A1 焦点交接重叠与迟到重复清理不能撤销另一个访问', () => {
  const styles: StatusBarIconStyle[] = [];
  const appearance = new StatusBarAppearance(style => styles.push(style));
  appearance.setThemeStyle('dark');
  const gallery = appearance.enterImmersive();
  const video = appearance.enterImmersive();
  gallery();
  assert.equal(styles.at(-1), 'light');
  gallery();
  assert.equal(styles.at(-1), 'light');
  video();
  assert.equal(styles.at(-1), 'dark');
  appearance.setThemeStyle('light');
  gallery();
  video();
  assert.equal(styles.at(-1), 'light');
});
