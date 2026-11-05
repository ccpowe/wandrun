import { router, useFocusEffect, useNavigation } from 'expo-router';
import { usePreventRemove, type NavigationAction } from 'expo-router/react-navigation';
import { useCallback, useImperativeHandle, useState, useSyncExternalStore, type Ref } from 'react';
import { BackHandler, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import type { AgentEditorSelection } from '@/lib/agent-editor.ts';
import { EditorLeaveOwner, type LeaveMode, type LeaveTarget } from '@/lib/editor-leave.ts';

/** React Navigation's original action is the continuation: never reconstruct it after a save. */
export function useEditorLeave(dirty: boolean, busy: boolean, dismiss: () => void, unknown: boolean, save?: () => Promise<boolean>, autoSave = false, requestUnknownLeave?: () => void) {
  const navigation = useNavigation();
  const [owner] = useState(() => new EditorLeaveOwner(action => navigation.dispatch(action)));
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useFocusEffect(useCallback(() => {
    owner.enter();
    return owner.exit;
  }, [owner]));
  const mode: LeaveMode = unknown ? requestUnknownLeave ? 'unknown' : 'continue' : dirty ? autoSave ? 'save' : 'ordinary' : 'continue';
  const intercept = (target: LeaveTarget, explicitMode = mode) => {
    const current = owner.snapshot();
    if (busy && current.status !== 'saving' && !(current.status === 'requesting' && current.mode === 'continue')) return;
    void KeyboardController.dismiss();
    void owner.intercept(target, explicitMode, save);
    if (owner.snapshot().status === 'confirming' && explicitMode === 'unknown') requestUnknownLeave?.();
  };
  const protect = dirty || busy || unknown || state.status === 'saving' || state.status === 'requesting' && state.mode === 'save';
  usePreventRemove(protect, ({ data }) => {
    // A current navigator removal is not an obsolete async continuation. Hidden pages must
    // settle it without saving or showing a confirmation behind the focused screen.
    if (owner.snapshot().status === 'inactive') { navigation.dispatch(data.action); return; }
    intercept({ kind: 'navigation', action: data.action });
  });
  const request = () => { if (!busy && owner.snapshot().status !== 'consumed') dismiss(); };
  const requestLocal = (run: () => void) => intercept({ kind: 'local', run });
  const requestAction = (action: NavigationAction) => intercept({ kind: 'navigation', action });
  const submit = async () => {
    if (busy || owner.snapshot().status !== 'idle' || !save) return;
    owner.arm('save');
    dismiss();
  };
  const complete = () => {
    if (owner.snapshot().status !== 'idle') return;
    owner.arm('continue');
    dismiss();
  };
  return { open: state.status === 'confirming' && state.reason === 'ordinary', request, requestLocal, requestAction,
    finish: owner.confirm, complete, cancel: owner.cancel, submit };
}

/** Discard confirmation never writes; explicit creation/save belongs to the toolbar. */
export function EditorLeaveSheet({ open, changes, busy, onDiscard, onContinue }: {
  open: boolean; changes: string[]; busy: boolean;
  onDiscard: () => void; onContinue: () => void;
}) {
  const { t, language } = useTranslation();
  const insets = useSafeAreaInsets();
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onContinue(); }}>
    <AlertDialogContent testID="editor-leave-sheet" overlayClassName="justify-end p-0" className="w-full rounded-b-none" style={{ paddingBottom: insets.bottom + 20 }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('有未保存的修改')}</AlertDialogTitle>
        <AlertDialogDescription>{t('已修改：{items}', { items: changes.map((item) => t(item)).join(language === 'en' ? ', ' : '、') })}</AlertDialogDescription>
      </AlertDialogHeader>
      <View className="gap-2">
        <Button testID="editor-leave-discard" intent="destructive" disabled={busy} onPress={onDiscard}><Text>{t('放弃')}</Text></Button>
        <Button testID="editor-leave-continue" intent="soft" disabled={busy} onPress={onContinue}><Text>{t('继续编辑')}</Text></Button>
      </View>
    </AlertDialogContent>
  </AlertDialog>;
}

export type AgentEditorLeaveControl = { back: () => void; submit: () => Promise<void> };

/** Key only this sibling boundary by leaveIdentity: obsolete destinations disappear without remounting the draft or view. */
export function AgentEditorLeaveBoundary({ selection, changes, save, onMain, ref }: {
  selection: AgentEditorSelection; changes: string[];
  save: () => Promise<boolean>; onMain: () => void; ref: Ref<AgentEditorLeaveControl>;
}) {
  const [unknownOpen, setUnknownOpen] = useState(false);
  const dismiss = useCallback(() => { if (router.canGoBack()) router.back(); else router.replace('/'); }, []);
  const requestUnknown = useCallback(() => setUnknownOpen(true), []);
  const unknown = selection.leaveKind === 'unknown';
  const leave = useEditorLeave(changes.length > 0, selection.busy, dismiss, unknown || selection.phase === 'gone',
    save, selection.autoSaveOnLeave, unknown ? requestUnknown : undefined);
  const back = useCallback(() => {
    if (!selection.canBack) return;
    if (!unknown && selection.panel !== 'main') onMain();
    else leave.request();
  }, [selection.canBack, selection.panel, unknown, onMain, leave]);
  useImperativeHandle(ref, () => ({
    back,
    submit: async () => { if (selection.canSave) await leave.submit(); },
  }), [back, selection.canSave, leave]);
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => subscription.remove();
  }, [back]));
  return <AgentEditorLeaveSheets ordinaryOpen={leave.open && selection.leaveKind === 'ordinary'}
    unknownOpen={unknown && unknownOpen} changes={changes} busy={selection.busy}
    onDiscard={leave.finish} onContinue={leave.cancel}
    onUnknownStay={() => { setUnknownOpen(false); leave.cancel(); }}
    onUnknownLeave={() => { setUnknownOpen(false); leave.finish(); }} />;
}

/** Pure sheets are also used by static view stories; their opening reason is never inferred from a reducer phase. */
export function AgentEditorLeaveSheets({ ordinaryOpen, unknownOpen, changes, busy, onDiscard, onContinue, onUnknownStay, onUnknownLeave }: {
  ordinaryOpen: boolean; unknownOpen: boolean; changes: string[]; busy: boolean;
  onDiscard: () => void; onContinue: () => void; onUnknownStay: () => void; onUnknownLeave: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return <>
    <EditorLeaveSheet open={ordinaryOpen} changes={changes} busy={busy} onDiscard={onDiscard} onContinue={onContinue} />
    <AlertDialog open={unknownOpen} onOpenChange={(open) => { if (!open) onUnknownStay(); }}>
      <AlertDialogContent testID="editor-unknown-leave-sheet" overlayClassName="justify-end p-0" className="w-full rounded-b-none" style={{ paddingBottom: insets.bottom + 20 }}>
        <AlertDialogHeader><AlertDialogTitle>{t('保存结果未确认，离开后本次修改不会保留。')}</AlertDialogTitle></AlertDialogHeader>
        <Button testID="editor-unknown-leave" intent="destructive" onPress={onUnknownLeave}><Text>{t('离开')}</Text></Button>
        <Button testID="editor-unknown-stay" intent="soft" onPress={onUnknownStay}><Text>{t('继续停留')}</Text></Button>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
