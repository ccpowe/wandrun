import { ChevronLeft, CircleAlert, ScanLine } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommandText } from './command-text.tsx';
import { NumberedStep } from './numbered-step.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { ThemedImage } from './themed-image.tsx';
import { StatusBanner } from './status-banner.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Input } from './ui/input.tsx';
import { SurfacePressable } from './ui/surface-pressable.tsx';
import { Text } from './ui/text.tsx';
import type { ConnectSelection, ConnectState, PairingPage } from '../lib/connect.ts';
import { useTranslation } from '../lib/i18n.ts';
import { useDelayedNotice } from '../lib/use-delayed-notice.ts';

type Props = { state: ConnectState; selection: ConnectSelection; exchangePhase: 'idle' | 'exchanging' | 'saving';
  canClose: boolean; invalid: boolean; repairing: boolean; revoked: boolean; camera: ReactNode;
  onClose(): void; onPage(page: PairingPage): void; onScan(): void; onSubmit(): void; onCancel(): void;
  onRetryScan(): void; onManage(): void; onTitle(): void; onField(field: 'address' | 'code' | 'token', value: string): void };
export function ConnectView({ state, selection, exchangePhase, canClose, invalid, repairing, revoked, camera,
  onClose, onPage, onScan, onSubmit, onCancel, onRetryScan, onManage, onTitle, onField }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const showProgress = useDelayedNotice(exchangePhase === 'idle' ? null : exchangePhase);
  // Smaller art on short windows (small phones, landscape) keeps the steps in view; scrolling still covers the rest.
  const artWidth = useWindowDimensions().height < 700 ? 150 : 210;
  const { page } = state;
  // Translate the whole sentence; the command is inserted at {command} and never translated.
  const [runBefore, runAfter = ''] = t('在服务器上运行 {command}').split('{command}');
  const retrySuffix = ' 可重试；若码已使用，请在服务器上重新生成。';
  const error = selection.error.endsWith(retrySuffix)
    ? t("{error} 可重试；若码已使用，请在服务器上重新生成。", { error: t(selection.error.slice(0, -retrySuffix.length)) }) : t(selection.error);
  return <View className={page === 'landing' ? 'flex-1 bg-background' : 'flex-1 bg-muted dark:bg-background'}>
    {page === 'landing' ? <ScreenBar left={canClose ? <Button testID="pairing-close" intent="quiet" size="icon" accessibilityLabel={t("返回当前服务器")} disabled={selection.saving} onPress={onClose}><Icon as={ChevronLeft} size={22} /></Button> : undefined} />
      : <ScreenBar title={t(page === 'scan' ? '扫码连接' : page === 'development' ? '开发连接' : '手动连接')}
        left={<Button testID="pairing-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} disabled={selection.saving} onPress={() => onPage('landing')}><Icon as={ChevronLeft} size={22} /></Button>} />}
    {exchangePhase !== 'idle' && showProgress ? <View testID="pairing-progress"><StatusBanner icon={CircleAlert} title={t(exchangePhase === 'saving' ? '正在保存连接…' : '正在完成上一次配对，成功后仍会保存连接，请稍候…')} /></View> : null}
    {selection.error ? <View testID="pairing-error" accessibilityLiveRegion="polite"><StatusBanner icon={CircleAlert} title={error} /></View> : null}
    {page === 'landing' ? <View className="flex-1">
      {/* Scrolls when short windows, landscape, large text or the invalid notice do not fit; centred otherwise. Actions stay fixed below. */}
      <ScrollView testID="pairing-landing-scroll" className="flex-1" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 16 }}>
        {/* Wandrun image generation; prompt b-peek-screen in experiments/imagegen/pairing-2026-11-01/prompts.json */}
        <View className="items-center"><ThemedImage light={require('../../assets/pairing-peek.png')} dark={require('../../assets/pairing-peek-dark.png')}
          accessibilityLabel={t('小生物从电脑屏幕后探出头')} resizeMode="contain" style={{ width: artWidth, height: artWidth * 966 / 840 }} /></View>
        <SurfacePressable testID="pairing-title" onPress={onTitle} feedback="surface" className={`${artWidth < 210 ? 'mt-6' : 'mt-10'} self-start`}><Text className="text-title font-semibold">{t("连接你的服务器")}</Text></SurfacePressable>
        <View className="mt-5 gap-4">
          <NumberedStep index={1}>{runBefore}<CommandText>wandrun pair</CommandText>{runAfter}</NumberedStep>
          <NumberedStep index={2}>{t('用手机扫描屏幕上的二维码')}</NumberedStep>
        </View>
        {invalid ? <Text testID="pairing-invalid" variant="caption" accessibilityLiveRegion="polite" className="mt-4 text-destructive">{repairing ? t("请在服务器上生成新配对码，再配对。") : t("这台服务器认证已失效。请在「查看已保存的服务器」选「重新配对这台服务器」。")}</Text> : null}
        {revoked ? <Text testID="pairing-revoked" variant="caption" accessibilityLiveRegion="polite" className="mt-4 text-destructive">{t('这台设备的连接已被撤销')}</Text> : null}
      </ScrollView>
      <View className="gap-2 px-4" style={{ paddingBottom: insets.bottom + 24 }}>
        <Button testID="pairing-scan" intent="primary" disabled={selection.busy} onPress={onScan}><Icon as={ScanLine} size={20} /><Text>{t('扫码连接')}</Text></Button>
        <Button testID="pairing-manual" intent="quiet" disabled={selection.saving} onPress={() => onPage('manual')}><Text>{t('手动输入地址和配对码')}</Text></Button>
        {invalid ? <Button testID="pairing-computers" intent="quiet" onPress={onManage}><Text>{t("查看已保存的服务器")}</Text></Button> : null}
      </View>
    </View> : page === 'scan' ? <View className="flex-1">
      {camera}
      {selection.canCancel ? <Button testID="pairing-cancel" intent="quiet" onPress={onCancel}><Text>{t('取消')}</Text></Button> : null}
      {selection.error ? <View className="mx-4 mt-3"><Button testID="pairing-retry-scan" intent="soft" disabled={selection.busy} onPress={onRetryScan}><Text>{t('重新扫描')}</Text></Button></View> : null}
      <View style={{ paddingBottom: insets.bottom + 20 }}><Button testID="pairing-manual" intent="quiet" disabled={selection.saving} onPress={() => onPage('manual')}><Text>{t('改为手动输入地址和配对码')}</Text></Button></View>
    </View> : <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View className="gap-2 px-4 pt-4">
        <Text variant="caption" className="text-muted-foreground">{t("服务器地址")}</Text>
        <Input testID={page === 'development' ? 'gateway-address' : 'pairing-address'} value={state.address} onChangeText={value => onField('address', value)} placeholder="192.168.1.20:8765" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <Text variant="caption" className="mt-3 text-muted-foreground">{page === 'development' ? t('开发令牌') : t("服务器上显示的配对码")}</Text>
        <Input testID={page === 'development' ? 'gateway-token' : 'pairing-code'} value={page === 'development' ? state.token : state.code}
          onChangeText={value => onField(page === 'development' ? 'token' : 'code', value)} secureTextEntry autoCapitalize="none" autoCorrect={false} />
        <Button testID={page === 'development' ? 'gateway-save' : 'pairing-submit'} className="mt-3" disabled={selection.busy || !state.address.trim() || !(page === 'development' ? state.token : state.code).trim()} onPress={onSubmit}><Text>{selection.saving ? t('正在保存连接…') : selection.busy ? t('正在连接…') : t('连接')}</Text></Button>
      </View>
      {selection.canCancel ? <Button testID="pairing-cancel" intent="quiet" onPress={onCancel}><Text>{t('取消')}</Text></Button> : null}
      {page === 'manual' ? <Text variant="caption" className="px-8 pt-4 text-center text-muted-foreground">{t("配对码 5 分钟内有效，只能使用一次；过期后请在服务器上重新运行 wandrun pair。")}</Text> : null}
    </KeyboardAwareScrollView>}
  </View>;
}
