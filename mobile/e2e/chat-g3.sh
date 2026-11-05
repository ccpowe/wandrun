#!/usr/bin/env bash
# G3 focused native Storybook QA (chat page assembly), not a replacement Maestro runner.
# Run under the assigned device lock with this worktree's Storybook Metro:
#   flock ~/.cache/wandrun-tmp/device-tablet.lock mobile/e2e/chat-g3.sh
# Stories use the fake gateway at the HTTP boundary; the real route, session,
# keyboard-controller and LegendList run natively. No test IME or device setting is changed.
set -euo pipefail
SERIAL=${ANDROID_SERIAL:?ANDROID_SERIAL is required; select an assigned device explicitly}
METRO_PORT=${METRO_PORT:-8102}
STATE_DIR=${STATE_DIR:-$HOME/.cache/wandrun-tmp/g3-device}
ARTIFACTS=${ARTIFACTS:-$HOME/.cache/wandrun-tmp/g3-native-$(date +%Y%m%d)}
mkdir -p "$ARTIFACTS"
ad() { agent-device --state-dir "$STATE_DIR" --session g3-chat --platform android --serial "$SERIAL" "$@"; }
cleanup() { ad logs stop >/dev/null 2>&1 || true; ad close >/dev/null 2>&1 || true; }
trap cleanup EXIT
adb -s "$SERIAL" reverse tcp:"$METRO_PORT" tcp:"$METRO_PORT" >/dev/null
scene() {
  ad open host.exp.exponent "exp://127.0.0.1:$METRO_PORT/--/?STORYBOOK_STORY_ID=$1"
  ad wait "$2" 60000
  ad wait stable
}
shot() { ad screenshot "$ARTIFACTS/$1.png"; }

ad open host.exp.exponent --relaunch --foreground --no-test-ime
ad logs start

# 1. In-place hints (chat.G7 / C7) as views, light and dark, under the banner.
scene chat-localnotice--g-7-send 'id="chat-local-send"'; shot 01-g7-send-light
scene chat-localnotice--g-7-under-banner 'id="chat-offline-error"'; shot 02-g7-under-banner-dark
scene chat-localnotice--c-7-missing 'id="chat-local-missing"'; shot 04-c7-missing-dark




if [[ -z ${ONLY_SCROLL:-} ]]; then
# 4. Chat core assembly: quote + keyboard above the composer without covering the last row; a send
#    is proven by its own visible row, not by the composer clearing.
rect() { ad get attrs "$1" --json | python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["node"]["rect"]; print(int(r["y"]), int(r["y"]+r["height"]))'; }
scene chat--i-2 'id="composer-input"'
ad wait 'id="message-menu-trigger-e89"' 20000
ad longpress 'id="message-menu-trigger-e89"' 800
ad wait 'id="message-menu-quote-e89"' 10000
ad press 'id="message-menu-quote-e89"'
ad wait 'id="composer-quote"' 10000
ad press 'id="composer-input"'
ad wait stable
read -r _ LAST_BOTTOM < <(rect 'id="message-copy-e90"')
read -r QUOTE_TOP _ < <(rect 'id="composer-quote"')
echo "keyboard: last row bottom=$LAST_BOTTOM composer (quote) top=$QUOTE_TOP"
(( LAST_BOTTOM <= QUOTE_TOP )) || { echo "keyboard/composer covers the last row" >&2; shot 11-covered; exit 1; }
shot 11-quote-keyboard-open
ad press 'label="取消引用"' # send a plain message so its row text is exactly what was typed
SENT="G3Plain$(date +%s)" # unique per run: the story peer may keep earlier sends
adb -s "$SERIAL" shell input text "$SENT"
ad press 'id="composer-send"'
ad wait "text=\"$SENT\" visible=true" 10000
read -r _ SENT_BOTTOM < <(rect "text=\"$SENT\"")
read -r INPUT_TOP _ < <(rect 'id="composer-input"')
echo "sent: new row bottom=$SENT_BOTTOM composer top=$INPUT_TOP"
(( SENT_BOTTOM <= INPUT_TOP )) || { echo "the sent row is not visible above the composer" >&2; exit 1; }
shot 12-sent-row-visible
adb -s "$SERIAL" shell input keyevent 4
ad wait stable; shot 13-keyboard-closed
fi

# 5. Scroll red line (§4.1) with a reply that keeps streaming (story C3; the row grows every 0.4 s):
#    reading older messages is not pulled back. Following the bottom is asserted by run.py chat with a
#    real gateway stream; story C3 does not follow before or after G3 (known, under investigation),
#    so that check is opt-in here (CHECK_FOLLOW=1).
adb -s "$SERIAL" shell am force-stop host.exp.exponent # a fresh story peer (the stream restarts)
ad open host.exp.exponent --relaunch --foreground --no-test-ime
scene chat--c-3 'id="composer-input"'
ad wait 'id="draft-stream"' 20000 # the reply starts ~5 s after the chat settled at the bottom
sleep 5
read -r _ STREAM_BOTTOM < <(rect 'id="draft-stream"')
read -r COMPOSER_TOP _ < <(rect 'id="composer-input"')
echo "following: stream bottom=$STREAM_BOTTOM composer top=$COMPOSER_TOP"
# Following: the growing row ends just above the composer (not hidden below it), no jump button.
if [[ -n ${CHECK_FOLLOW:-} ]]; then
  (( STREAM_BOTTOM <= COMPOSER_TOP && COMPOSER_TOP - STREAM_BOTTOM < 400 )) || { echo "not following the stream" >&2; shot 14-stream-not-following; exit 1; }
  ad wait 'id="chat-return-to-bottom" hidden=true' 3000
fi
shot 14-stream-started
ad gesture pan 900 900 0 1300 400 # read older messages
ad wait 'id="chat-return-to-bottom"' 10000
ad wait 'text="第 32 条回复：整理资料并核对来源，整理资料并核对来源，整理资料并核对来源，"' 5000
read -r READ_TOP _ < <(rect 'text="第 32 条回复：整理资料并核对来源，整理资料并核对来源，整理资料并核对来源，"')
sleep 3
read -r READ_TOP_LATER _ < <(rect 'text="第 32 条回复：整理资料并核对来源，整理资料并核对来源，整理资料并核对来源，"')
echo "reading: row top $READ_TOP -> $READ_TOP_LATER while the stream kept growing"
(( READ_TOP == READ_TOP_LATER )) || { echo "the reader was moved by the stream" >&2; exit 1; }
shot 15-reading-not-pulled-back
echo "G3 native checks done; screenshots in $ARTIFACTS"
