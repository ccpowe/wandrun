import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
async function errors(source: string, filePath = 'src/l0-fixture.tsx') {
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.fatalErrorCount, 0, source);
  return result.messages.filter(message => message.severity === 2 && [
    'no-restricted-syntax', 'no-restricted-properties', 'react-native/no-color-literals', 'wandrun/no-use-effect',
  ].includes(message.ruleId ?? ''));
}

test('L0 rejects literal animation durations and delays across supported APIs', async () => {
  for (const source of [
    'FadeIn.duration(200);',
    'FadeIn.delay(50);',
    'withTiming(1, { duration: 200 });',
    'Animated.timing(opacity, { toValue: 1, duration: 180 });',
    'withDelay(50, animation);',
    'const image = <Image transition={180} />;',
    'const classes = "transition-transform duration-200";',
  ]) {
    const messages = await errors(source);
    assert.ok(messages.some(message => message.ruleId === 'no-restricted-syntax' && /motion\.ts/.test(message.message)), source);
  }
});

test('L0 rejects style colors and arbitrary class colors without rejecting sizes or theme variables', async () => {
  for (const source of [
    'const view = <View style={{ backgroundColor: "#fff" }} />;',
    'const styles = StyleSheet.create({ root: { color: "red" } });',
    'const surface = { shadowColor: "#000" };',
    'const view = <View className="bg-[#fff]" />;',
    'const surface = { "shadowColor": "#000" } as const;',
    'const surface = { shadowColor: "#000" } satisfies ViewStyle;',
    'const view = <View className="bg-[red]" />;',
    'const view = <View className={cn("dark:text-[rgb(0,0,0)]")} />;',
    'const view = <View className={`bg-[oklch(0.5_0.2_30)] ${active}`} />;',
  ]) {
    const messages = await errors(source);
    assert.ok(messages.some(message => /color/i.test(message.message)), source);
  }
  assert.deepEqual(await errors(`
    const view = <View className="bg-card text-foreground text-[17px] w-[240px] bg-[var(--surface)]"
      style={{ color: foreground, opacity: 0.5 }} />;
    withTiming(1, { duration: duration.base });
    FadeIn.duration(duration.base).delay(dialogContentDelay);
    withDelay(dialogContentDelay, animation);
  `), []);
});

test('L0 rejects fixed palette classes across variants, opacity, cn, and templates', async () => {
  for (const source of [
    'const view = <View className="bg-red-500" />;',
    'const view = <View className="text-white" />;',
    'const view = <View className="border-blue-600" />;',
    'const view = <View className="dark:bg-black/50" />;',
    'const view = <View className={cn("active:hover:!text-white/70")} />;',
    'const classes = { active: "border-t-slate-200/[0.5]!" };',
    'const view = <View className={`dark:fill-red-500 ${active}`} />;',
    'const classes = "ring-offset-blue-600 decoration-red-500 from-black to-white";',
  ]) {
    const messages = await errors(source);
    assert.ok(messages.some(message => /fixed palette colors/.test(message.message)), source);
  }
  const semanticColors = [...readFileSync(new URL('../global.css', import.meta.url), 'utf8')
    .matchAll(/--color-([\w-]+)\s*:/g)].map(match => match[1]);
  for (const name of new Set(semanticColors)) {
    assert.deepEqual(await errors(`const classes = "bg-${name} text-${name} border-${name} dark:active:bg-${name}/50";`), [], name);
  }
  assert.deepEqual(await errors(`
    const view = <View className="bg-card text-foreground border-border text-sm border-2 shadow-sm fill-current stroke-none bg-inherit"
      style={{ opacity: 0.5 }} />;
    const filename = "text-white.png";
    const label = "not-bg-red-500";
  `), []);
});

