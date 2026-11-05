type Keys<T> = T extends unknown ? keyof T : never;
type Value<T, Key extends PropertyKey> = T extends unknown ? Key extends keyof T ? T[Key] : never : never;
type Combined<Groups extends readonly Record<string, unknown>[]> = { [Key in Keys<Groups[number]>]: Value<Groups[number], Key> };

/** Parameter names are not route identity: /agents/:id and /agents/:agent collide. */
export function assertUniqueGatewayRoutes(...groups: readonly Record<string, unknown>[]): void {
  const names = new Map<string, string>();
  for (const group of groups) for (const key of Object.keys(group)) {
    const normalized = key.replace(/:[^/]+/g, ':param');
    const previous = names.get(normalized);
    if (previous !== undefined) throw new Error(`重复的假网关路由：${previous} / ${key}`);
    names.set(normalized, key);
  }
}

/** Keep literal keys for GatewayRoute/overrides, but reject collisions before copying any group. */
export function combineGatewayRoutes<const Groups extends readonly Record<string, unknown>[]>(...groups: Groups): Combined<Groups> {
  assertUniqueGatewayRoutes(...groups);
  return Object.assign({}, ...groups) as Combined<Groups>;
}
