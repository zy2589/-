import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function authorizeRequest(request, port, token) {
  const origin = `http://127.0.0.1:${port}`;
  let url;
  try { url = new URL(request.url || '/', origin); decodeURIComponent(url.pathname); }
  catch { return { status: 400 }; }
  const host = request.headers.host;
  if (typeof host !== 'string' || host.trim().toLowerCase() !== `127.0.0.1:${port}` || url.origin !== origin) return { status: 403 };
  if (request.headers.origin && request.headers.origin !== origin) return { status: 403 };
  const headerToken = request.headers['x-editor-session'];
  const cookieHeader = request.headers.cookie;
  let cookieToken = '';
  if (typeof cookieHeader === 'string') {
    const matching = cookieHeader.split(';').map((part) => part.trim())
      .filter((part) => part.startsWith('clipassistant-session='));
    if (matching.length === 1) cookieToken = matching[0].slice('clipassistant-session='.length);
    else if (matching.length > 1) return { status: 403 };
  }
  const supplied = Buffer.from(String(headerToken || cookieToken));
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return { status: 403 };
  if (url.pathname.startsWith('/rpc/') && request.method === 'POST' &&
      !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return { status: 415 };
  return { url };
}

export function contentSecurityPolicy(scriptNonce) {
  const nonce = String(scriptNonce || '');
  if (!/^[A-Za-z0-9+/_=-]{16,128}$/.test(nonce)) throw new Error('Invalid script nonce.');
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`;
}

export function addScriptNonce(html, scriptNonce) {
  const nonce = String(scriptNonce || '');
  if (!/^[A-Za-z0-9+/_=-]{16,128}$/.test(nonce)) throw new Error('Invalid script nonce.');
  return String(html).replace(/<script\b(?![^>]*\bnonce\s*=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
}

export function validateRequestFraming(headers) {
  const transferEncoding = headers['transfer-encoding'];
  const contentLength = headers['content-length'];
  if ((transferEncoding && contentLength !== undefined) ||
      (transferEncoding && !/^chunked$/i.test(String(transferEncoding).trim())) ||
      (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || !Number.isSafeInteger(Number(contentLength)))))
    return false;
  return true;
}

export function sanitizeUploadName(value) {
  const supplied = String(value || 'asset').replace(/[\\/\u0000-\u001f\u007f]/g, '/').slice(-240).split('/').pop().replace(/^[_\.]+|[_\.]+$/g, '') || 'asset';
  const rawExtension = path.extname(supplied);
  const extension = rawExtension.replace(/[^.\p{L}\p{N}]/gu, '').slice(0, 12);
  const base = path.basename(supplied, rawExtension)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80) || 'asset';
  return `${base}${extension}`;
}

export function assertNotSecret(file, supportRoot) {
  const target = fs.realpathSync(file).toLowerCase();
  const secrets = path.resolve(supportRoot, 'secrets').toLowerCase();
  if (target === secrets || target.startsWith(secrets + path.sep)) throw new Error('凭证目录不能作为素材访问。');
}

export function writeRaster(input, directories) {
  const requested = path.resolve(String(input.directory || ''));
  const known = directories.get(requested);
  if (!known || fs.lstatSync(requested).isSymbolicLink() || fs.realpathSync(requested) !== known)
    throw new Error('字幕渲染目录无效或已过期。');
  const name = String(input.name || `caption-${crypto.randomUUID()}.png`);
  if (!/^[a-zA-Z0-9_-]{1,120}\.png$/i.test(name)) throw new Error('字幕图片文件名无效。');
  const raw = String(input.dataUrl || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length > 16 * 1024 * 1024)
    throw new Error('字幕图片格式或大小无效。');
  const bytes = Buffer.from(raw.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 8 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw new Error('字幕图片不是 PNG。');
  const destination = path.join(known, name);
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  return destination;
}
