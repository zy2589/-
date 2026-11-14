import path from 'node:path';
import os from 'node:os';
export function applicationRoot() {
  return process.env.CLIPASSIST_STORAGE_ROOT || path.join(
    process.env.USERPROFILE || os.homedir(),
    'Documents', 'ChatGPT', '剪辑助手', '用户数据',
  );
}
export function applicationDataRoot() {
  return process.env.CLIPASSIST_SUPPORT_ROOT || path.join(applicationRoot(), '编辑器数据');
}
