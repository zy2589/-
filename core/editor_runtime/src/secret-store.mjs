import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applicationDataRoot } from './app-paths.mjs';
const currentPrefix = 'DPAPI2:';
const legacyPrefix = 'DPAPI1:';
const macKeychainPrefix = 'KEYCHAIN1:';
const currentEntropy = 'ClipAssistant/secrets/v2';
const legacyEntropy = 'EditorAssistant/secrets/v1';
const bundledCredentialNames = ['gemini-api-key.txt', 'deepgram-api-key.txt'];
const bundledCredentialMarker = '.bundled-credentials-v1';
const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cache = new Map();

function seedBundledCredentials(file) {
  const name = path.basename(file);
  if (!bundledCredentialNames.includes(name)) return;
  const expected = path.resolve(applicationDataRoot(), 'secrets', name).toLowerCase();
  if (path.resolve(file).toLowerCase() !== expected) return;

  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = path.join(directory, bundledCredentialMarker);
  if (fs.existsSync(marker)) return;
  const seedDirectory = new URL('./assets/credential-seed/', import.meta.url);
  let hasSeed = false;
  let complete = true;

  for (const credentialName of bundledCredentialNames) {
    const bundled = new URL(credentialName, seedDirectory);
    if (!fs.existsSync(bundled)) continue;
    hasSeed = true;
    const destination = path.join(directory, credentialName);
    if (fs.existsSync(destination)) continue;

    const encrypted = fs.readFileSync(bundled, 'utf8').trim();
    if (!encrypted.startsWith(currentPrefix) && !encrypted.startsWith(legacyPrefix)) {
      complete = false;
      continue;
    }
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${encrypted}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
      }
    } catch {
      complete = false;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  if (hasSeed && complete) {
    try {
      fs.writeFileSync(marker, 'seeded\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      /* A concurrent first read may have created the marker already. */
    }
  }
}

// Use the Windows-provided host rather than an unsigned helper executable.
// Only this fixed program is passed as an argument; credential data goes over stdin.
export function protectionProgram(mode, entropy = currentEntropy) {
  if (!['protect', 'unprotect'].includes(mode)) throw new Error('无效的凭证操作。');
  const operation = mode === 'protect'
    ? '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  return `$ErrorActionPreference='Stop'; try {
    [Console]::InputEncoding = New-Object Text.UTF8Encoding($false);
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false);
    Add-Type -AssemblyName System.Security;
    $value = [Console]::In.ReadToEnd();
    $entropy = [Text.Encoding]::UTF8.GetBytes('${entropy}');
    [Console]::Write(${operation});
  } catch { [Console]::Error.Write('DPAPI_FAILED'); exit 1 }`;
}
function transform(mode, value, entropy = currentEntropy) {
  const encoded = Buffer.from(protectionProgram(mode, entropy), 'utf16le').toString('base64');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2*1024*1024 });
  if (result.error || result.status !== 0) throw new Error('Windows 凭证保护不可用，未保存明文凭证。');
  return result.stdout;
}
function keychainAccount(file) {
  return crypto.createHash('sha256').update(path.resolve(file)).digest('hex');
}
function macKeychain(mode, file, value = '') {
  const helper = process.env.CLIPASSIST_KEYCHAIN_HELPER || path.resolve(
    path.dirname(file), '..', 'runtime', 'keychain-helper',
  );
  if (!fs.existsSync(helper)) throw new Error('macOS 钥匙串保护组件不可用，未保存明文凭证。');
  const result = spawnSync(helper, [mode, keychainAccount(file)], {
    input: String(value), encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error('macOS 钥匙串操作失败，未保存明文凭证。');
  return result.stdout || '';
}
export function writeProtectedSecret(file, value) {
  try { seedBundledCredentials(file); } catch { /* bundled credentials are optional */ }
  if (!value) {
    if (process.platform === 'darwin') macKeychain('delete', file);
    fs.rmSync(file, {force:true}); cache.delete(file); return;
  }
  if (process.platform === 'darwin') {
    const account = keychainAccount(file);
    macKeychain('set', file, String(value));
    fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${macKeychainPrefix}${account}\n`, {encoding:'utf8',mode:0o600,flag:'wx'});
      fs.renameSync(temporary,file);
    } finally { fs.rmSync(temporary,{force:true}); }
    cache.delete(file);
    return;
  }
  const stored = `${currentPrefix}${transform('protect', String(value), currentEntropy).trim()}`;
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, stored, {encoding:'utf8',mode:0o600,flag:'wx'}); fs.renameSync(temporary,file); }
  finally { fs.rmSync(temporary,{force:true}); }
  cache.delete(file);
}
export function readProtectedSecret(file) {
  try { seedBundledCredentials(file); } catch { /* bundled credentials are optional */ }
  if (!fs.existsSync(file)) { cache.delete(file); return ''; }
  const stored = fs.readFileSync(file,'utf8').trim();
  if (!stored) return '';
  if (process.platform === 'darwin' && stored.startsWith(macKeychainPrefix)) {
    const account = stored.slice(macKeychainPrefix.length);
    if (!/^[a-f0-9]{64}$/.test(account) || account !== keychainAccount(file))
      throw new Error('macOS 钥匙串凭证索引无效，未加载凭证。');
    const saved = cache.get(file);
    if (saved?.stored === stored) return saved.value;
    const value = macKeychain('get', file).replace(/\r?\n$/, '');
    cache.set(file, {stored,value});
    return value;
  }
  if (stored.startsWith(currentPrefix)) {
    if (process.platform === 'darwin')
      throw new Error('此凭证由另一台 Windows 设备保护，无法在 Mac 解密；请在 Mac 重新输入。');
    const saved = cache.get(file);
    if (saved?.stored === stored) return saved.value;
    const value = transform('unprotect', stored.slice(currentPrefix.length), currentEntropy);
    cache.set(file, {stored,value});
    return value;
  }
  if (stored.startsWith(legacyPrefix)) {
    if (process.platform === 'darwin')
      throw new Error('此凭证由另一台 Windows 设备保护，无法在 Mac 解密；请在 Mac 重新输入。');
    const value = transform('unprotect', stored.slice(legacyPrefix.length), legacyEntropy);
    try { writeProtectedSecret(file, value); } catch { /* retain the readable existing credential */ }
    return value;
  }
  // Migrate credentials written by older versions as soon as they are read.
  // Keep legacy reads working on non-Windows platforms where DPAPI is absent.
  if (process.platform === 'win32') {
    try {
      writeProtectedSecret(file, stored);
      return readProtectedSecret(file);
    } catch {
      // Preserve the legacy file, but do not silently use it without DPAPI.
      throw new Error('Windows 凭证保护不可用，未加载未保护的凭证；现有凭证文件已保留。');
    }
  }
  if (process.platform === 'darwin') {
    // Migrate an old non-Windows plaintext credential to Keychain on first use.
    writeProtectedSecret(file, stored);
    return stored;
  }
  return stored;
}
