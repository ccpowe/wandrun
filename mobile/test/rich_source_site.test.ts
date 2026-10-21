import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sourceSite } from '../src/components/rich-message/source-site.ts';
import { richSourceColors } from '../src/components/rich-message/tokens.ts';

test('source marks select the main domain label, including common second-level ccTLDs', () => {
  assert.equal(sourceSite('www.dpm.org.cn').site, 'dpm.org.cn');
  assert.equal(sourceSite('www.dpm.org.cn').letter, 'D');
  assert.equal(sourceSite('commons.wikimedia.org').site, 'wikimedia.org');
  assert.equal(sourceSite('commons.wikimedia.org').letter, 'W');
  assert.equal(sourceSite('news.example.co.uk').site, 'example.co.uk');
  assert.equal(sourceSite('other.example.com').site, 'example.com');
});

test('source identity normalizes case and terminal dots and groups subdomains deterministically', () => {
  const site = sourceSite('DPM.ORG.CN.');
  assert.deepEqual(sourceSite('WWW.dpm.org.cn..'), site);
  assert.deepEqual(sourceSite('news.dpm.org.cn'), site);
  assert.deepEqual(sourceSite('commons.wikimedia.org'), sourceSite('upload.wikimedia.org'));
  assert.ok(richSourceColors.some(color => color === site.color));
});
test('IP and single-label hosts remain usable decorative identities', () => {
  assert.equal(sourceSite('127.0.0.1').site, '127.0.0.1');
  assert.equal(sourceSite('127.0.0.1').letter, '1');
  assert.equal(sourceSite('[2001:db8::1]').site, '[2001:db8::1]');
  assert.equal(sourceSite('[2001:db8::1]').letter, '2');
  assert.equal(sourceSite('LOCALHOST.').site, 'localhost');
  assert.equal(sourceSite('LOCALHOST.').letter, 'L');
  assert.deepEqual(sourceSite('www.localhost'), sourceSite('localhost'));
});

function relativeLuminance(color: string): number {
  assert.match(color, /^#[0-9a-fA-F]{6}$/);
  const channels = [1, 3, 5].map((index) => {
    const channel = parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test('every source color meets white glyph contrast in light and dark themes', () => {
  // The fixed palette is shared by both themes, so each color needs one contrast calculation.
  for (const color of richSourceColors) {
    const contrast = 1.05 / (relativeLuminance(color) + 0.05);
    assert.ok(contrast >= 4.5, `${color}: ${contrast.toFixed(2)}:1`);
  }
});
