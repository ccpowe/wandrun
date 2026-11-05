const violations: string[] = [];

/** A page may catch a transport error; teardown must still fail for missing fake routes. */
export function assertNoUnhandledGatewayRequests(): void {
  const messages = violations.splice(0);
  if (messages.length) throw new Error(messages.join('\n'));
}

export function unhandled(method: string, path: string, reason = '没有实现此接口'): never {
  const message = `[Storybook 假网关] ${method} ${path}：${reason}`;
  violations.push(message);
  console.error(message);
  throw new Error(message);
}
