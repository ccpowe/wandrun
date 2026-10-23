import { useMemo, useState } from 'react';
import { AccessibilityInfo, Alert, Pressable, View, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderOpen, FolderTree } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import { buildFileTree, type FileTreeInput, type FileTreeNode } from './file-tree-model.ts';
import { richSpace } from './tokens.ts';

const INDENT = 18;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|py|go|rs|java|kt|swift|css|scss|html|vue|sh|sql|md|xml|c|h|cpp|hpp)$/i;

type RowProps = { node: FileTreeNode; depth: number; collapsed: ReadonlyMap<string, boolean>;
  toggle: (path: string, current: boolean) => void };

function TreeRow({ node, depth, collapsed, toggle }: RowProps) {
  const { t } = useTranslation();
  const folder = node.kind === 'folder';
  const hasChildren = node.children.length > 0;
  const closed = collapsed.get(node.path) ?? false;
  const label = folder ? `${node.name}，${hasChildren ? closed ? t('已折叠') : t('展开') : t('空目录')}` : node.path;
  const copyPath = async () => {
    try {
      if (!await Clipboard.setStringAsync(node.path)) throw new Error(t('剪贴板不可用，请稍后重试。'));
      AccessibilityInfo.announceForAccessibility(t('已复制路径'));
    } catch {
      Alert.alert(t('无法复制路径'), t('剪贴板不可用，请稍后重试。'));
    }
  };
  const content = <>
    {Array.from({ length: depth }, (_, index) => <View key={index} pointerEvents="none" testID="rich-tree-guide"
      className="absolute bg-muted-foreground" style={{ left: 20 + INDENT * index, top: 0, bottom: 0, width: 1, opacity: 0.35 }} />)}
    <View style={{ width: 16, height: 20, justifyContent: 'center', flexShrink: 0 }}>
      {folder && hasChildren ? <Icon as={closed ? ChevronRight : ChevronDown} size={16} className="text-muted-foreground" /> : null}
    </View>
    <View style={{ height: 20, justifyContent: 'center', flexShrink: 0 }}>
      <Icon as={folder ? closed || !hasChildren ? Folder : FolderOpen : CODE_FILE.test(node.name) ? FileCode2 : File}
        size={16} className={folder ? 'text-foreground' : 'text-muted-foreground'} />
    </View>
    <Text textBreakStrategy="simple" className="text-foreground" style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20,
      ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) }}>
      <Text className="text-foreground" style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13.5,
        lineHeight: 20, fontWeight: folder ? '600' : '400' }}>{node.name}</Text>
      {closed && hasChildren ? <Text className="text-muted-foreground" style={{ fontSize: 12, lineHeight: 20 }}>  {t('{count} 项', { count: node.children.length })}</Text> : null}
      {node.note ? <Text className="text-muted-foreground" style={{ fontSize: 13, lineHeight: 20 }}>  {node.note}</Text> : null}
    </Text>
  </>;
  return <>
    {hasChildren || !folder ? <Pressable testID={`rich-tree-${node.path}`} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={folder ? { expanded: !closed } : undefined}
      accessibilityHint={folder ? undefined : t('长按复制完整路径')}
      accessibilityActions={!folder ? [{ name: 'copy', label: t('复制路径') }] : undefined}
      onAccessibilityAction={!folder ? (event) => { if (event.nativeEvent.actionName === 'copy') void copyPath(); } : undefined}
      onPress={folder ? () => toggle(node.path, closed) : undefined}
      onLongPress={!folder ? () => { void copyPath(); } : undefined}
      className="flex-row items-start" style={{ minHeight: 32, gap: 6, paddingLeft: 12 + INDENT * depth, paddingRight: richSpace.md, paddingVertical: 6 }}>
      {content}
    </Pressable> : <View testID={`rich-tree-${node.path}`} accessibilityLabel={label} accessible
      className="flex-row items-start" style={{ minHeight: 32, gap: 6, paddingLeft: 12 + INDENT * depth, paddingRight: richSpace.md, paddingVertical: 6 }}>
      {content}
    </View>}
    {!closed && node.children.map(child => <TreeRow key={child.path} node={child} depth={depth + 1} collapsed={collapsed} toggle={toggle} />)}
  </>;
}

/** Local expansion never mutates the validated message tree or its copy summary. */
export function FileTreeDisplay({ props }: { props: { title?: string; nodes: FileTreeInput[] } }) {
  const { t } = useTranslation();
  const roots = useMemo(() => buildFileTree(props.nodes), [props.nodes]);
  const initial = useMemo(() => {
    const collapsed = new Map<string, boolean>();
    let count = 0;
    const visit = (nodes: FileTreeNode[]) => { for (const node of nodes) { count++; visit(node.children); } };
    visit(roots);
    const addFolders = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        if (node.kind === 'folder' && node.children.length) collapsed.set(node.path, node.collapsed ?? (count > 24 && depth >= 2));
        addFolders(node.children, depth + 1);
      }
    };
    addFolders(roots, 0);
    return collapsed;
  }, [roots]);
  // Every valid path is data, including Object.prototype names such as __proto__.
  const [manual, setManual] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const collapsed = new Map([...initial, ...manual]);
  const folders = [...initial.keys()];
  const allCollapsed = folders.length > 0 && folders.every(path => collapsed.get(path));
  const toggle = (path: string, current: boolean) => setManual(previous => new Map(previous).set(path, !current));
  const toggleAll = () => setManual(new Map(folders.map(path => [path, !allCollapsed])));
  return <View className="bg-muted" style={{ borderRadius: 14, paddingTop: 6, paddingBottom: 8 }} testID="rich-file-tree">
    <View className="flex-row items-center" style={{ gap: richSpace.sm, paddingLeft: 14, paddingRight: 8, paddingTop: 4, paddingBottom: 6 }}>
      <Icon as={FolderTree} size={16} className="text-muted-foreground" />
      <Text numberOfLines={1} className="text-muted-foreground" style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20 }}>{props.title || t('目录结构')}</Text>
      {folders.length ? <Pressable testID="rich-tree-toggle-all" accessibilityRole="button" accessibilityLabel={allCollapsed ? t('全部展开') : t('全部折叠')}
        onPress={toggleAll} style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 8 }}>
        <Text className="text-foreground" style={{ fontSize: 13, lineHeight: 20 }}>{allCollapsed ? t('全部展开') : t('全部折叠')}</Text>
      </Pressable> : null}
    </View>
    {roots.map(node => <TreeRow key={node.path} node={node} depth={0} collapsed={collapsed} toggle={toggle} />)}
  </View>;
}
