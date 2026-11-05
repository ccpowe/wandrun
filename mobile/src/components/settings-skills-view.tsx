import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListGroup } from './list-group.tsx';
import { LoadingState } from './loading-state.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { SurfacePressable } from './ui/surface-pressable.tsx';
import { Text } from './ui/text.tsx';
import type { BuiltinSkill, Skill } from '../gateway/api.ts';
import { useTranslation } from '../lib/i18n.ts';

type Props = { skills: Skill[]; builtins: BuiltinSkill[]; skillsLoading: boolean; builtinsLoading: boolean; empty: boolean; refreshing: boolean; banner: ReactNode;
  onBack(): void; onRefresh(): void; onSkill(name: string): void; onBuiltin(name: string): void };
export function SettingsSkillsView({ skills, builtins, skillsLoading, builtinsLoading, empty, refreshing, banner, onBack, onRefresh, onSkill, onBuiltin }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('技能')} left={<Button testID="skills-back" intent="quiet" size="icon" accessibilityLabel={t('返回设置')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {banner}
    <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {builtins.length ? <ListGroup label={t('系统内置')} inset="content">{builtins.map(skill => <SkillRow key={skill.name} skill={skill} builtin onOpen={() => onBuiltin(skill.name)} />)}</ListGroup> : null}
      {builtinsLoading ? <View className="mt-6"><LoadingState /></View> : null}
      {skills.length ? <ListGroup label={t('我的技能')} inset="content">{skills.map(skill => <SkillRow key={skill.name} skill={skill} onOpen={() => onSkill(skill.name)} />)}</ListGroup> : null}
      {empty ? <Text variant="caption" className="mx-8 mt-6 text-center text-muted-foreground">{t('暂无技能')}</Text> : null}
      {skillsLoading ? <View className="mt-8"><LoadingState /></View> : null}
      <Text variant="caption" className="mx-8 mt-4 text-muted-foreground">{t('想导入技能，在聊天里把技能发给 Agent')}</Text>
    </ScrollView>
  </View>;
}
function SkillRow({ skill, builtin = false, onOpen }: { skill: Skill | BuiltinSkill; builtin?: boolean; onOpen(): void }) {
  const { t } = useTranslation();
  const failed = 'status' in skill && skill.status === 'error';
  const description = failed ? t('无法加载：{reason}', { reason: skill.error || t('未知原因') }) : skill.description;
  return <SurfacePressable testID={`${builtin ? 'builtin-skill' : 'skill'}-${skill.name}`} accessibilityRole="button"
    accessibilityLabel={builtin ? t('内置技能 {name}，{description}', { name: skill.name, description: skill.description }) : `${skill.name}，${description}`} onPress={onOpen} feedback="surface">
    <View className="min-h-15 flex-row items-center gap-3 px-4 py-3">
      <View className="min-w-0 flex-1 gap-1"><Text variant="body" numberOfLines={1}>{skill.name}</Text>
        <Text testID={failed ? `skill-error-${skill.name}` : undefined} variant="caption" numberOfLines={failed ? 3 : 2} className={failed ? 'text-destructive' : 'text-muted-foreground'}>{description}</Text>
      </View>
      <Text testID={builtin ? undefined : `skill-status-${skill.name}`} variant="caption" className={failed ? 'text-destructive' : 'text-muted-foreground'}>{builtin ? t('内置') : skill.used_by.length ? t('{count} 个 Agent 使用', { count: skill.used_by.length }) : t('未使用')}</Text>
      <Icon as={ChevronRight} size={16} className="text-muted-foreground/60" />
    </View>
  </SurfacePressable>;
}