test('L0 rejects direct component color literals but permits theme expressions and inherited paint', async () => {
  for (const source of [
    'const icon = <LockKeyhole color="#858580" />;',
    'const icon = <LockKeyhole color={"red"} />;',
    'const shape = <Path fill="#fff" />;',
    'const shape = <Path stroke={"rgb(0, 0, 0)"} />;',
    'const chart = <Chart backgroundColor="white" />;',
    'const slider = <Slider minimumTrackTintColor="#111827" />;',
    'const slider = <Slider maximumTrackTintColor={"#d1d5db"} thumbTintColor="#111827" />;',
    'const chart = <Chart strokeColor="#fff" xAxisColor="#000" rulesColor="#333" />;',
  ]) {
    const messages = await errors(source);
    assert.ok(messages.some(message => /color literals in component props/.test(message.message)), source);
  }
  assert.deepEqual(await errors(`
    const foreground = useCSSVariable("--color-foreground");
    const icon = <LockKeyhole color={foreground} />;
    const chart = <Chart backgroundColor={colors.background} strokeColor={colors.border} />;
    const shape = <Path fill={colors.foreground} stroke={useCSSVariable("--color-border")} />;
    const inherited = <Path fill="currentColor" stroke={"none"} color="inherit" />;
  `), []);
});

test('L0 rejects native Alert.alert, including computed access, but permits component dialogs', async () => {
  for (const source of ['Alert.alert("failed");', 'Alert["alert"]("failed");']) {
    assert.ok((await errors(source)).some(message => message.ruleId === 'no-restricted-properties'), source);
  }
  assert.deepEqual(await errors('const dialog = <AlertDialog open><AlertDialogContent /></AlertDialog>;'), []);
});

test('L0 rejects RN-incompatible AbortSignal methods and points to the shared cancellation helper', async () => {
  for (const source of ['signal.throwIfAborted();', 'signal["throwIfAborted"]();', 'const { throwIfAborted } = signal;']) {
    assert.ok((await errors(source)).some(message => message.ruleId === 'no-restricted-properties' && /assertNotAborted/.test(message.message)), source);
  }
  assert.deepEqual(await errors('assertNotAborted(signal);'), []);
});

test('L0 allows numeric parameter definitions only in motion.ts', async () => {
  const source = 'export const config = { duration: 200 };';
  assert.ok((await errors(source, 'src/lib/not-motion.ts')).some(message => message.ruleId === 'no-restricted-syntax'));
  assert.deepEqual(await errors(source, 'src/lib/motion.ts'), []);
});

test('L0 rejects direct effect imports, calls, and namespace access for both primitives', async () => {
  for (const hook of ['useEffect', 'useLayoutEffect']) {
    for (const source of [
      `import { ${hook} } from "react";`,
      `import { ${hook} as useOnce } from "react";`,
      `${hook}(() => {}, []);`,
      `import React from "react"; React.${hook}(() => {}, []);`,
      `import * as ReactHooks from "react"; ReactHooks.${hook}(() => {}, []);`,
      `import React from "react"; React["${hook}"](() => {}, []);`,
      `import React from "react"; const { ${hook}: useOnce } = React;`,
      `import React from "react"; React[\`${hook}\`](() => {}, []);`,
      `const { [\`${hook}\`]: useOnce } = require("react");`,
    ]) {
      const messages = await errors(source);
      assert.ok(messages.some(message => message.ruleId === 'wandrun/no-use-effect'
        && /react-guidelines\.md §3/.test(message.message)), source);
    }
  }
});

test('L0 keeps useEffect restricted in src stories, tests, and motion definitions', async () => {
  for (const filePath of ['src/dev/fixture.stories.tsx', 'src/lib/fixture.test.tsx', 'src/lib/motion.ts']) {
    assert.ok((await errors('useEffect(() => {}, []);', filePath))
      .some(message => /react-guidelines\.md §3/.test(message.message)), filePath);
  }
  assert.deepEqual(await errors('useEffect(() => {}, []);', 'test/fixture.test.ts'), []);
});

