import '../global.css';
import { registerRootComponent } from 'expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LiteUI } from '@storybook/react-native-ui-lite';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { view } from './storybook.requires';
import { StatusBarTheme } from '../src/lib/use-status-bar-appearance';
// Official lightweight navigator keeps taps/dragging in the library without Gorhom/Reanimated coupling.
const StorybookUI = view.getStorybookUI({ onDeviceUI: true, storage: AsyncStorage, enableWebsockets: false, CustomUIComponent: LiteUI });
// Window/inset ownership must precede Storybook's navigation, not mount inside an individual scene.
export default function StorybookRoot() {
  return <KeyboardProvider statusBarTranslucent navigationBarTranslucent><StatusBarTheme /><StorybookUI /></KeyboardProvider>;
}
registerRootComponent(StorybookRoot);
