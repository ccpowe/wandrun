import { agentsRoutes } from './agents.ts';
import { modelsRoutes } from './models.ts';
import { settingsRoutes } from './settings.ts';
import { computerRoutes, computerUnsupportedRoutes } from './computer.ts';
import { conversationsRoutes } from './conversations.ts';
import { memoryRoutes } from './memory.ts';
import { schedulesRoutes, schedulesUnsupportedRoutes } from './schedules.ts';
import { connectorsRoutes } from './connectors.ts';
import { browserRoutes, browserUnsupportedRoutes } from './browser.ts';
import { appsRoutes } from './apps.ts';
import { skillsRoutes } from './skills.ts';
import { filesRoutes, filesUnsupportedRoutes } from './files.ts';
import { searchRoutes } from './search.ts';
import { assertUniqueGatewayRoutes, combineGatewayRoutes } from './route-registry.ts';

/** Resource modules own paths and semantics; this entry only registers resources. */
export const routes = combineGatewayRoutes(
  agentsRoutes, modelsRoutes, settingsRoutes, computerRoutes, conversationsRoutes,
  memoryRoutes, schedulesRoutes, connectorsRoutes, browserRoutes, appsRoutes,
  skillsRoutes, filesRoutes, searchRoutes,
);

/** Unsupported requests fail strictly and carry their resource owner’s reason. */
export const unsupportedGatewayRoutes = combineGatewayRoutes(
  computerUnsupportedRoutes, schedulesUnsupportedRoutes, filesUnsupportedRoutes, browserUnsupportedRoutes,
);
assertUniqueGatewayRoutes(routes, unsupportedGatewayRoutes);
