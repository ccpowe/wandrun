import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useTranslation } from '@/lib/i18n.ts';

/** Both memory editors use the same uncertain-result copy and draft-loss confirmation. */
export function MemorySaveNotice({ status, online, leaveOpen, deleting = false, onContinue, onLeave }: {
  status: 'idle' | 'checking' | 'unknown'; online: boolean; leaveOpen: boolean; deleting?: boolean; onContinue: () => void; onLeave: () => void;
}) {
  const { t } = useTranslation();
  return <>
    {status !== 'idle' ? <Text testID="memory-save-unconfirmed" accessibilityRole="alert" variant="caption" className="mx-4 mt-3 text-destructive">
      {deleting ? status === 'checking' ? t('删除结果未确认，正在核对…') : online ? t('删除结果未确认。离开后再进入，会显示网关上实际保存的内容。') : t('删除结果未确认，连接恢复后会自动核对。')
        : status === 'checking' ? t('保存结果未确认，正在核对…') : online ? t('保存结果未确认。离开后再进入，会显示网关上实际保存的内容。') : t('保存结果未确认，连接恢复后会自动核对。')}
    </Text> : null}
    <AlertDialog open={leaveOpen && status !== 'idle'} onOpenChange={(open) => { if (!open) onContinue(); }}>
      <AlertDialogContent testID="memory-save-leave-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('离开编辑？')}</AlertDialogTitle>
          <AlertDialogDescription>{deleting ? t('删除结果未确认，离开后本次核对稿不会保留。') : t('保存结果未确认，离开后本次草稿不会保留。')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button testID="memory-save-stay" intent="soft" onPress={onContinue}><Text>{t('继续停留')}</Text></Button>
          <Button testID="memory-save-leave" intent="destructive" onPress={onLeave}><Text>{t('离开')}</Text></Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
