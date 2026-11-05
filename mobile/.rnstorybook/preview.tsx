import type { Preview } from '@storybook/react-native';
import { View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GatewayQueryProvider } from '../src/lib/gateway-query-provider';

// Full-page stories own their content insets; component stories keep the gallery's 16dp inset.
const preview: Preview = {
  decorators: [(Story, context) => (
    <GatewayQueryProvider><SafeAreaProvider>
      <View className="flex-1 bg-background">
        <SafeAreaView style={{ flex: 1 }}>
          <View className={context.parameters.fullScreen ? "flex-1" : "flex-1 p-4"}><Story /></View>
        </SafeAreaView>
      </View>
    </SafeAreaProvider></GatewayQueryProvider>
  )],
};
export default preview;
