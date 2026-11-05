export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
export const unavailable = (message = '暂不可用', status = 503) => jsonResponse({ error: { code: 'unavailable', message } }, status);
export const missing = (message: string) => jsonResponse({ error: { code: 'not_found', message } }, 404);
