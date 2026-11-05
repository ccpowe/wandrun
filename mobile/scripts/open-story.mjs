// @ts-check
// 用法与官方机制依据：../docs/frontend-workflow.md §7.5a。
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} serial @param {...string} args */
function adb(serial, ...args) {
  try {
    const output = execFileSync('adb', ['-s', serial, ...args], {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // Android 的 am 有些错误仍返回退出码 0。
    if (/^Error:|Exception/m.test(output)) throw new Error(output);
    return output;
  } catch (error) {
    throw new Error(`设备 ${serial} 的 adb ${args[0]} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      serial: { type: 'string' },
      port: { type: 'string' },
      'project-dir': { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`用法：pnpm run open-story --serial <设备序列号> --port <Metro 端口> '<story id 或 分组/名称>'
列出场景：pnpm run open-story --list
可选：--project-dir <Metro 所在的 mobile 目录>（默认本脚本所属 mobile）
仅连接已经运行的本机 Storybook；不启动或重启 Metro，不逐步导航设备。`);
    return;
  }
  if (values.list ? positionals.length !== 0 : positionals.length !== 1) {
    throw new Error('--list 不接受场景参数；打开场景时必须提供一个 story id 或完整的 分组/名称。用 --help 查看用法。');
  }

  let serial = '';
  let port = 0;
  if (!values.list) {
    serial = values.serial ?? '';
    if (!serial || !values.port || !/^\d+$/.test(values.port)) {
      throw new Error('打开场景必须指定 --serial 和 --port；设备不会自动选择。');
    }
    port = Number(values.port);
    if (port < 1 || port > 65535) throw new Error('--port 必须为 1–65535。');
    if (adb(serial, 'get-state') !== 'device') throw new Error(`设备 ${serial} 未连接或未授权。`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.text()).trim() !== 'packager-status:running') {
        throw new Error(`HTTP ${response.status}，不是运行中的 Metro`);
      }
    } catch (error) {
      throw new Error(`端口 ${port} 的 Metro 不可用：${error instanceof Error ? error.message : String(error)}；请先启动 Storybook。`);
    }
  }

  const projectDir = resolve(values['project-dir'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  // 官方 buildIndex 在导入时捕获 cwd；必须先进入目标 Metro 的项目目录。
  process.chdir(projectDir);
  const { buildIndex } = await import('@storybook/react-native/node');
  const index = await buildIndex({ configPath: resolve('.rnstorybook') });
  const entries = Object.values(index.entries).filter(entry => entry.type === 'story');
  if (values.list) {
    for (const entry of entries) console.log(`${entry.id}\t${entry.title}/${entry.name}`);
    return;
  }
  const selector = positionals[0];
  const exactId = entries.find(entry => entry.id === selector);
  const matches = exactId ? [exactId] : entries.filter(entry => `${entry.title}/${entry.name}` === selector);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `场景不存在：${selector}（索引目录 ${projectDir}）；用 --list 查看，跨 worktree 时指定 --project-dir。`
      : `场景名称不唯一：${selector}；请改用 --list 中的 story id。`);
  }
  const story = matches[0];
  const url = new URL(`exp://127.0.0.1:${port}/--/`);
  // @storybook/react-native 10.7.0 的公开 URL 参数；冷启动和已打开时均由上游处理。
  url.searchParams.set('STORYBOOK_STORY_ID', story.id);
  adb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`);
  // adb shell 仍经过设备 shell，URL 必须作为单个参数（中文 id 已由 URL 编码）。
  adb(serial, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${url.href}'`, '-p', 'host.exp.exponent');
  console.log(`已向设备 ${serial} 的 Expo Go 发送：${story.title}/${story.name}\n${url.href}`);
}

main().catch(error => {
  console.error(`open-story：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
