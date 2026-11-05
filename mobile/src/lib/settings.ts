/** Switching is the page's own flow; its one-time failure result is published via the page visit
 * (useVisitNotice), not stored here, so it can never outlive the visit that started it. */
export type SettingsSwitchState = { status: 'idle' } | { status: 'switching'; operationId: string };
export type SettingsSwitchEvent = { type: 'switch-started'; operationId: string }
  | { type: 'switch-succeeded' | 'switch-failed'; operationId: string };

export function settingsSwitchReducer(state: SettingsSwitchState, event: SettingsSwitchEvent): SettingsSwitchState {
  switch (state.status) {
    case 'idle': return event.type === 'switch-started' ? { status: 'switching', operationId: event.operationId } : state;
    case 'switching':
      if (event.operationId !== state.operationId) return state;
      return event.type === 'switch-succeeded' || event.type === 'switch-failed' ? { status: 'idle' } : state;
  }
}

export function selectSettingsPage(state: SettingsSwitchState, online: boolean, connectionLabel: string | null,
  resources: readonly { error: unknown; data: unknown }[], operationError = '') {
  const readError = resources.some(resource => !!resource.error);
  const stale = resources.some(resource => !!resource.error && resource.data !== undefined);
  return { busy: state.status === 'switching', disabled: !online,
    message: operationError || connectionLabel || (readError ? '无法加载设置，正在重试…' : ''),
    dismissible: !!operationError, stale: !operationError && (!!connectionLabel || stale) };
}
