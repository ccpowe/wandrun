import { render, screen } from '@testing-library/react-native';
import { View } from 'react-native';
import { DrawerGestureContext } from 'react-native-drawer-layout';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { AudioCard } from '../src/components/chat/audio-native';
import { SceneProviders } from '../src/dev/scene-providers';

// Only the native audio SDK is replaced. The production AudioCard, control hit View,
// DrawerGestureContext and RNGH gesture construction/detector all remain real.
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ pause() {}, play() {}, async seekTo() {} }),
  useAudioPlayerStatus: () => ({ playing: false, duration: 16, currentTime: 0, didJustFinish: false }),
}));

const file = { id: 'native-control', name: 'tone.wav', media_type: 'audio/wav', size: 256044 };

afterEach(() => jest.restoreAllMocks());

test('attachment.A6 Slider has its own non-flattenable native hit area which blocks the actual drawer pan', async () => {
  const drawerPan = Gesture.Pan();
  const native = jest.spyOn(Gesture, 'Native'); // Call through to RNGH's real builder.
  await render(<GestureHandlerRootView><SceneProviders>
    <DrawerGestureContext.Provider value={drawerPan}><GestureDetector gesture={drawerPan}>
      <View><AudioCard file={file} /></View>
    </GestureDetector></DrawerGestureContext.Provider>
  </SceneProviders></GestureHandlerRootView>);
  const slider = screen.getByLabelText('音频进度');
  expect(slider).toBeOnTheScreen();
  // Slider 5.x's layout host must be inside the dedicated materialized control
  // host, not directly inside the card (which also contains the play button).
  expect(slider.parent?.props.onLayout).toEqual(expect.any(Function));
  expect(slider.parent?.parent?.props.collapsable).toBe(false);
  expect(slider.parent?.parent?.children).toHaveLength(1);
  // The actual Native gesture is constructed by the production component.
  // These native interop assertions do not prove Android resolves the drag;
  // attachments-audio.yaml proves the seek and drawer outcomes on the phone.
  const gesture = native.mock.results[0].value;
  expect(gesture.config.shouldActivateOnStart).toBe(true);
  expect(gesture.config.disallowInterruption).toBe(true);
  expect(drawerPan.handlerTag).toBeGreaterThanOrEqual(0);
  expect(gesture.config.blocksHandlers).toContain(drawerPan.handlerTag);
});

test('attachment.A6 a player outside the drawer keeps the Slider without installing a drawer blocker', async () => {
  const native = jest.spyOn(Gesture, 'Native');
  await render(<GestureHandlerRootView><SceneProviders><AudioCard file={file} /></SceneProviders></GestureHandlerRootView>);
  expect(screen.getByLabelText('音频进度')).toBeOnTheScreen();
  expect(native).not.toHaveBeenCalled();
});
