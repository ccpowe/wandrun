import { useCallback, useImperativeHandle, useState, type Ref } from 'react';
import { useFocusEffect } from 'expo-router';
import { BackHandler, View } from 'react-native';
import { useEditorLeave } from '@/components/editor-leave-sheet';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/lib/i18n';
export type ConnectorLeaveControl = { back: () => void };
/** Key this navigation-only sibling by outcome identity; recovery discards obsolete destinations, never the form. */
export function ConnectorLeaveBoundary({ dirty, busy, unknown, panel, onMain, dismiss, ref }: {
  dirty: boolean; busy: boolean; unknown: boolean; panel: 'main' | 'agents' | 'parameters'; onMain: () => void; dismiss: () => void; ref: Ref<ConnectorLeaveControl>;
}) {
  const { t } = useTranslation();
  const [unknownOpen, setUnknownOpen] = useState(false);
  const requestUnknown = useCallback(() => setUnknownOpen(true), []);
  const leave = useEditorLeave(dirty, busy, dismiss, unknown, undefined, false, unknown ? requestUnknown : undefined);
  const back = useCallback(() => {
    if (busy) return;
    if (!unknown && panel === 'agents') onMain();
    else if (!unknown && panel === 'parameters') leave.requestLocal(onMain);
    else leave.request();
  }, [busy, unknown, panel, onMain, leave]);
  useImperativeHandle(ref, () => ({ back }), [back]);
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => subscription.remove();
  }, [back]));
  return <AlertDialog open={unknown ? unknownOpen : leave.open} onOpenChange={open => { if (!open) { setUnknownOpen(false); leave.cancel(); } }}>
    <AlertDialogContent>
      <AlertDialogTitle>{t(unknown ? '保存结果未确认，离开后本次草稿不会保留。' : '放弃本次修改？')}</AlertDialogTitle>
      <AlertDialogDescription>{t(unknown ? '恢复连接后只核对网关上的实际内容，不会重复提交。' : '本次草稿不会保留。')}</AlertDialogDescription>
      <View className="flex-row gap-3"><Button intent="soft" className="flex-1" onPress={() => { setUnknownOpen(false); leave.cancel(); }}><Text>{t('继续编辑')}</Text></Button>
        <Button intent="destructive" className="flex-1" onPress={leave.finish}><Text>{t(unknown ? '离开' : '放弃')}</Text></Button></View>
    </AlertDialogContent>
  </AlertDialog>;
}