test('L0 permits only each adapter own primitive and retains unrelated restrictions', async () => {
  for (const [adapterPath, forbidden] of [
    ['src/lib/use-mount-effect.ts', 'useLayoutEffect'],
    ['src/lib/use-measure-layout.ts', 'useEffect'],
  ]) {
    const adapter = readFileSync(new URL(`../${adapterPath}`, import.meta.url), 'utf8');
    const [result] = await eslint.lintText(adapter, { filePath: adapterPath });
    assert.deepEqual(result.messages, []);
    assert.ok((await errors(`${forbidden}(() => {}, []);`, adapterPath))
      .some(message => message.ruleId === 'wandrun/no-use-effect'));
    assert.ok((await errors('Alert.alert("failed");', adapterPath))
      .some(message => message.ruleId === 'no-restricted-properties'));
    assert.ok((await errors('const config = { duration: 200 };', adapterPath))
      .some(message => message.ruleId === 'no-restricted-syntax'));
  }
  assert.deepEqual(await errors(`
    import { useSyncExternalStore } from "react";
    import { useMountEffect } from "@/lib/use-mount-effect";
    import { useMeasureLayout } from "@/lib/use-measure-layout";
    useMountEffect(() => () => {});
    useMeasureLayout(() => {}, []);
    useSyncExternalStore(subscribe, snapshot);
    useFocusEffect(onFocus);
  `), []);
});

test('L0 cannot trade a cleared color suppression for a new effect in the same file', () => {
  const directory = mkdtempSync(fileURLToPath(new URL('../src/l0-fixture-', import.meta.url)));
  const suppressionPath = join(directory, 'eslint-suppressions.json');
  const fixturePath = join(directory, 'fixture.tsx');
  const run = (source: string, extra: string[] = []) => {
    writeFileSync(fixturePath, source);
    return spawnSync(process.execPath, [
      fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url)),
      fixturePath, '--suppressions-location', suppressionPath, '--format', 'json',
      '--pass-on-unpruned-suppressions', ...extra,
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    });
  };
  try {
    const original = run('export const fixture = { color: "#fff" };', ['--suppress-rule', 'no-restricted-syntax']);
    assert.equal(original.status, 0, original.stderr || original.stdout);
    const changed = run('import { useEffect as useOnce } from "react"; export function Probe() { useOnce(() => {}, []); return null; }');
    assert.equal(changed.status, 1, changed.stderr || changed.stdout);
    const [result] = JSON.parse(changed.stdout);
    assert.ok(result.messages.some((message: { ruleId: string }) => message.ruleId === 'wandrun/no-use-effect'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('L0 recognizes both adapter callbacks as effect contexts for Effect Events', async () => {
  for (const [hook, module] of [
    ['useMountEffect', 'use-mount-effect'],
    ['useMeasureLayout', 'use-measure-layout'],
  ]) {
    const [result] = await eslint.lintText(`
      import { useEffectEvent } from "react";
      import { ${hook} } from "@/lib/${module}";
      export function Probe() {
        const onMount = useEffectEvent(() => {});
        ${hook}(() => {
          onMount();
          return () => {};
        }${hook === 'useMeasureLayout' ? ', []' : ''});
        return null;
      }
    `, { filePath: 'src/l0-fixture.tsx' });
    assert.deepEqual(result.messages.filter(message => message.ruleId === 'react-hooks/rules-of-hooks'), []);
  }
});

test('L0 checks dependencies of the layout measurement adapter', async () => {
  const [result] = await eslint.lintText(`
    import { useMeasureLayout } from "@/lib/use-measure-layout";
    export function Probe({ width }) {
      useMeasureLayout(() => { console.log(width); }, []);
      return null;
    }
  `, { filePath: 'src/l0-fixture.tsx' });
  assert.ok(result.messages.some(message => message.ruleId === 'react-hooks/exhaustive-deps'));
});
