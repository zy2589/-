import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sanitizeSvgPaint } from "../core/editor_runtime/src/preset-safety.mjs";
import {
  authorizeRequest,
  addScriptNonce,
  contentSecurityPolicy,
  assertNotSecret,
  sanitizeUploadName,
  validateRequestFraming,
  writeRaster,
} from "../core/editor_runtime/src/security.mjs";

test("SVG paint accepts only simple hex colors", () => {
  assert.equal(sanitizeSvgPaint("#68A9A2"), "#68A9A2");
  assert.equal(sanitizeSvgPaint("#abc"), "#abc");
  assert.equal(sanitizeSvgPaint('red" onload="alert(1)'), "#68A9A2");
  assert.equal(sanitizeSvgPaint("url(https://example.invalid/p.svg#x)"), "#68A9A2");
});

test("inline page scripts require a fresh nonce and handlers are blocked", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const policy = contentSecurityPolicy(nonce);
  assert.match(policy, /script-src 'self' 'nonce-0123456789abcdef0123456789abcdef' 'wasm-unsafe-eval'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.equal(addScriptNonce('<script>run()</script><script src="/app.js"></script>', nonce),
    '<script nonce="0123456789abcdef0123456789abcdef">run()</script><script nonce="0123456789abcdef0123456789abcdef" src="/app.js"></script>');
  assert.throws(() => contentSecurityPolicy("short"));
});

test("local editor RPC requires the loopback host, origin, and session token", () => {
  const port = 43123;
  const token = "unit-test-session-token";
  const accepted = authorizeRequest({
    url: "/rpc/ping",
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      "x-editor-session": token,
      "content-type": "application/json",
    },
  }, port, token);
  assert.equal(accepted.status, undefined);
  assert.equal(authorizeRequest({
    url: "/rpc/ping",
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin: "https://attacker.invalid", "x-editor-session": token },
  }, port, token).status, 403);
  assert.equal(authorizeRequest({
    url: "/rpc/ping",
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
  }, port, token).status, 403);
});

test("request framing rejects conflicting or malformed lengths", () => {
  assert.equal(validateRequestFraming({ "content-length": "12" }), true);
  assert.equal(validateRequestFraming({ "transfer-encoding": "chunked" }), true);
  assert.equal(validateRequestFraming({ "content-length": "12", "transfer-encoding": "chunked" }), false);
  assert.equal(validateRequestFraming({ "content-length": "12x" }), false);
});

test("uploaded raster names cannot escape their registered directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipassistant-security-test-"));
  try {
    const raster = path.join(root, "raster");
    fs.mkdirSync(raster);
    const directories = new Map([[path.resolve(raster), fs.realpathSync(raster)]]);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    assert.throws(() => writeRaster({ directory: raster, name: "../outside.png", dataUrl: `data:image/png;base64,${signature}` }, directories));
    const destination = writeRaster({ directory: raster, name: "caption-1.png", dataUrl: `data:image/png;base64,${signature}` }, directories);
    assert.equal(path.dirname(destination), raster);
    assert.equal(fs.readFileSync(destination).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("credential directory cannot be exposed as a normal asset", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipassistant-secrets-test-"));
  try {
    const secrets = path.join(root, "secrets");
    fs.mkdirSync(secrets);
    const secretFile = path.join(secrets, "credential.txt");
    const regularFile = path.join(root, "asset.png");
    fs.writeFileSync(secretFile, "test");
    fs.writeFileSync(regularFile, "test");
    assert.throws(() => assertNotSecret(secretFile, root));
    assert.doesNotThrow(() => assertNotSecret(regularFile, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("download output names discard path components and controls", () => {
  assert.equal(sanitizeUploadName("../../clip.mp4"), "clip.mp4");
});
