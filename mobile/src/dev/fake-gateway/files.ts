import type { Handler } from './types.ts';
import { jsonResponse, missing, unavailable } from './response.ts';

export const filesRoutes = {
  'GET /files/:id': ({ gateway, params }) => gateway.state.files.has(params.id) ? jsonResponse(gateway.state.files.get(params.id)) : missing('文件不存在'),
  'GET /files/:id/preview': ({ gateway, params }) => gateway.state.filePreviews.has(params.id) ? jsonResponse(gateway.state.filePreviews.get(params.id)) : missing('文件不存在'),
  'GET /files/:id/thumbnail': () => unavailable('图片暂不可用'),
  'GET /files/:id/content': ({ gateway, params }) => {
    const file = gateway.state.files.get(params.id);
    const bytes = gateway.state.fileBytes.get(params.id);
    if (!file?.available || !bytes) return unavailable('原文件暂不可用', 410);
    return new Response(bytes, { headers: { 'Content-Type': file.media_type } });
  },
  'POST /uploads': ({ gateway, init }) => {
    const headers = new Headers(init.headers);
    const metadata = Object.fromEntries((headers.get('Upload-Metadata') ?? '').split(',').filter(Boolean).map(pair => {
      const [key, value = ''] = pair.trim().split(' ');
      return [key, new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)))];
    }));
    if (!gateway.state.conversations.some(row => row.id === metadata.conversation_id)) return missing('对话不存在');
    const id = `upload-${++gateway.state.seq}`;
    gateway.state.uploads.set(id, { id, length: Number(headers.get('Upload-Length')), metadata, bytes: new Uint8Array(), fileId: null });
    return new Response(null, { status: 201, headers: { Location: `/uploads/${id}`, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0' } });
  },
  'HEAD /uploads/:id': ({ gateway, params }) => {
    const upload = gateway.state.uploads.get(params.id);
    if (!upload) return missing('上传不存在');
    return new Response(null, { status: 200, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(upload.length), 'Upload-Offset': String(upload.bytes.length), ...(upload.fileId ? { 'Upload-File-Id': upload.fileId } : {}) } });
  },
  'PATCH /uploads/:id': ({ gateway, params, init, body }) => {
    const upload = gateway.state.uploads.get(params.id);
    if (!upload) return missing('上传不存在');
    if (!(body instanceof Uint8Array) || Number(new Headers(init.headers).get('Upload-Offset')) !== upload.bytes.length || upload.bytes.length + body.length > upload.length) {
      return new Response(null, { status: 409 });
    }
    const bytes = new Uint8Array(upload.bytes.length + body.length);
    bytes.set(upload.bytes); bytes.set(body, upload.bytes.length); upload.bytes = bytes;
    if (bytes.length === upload.length && !upload.fileId) {
      const conversation = gateway.state.conversations.find(row => row.id === upload.metadata.conversation_id)!;
      upload.fileId = `file-${upload.id}`;
      gateway.state.files.set(upload.fileId, {
        id: upload.fileId, name: upload.metadata.filename, size: bytes.length, media_type: upload.metadata.filetype,
        conversation_id: conversation.id, agent_id: conversation.agent_id, task_id: conversation.id,
        source: 'user_upload', remote_environment: null, created_at: Date.now() / 1000,
        available: true, error: null, error_message: null,
      });
      gateway.state.fileBytes.set(upload.fileId, bytes);
    }
    return new Response(null, { status: 204, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(bytes.length), ...(upload.fileId ? { 'Upload-File-Id': upload.fileId } : {}) } });
  },
  'DELETE /uploads/:id': ({ gateway, params }) => {
    gateway.state.uploads.delete(params.id);
    return new Response(null, { status: 204 });
  },
  'GET /conversations/:id/messages/:seq/media/:block/:element/:index': ({ gateway, url }) => {
    const media = gateway.state.messageMedia.get(url.pathname);
    return media ? jsonResponse(media) : jsonResponse({ error: { code: 'media_not_found', message: 'Image unavailable' } }, 404);
  },
} satisfies Record<string, Handler>;

export const filesUnsupportedRoutes: Record<string, string> = {
  "GET /conversations/:id/messages/:seq/media/:block/:element/:index/content": "富内容预览使用本地资源，不提供网关文件与媒体字节。"
};
