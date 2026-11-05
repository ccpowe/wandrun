#!/usr/bin/env bash
# Focused native Storybook QA, not a replacement Maestro runner.
# Call under the assigned device lock. No test IME or persistent device setting is changed.
set -euo pipefail
SERIAL=${ANDROID_SERIAL:?ANDROID_SERIAL is required; select an assigned device explicitly}
METRO_PORT=${METRO_PORT:-8102}
STATE_DIR=${STATE_DIR:-$HOME/.cache/wandrun-tmp/g1-device}
ARTIFACTS=${ARTIFACTS:-$HOME/.cache/wandrun-tmp/g1-native-20261031}
mkdir -p "$ARTIFACTS"
ad() { agent-device --state-dir "$STATE_DIR" --session g1-host --platform android --serial "$SERIAL" "$@"; }
cleanup() { ad logs stop >/dev/null 2>&1 || true; ad close >/dev/null 2>&1 || true; }
trap cleanup EXIT
scene() {
  ad open host.exp.exponent "exp://127.0.0.1:$METRO_PORT/--/?STORYBOOK_STORY_ID=$1"
  ad wait "text=\"$2\"" 60000
  ad wait stable
}
edit_planner() {
  ad wait 'id="agent-row-planner"' 15000
  # Observed row rect on this tablet: (40,210,1720,150). No native selector row-swipe API.
  ad gesture pan 1650 285 -1000 0 500
  ad wait "label=\"编辑 $1\"" 10000
  ad press "label=\"编辑 $1\""
  ad wait 'id="editor-name"' 15000
}
input_ascii() {
  ad press "id=\"$1\""
  adb -s "$SERIAL" shell input keycombination 113 29
  adb -s "$SERIAL" shell input keyevent 67
  adb -s "$SERIAL" shell input text "$2"
  adb -s "$SERIAL" shell input keyevent 4
  # Secure pairing input is intentionally redacted; the settings destination proves its exchange.
  if [[ "$1" != pairing-code ]]; then ad wait "id=\"$1\" text=\"$2\"" 10000; fi
}
ad open host.exp.exponent --relaunch --foreground --no-test-ime
ad logs start
scene agent-editor--a-2-list 'agent-editor/A2 从列表左滑编辑 / ＋进入'
edit_planner 小万
ad back --system
ad wait 'id="agent-row-planner" label="查看 小万 的资料"' 15000
ad screenshot "$ARTIFACTS/00-pristine-system-back.png"
ad wait stable
edit_planner 小万
input_ascii editor-name G1HardwareSaved
ad screenshot "$ARTIFACTS/01-before-hardware-back.png"
ad back --system
ad wait 'id="agent-row-planner" label="查看 G1HardwareSaved 的资料"' 15000
ad screenshot "$ARTIFACTS/02-hardware-back-saved.png"
ad wait stable
edit_planner G1HardwareSaved
input_ascii editor-name G1GestureSaved
ad screenshot "$ARTIFACTS/03-before-edge-back.png"
ad gesture swipe left-edge
ad wait 'id="agent-row-planner" label="查看 G1GestureSaved 的资料"' 15000
ad screenshot "$ARTIFACTS/04-edge-back-saved.png"
ad press 'id="agent-row-planner"'
ad wait 'id="profile-name" text="G1GestureSaved"' 15000
ad screenshot "$ARTIFACTS/10-saved-agent-profile-entry.png"
scene agent-editor--b-4 'agent-editor/B4 修改后返回 · 结果未确认，只读且离开前确认'
ad wait 'id="editor-name"' 15000
input_ascii editor-name G1UnknownHardware
ad press 'id="editor-save"'
ad wait 'text="结果未确认，恢复连接后会核对"' 15000
ad back --system
ad wait 'id="editor-unknown-leave"' 10000
ad screenshot "$ARTIFACTS/05-unknown-hardware-confirm.png"
ad press 'id="editor-unknown-leave"'
ad wait 'id="agent-row-planner"' 15000
scene agent-editor--b-4-dark 'agent-editor/B4 结果未确认与离开确认（深色）'
ad wait 'id="editor-name"' 15000
ad screenshot "$ARTIFACTS/06-editor-dark-avatar.png"
input_ascii editor-name G1UnknownGesture
ad press 'id="editor-save"'
ad wait 'text="结果未确认，恢复连接后会核对"' 15000
ad gesture swipe left-edge
ad wait 'id="editor-unknown-leave"' 10000
ad screenshot "$ARTIFACTS/07-unknown-edge-confirm-dark.png"
ad press 'id="editor-unknown-leave"'
ad wait 'id="agent-row-planner"' 15000
scene agent-editor--a-4-dark 'agent-editor/A4 离线放弃确认（深色）'
ad wait 'id="editor-name"' 15000
input_ascii editor-name G1OfflineDraft
ad back --system
ad wait 'id="editor-leave-discard"' 10000
ad screenshot "$ARTIFACTS/08-offline-discard-dark.png"
ad press 'id="editor-leave-discard"'
ad wait 'id="agent-row-planner"' 15000
scene settings-connect--a-1 'settings-connect/A1 添加服务器 · 手动配对后进入设置'
ad wait 'id="pairing-manual"' 15000
ad press 'id="pairing-manual"'
input_ascii pairing-address https://pairing-story.invalid
input_ascii pairing-code B1PAIR01
ad press 'id="pairing-submit"'
ad wait 'id="settings-connection"' 15000
ad screenshot "$ARTIFACTS/09-pairing-runtime-admitted.png"
