import { useState } from 'react';
import { View } from 'react-native';
import { AgentMessageContent } from '@/components/chat/agent-message-content';
import { Credentials } from '@/lib/credentials';
import { SessionProvider } from '@/lib/session-context';
import { FakeGateway } from '../fake-gateway';
import { SceneProviders } from '../scene-providers';
import { ChatSketchFrame, UserBubble } from '../story-frames/chat-sketch-frame';
import { Header, SketchComposer } from '../story-frames/chat-sketch';
import { fixture, fromScenario, node } from './rich-fixtures';

const charts = [
  fixture(node('LineChart', {
    title: '季度渠道新增用户 · 长名称压力样本',
    xLabels: ['2026 年第一季度', '2026 年第二季度', '2026 年第三季度', '2026 年第四季度'],
    series: [
      { name: '线上渠道新增用户', values: [1284800, -1942000, 2158600, 1789000] },
      { name: '线下门店新增用户', values: [984600, -2835000, 1189200, 1472600] },
      { name: '合作伙伴推荐用户', values: [478200, -1176000, 628100, 821700] },
    ], unit: '人',
  })),
  fromScenario('line', 'LineChart'),
  fromScenario('bar', 'BarChart'),
  fixture(node('BarChart', {
    title: '渠道净增长', labels: ['官网', '社群', '搜索', '活动'],
    series: [{ name: '本周', values: [45, -22, 38, 56] }, { name: '上周', values: [32, -15, 25, 40] }],
    horizontal: true, unit: '人',
  })),
  fromScenario('pie', 'PieChart'),
];
const fence = (index: number) => `\`\`\`wandrun-ui\n${JSON.stringify(charts[index].spec)}\n\`\`\``;
const reply = [
  '先放一张可读性压力样本：三个长名称系列、季度类别和百万级正负值。请点从左数第二组点（第二季度，约绘图区三分之一处），比较选中后的图头。完整名称与原始数值可点“数据”展开。',
  fence(0),
  '这周完成的任务总体在增加，周三略有回落。先看每天已完成、新增和待办变化的趋势：',
  fence(1),
  '渠道表现有差异：社群出现净流出，活动和官网仍带来增长。下面先比较各渠道，再用横向图对照上周；负值表示净减少。',
  fence(2),
  fence(3),
  '最后看这次支出的构成。住宿占比最大，交通其次；渠道趋势和支出占比是两组数据，不据此推断因果。',
  fence(4),
].join('\n\n');

/** Real message parsing and chart components, inside the existing chat visual shell. */
export function ChartsChatStory() {
  const [runtime] = useState(() => {
    const storage = new Map<string, string>();
    return {
      credentials: new Credentials({
        getItemAsync: async (key) => storage.get(key) ?? null,
        setItemAsync: async (key, value) => { storage.set(key, value); },
        deleteItemAsync: async (key) => { storage.delete(key); },
      }),
      fetch: new FakeGateway().fetch,
    };
  });
  return <SessionProvider runtime={runtime}><SceneProviders>
    <ChatSketchFrame theme="light" header={<Header subtitle="任务与渠道小结" />} composer={<SketchComposer />}
      content={<View className="gap-5 px-4">
        <UserBubble>帮我看看本周任务、渠道和支出，也放一张长名称与大数的压力样本。</UserBubble>
        <View className="px-0.5"><AgentMessageContent text={reply}
          ui={charts.map((chart, block) => ({ block, valid: true, files: chart.files }))}
          onSubmit={async () => {}} /></View>
      </View>} />
  </SceneProviders></SessionProvider>;
}
