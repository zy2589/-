import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

// A stale browser seek (e.g. after an in-place replacement) is not a server error.
export function parseAssetRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match || !size || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function serveAsset(request, response, filePath, contentType) {
  let file;
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    // Stat the opened handle, not a path that can disappear/change between calls.
    file = await open(filePath, "r");
    const stat = await file.stat();
    if (!stat.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (response.destroyed || request.aborted) return;
    const range = parseAssetRange(request.headers.range, stat.size);
    response.setHeader("Content-Type", contentType || "application/octet-stream");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    if (range === false) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Content-Length": 0 });
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const length = stat.size ? end - start + 1 : 0;
    response.writeHead(range ? 206 : 200, {
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
      "Content-Length": length,
    });
    if (request.method === "HEAD" || !length) {
      response.end();
      return;
    }
    const stream = file.createReadStream({ start, end, autoClose: true });
    file = null; // Stream owns the handle; pipeline closes it on cancellation/error.
    await pipeline(stream, response);
  } catch (error) {
    // Changing sources normally aborts old requests. Never let that kill Node.
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = ["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code) ? 404
      : ["EACCES", "EPERM"].includes(error?.code) ? 403 : 500;
    response.writeHead(status, { "Content-Length": 0 });
    response.end();
  } finally {
    if (file) await file.close().catch(() => {});
  }
}
