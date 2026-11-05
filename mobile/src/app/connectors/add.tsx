import { Redirect, router, Stack } from 'expo-router';
import { ChevronLeft, Globe, Terminal } from 'lucide-react-native';
import { View } from 'react-native';
import { GroupRow } from '@/components/group-row';
import { ListGroup } from '@/components/list-group';
import { ScreenBar } from '@/components/screen-bar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ConnectionBanner } from '@/lib/connection-banner';
import { useTranslation } from '@/lib/i18n';
import { useSession } from '@/lib/session-context';
export default function AddConnectorRoute() {
  const session = useSession(); const { t } = useTranslation();
  if (!session) return <Redirect href="/" />;
  return <View className="flex-1 bg-muted dark:bg-background"><Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t('添加连接器')} left={<Button intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={() => router.back()}><Icon as={ChevronLeft} /></Button>} />
    <ConnectionBanner session={session} />
    <ListGroup><GroupRow title={t('远程地址')} description={t('连接一个在线服务')} icon={Globe} affordance="navigate" onPress={() => router.push('/connectors/add-remote')} />
      <GroupRow title={t('本地命令')} description={t('在服务器上运行一条命令')} icon={Terminal} affordance="navigate" onPress={() => router.push('/connectors/add-local')} /></ListGroup>
  </View>;
}
