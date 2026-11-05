import { ChevronLeft, CircleAlert, Monitor, Moon, Sun, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { GroupRow } from './group-row.tsx';
import { ListGroup } from './list-group.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import type { AppearancePreferences, AppearanceState } from '../lib/appearance.ts';
import { useTranslation } from '../lib/i18n.ts';

export function SettingsAppearanceView({ state, notice, onBack, onChange, onDismissNotice }: {
  state: AppearanceState; notice?: string | null; onBack(): void; onChange(patch: Partial<AppearancePreferences>): void; onDismissNotice?(): void;
}) {
  const { t } = useTranslation();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('外观')} left={<Button testID="appearance-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {notice ? <View testID="appearance-save-error"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(notice)}
      action={onDismissNotice ? { icon: X, label: t('关闭提示'), onPress: onDismissNotice, testID: 'appearance-save-error-dismiss' } : undefined} /></View> : null}
    <ScrollView contentContainerClassName="pb-10">
      <ListGroup label={t('语言')} inset="content">
        <GroupRow testID="appearance-language-zh" title="中文" affordance="selected" selected={state.language === 'zh'} disabled={state.saving} onPress={() => onChange({ language: 'zh' })} />
        <GroupRow testID="appearance-language-en" title="English" affordance="selected" selected={state.language === 'en'} disabled={state.saving} onPress={() => onChange({ language: 'en' })} />
      </ListGroup>
      <ListGroup label={t('颜色模式')}>
        <GroupRow testID="appearance-theme-system" title={t('跟随系统')} icon={Monitor} affordance="selected" selected={state.theme === 'system'} disabled={state.saving} onPress={() => onChange({ theme: 'system' })} />
        <GroupRow testID="appearance-theme-light" title={t('浅色')} icon={Sun} affordance="selected" selected={state.theme === 'light'} disabled={state.saving} onPress={() => onChange({ theme: 'light' })} />
        <GroupRow testID="appearance-theme-dark" title={t('深色')} icon={Moon} affordance="selected" selected={state.theme === 'dark'} disabled={state.saving} onPress={() => onChange({ theme: 'dark' })} />
      </ListGroup>
    </ScrollView>
  </View>;
}
export function SettingsAboutYouView({ memory, edit, onBack }: { memory: ReactNode; edit: ReactNode; onBack(): void }) {
  const { t } = useTranslation();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('关于你')} right={<View testID="about-you-edit-action">{edit}</View>} left={<Button testID="about-you-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {memory}
  </View>;
}
