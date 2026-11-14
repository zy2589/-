// Shared by persisted templates and the UI, including legacy/imported templates.
export function sanitizePresetStyle(style) {
  const safe = {};
  if (!style || typeof style !== 'object' || Array.isArray(style)) return safe;
  for (const [key, value] of Object.entries(style)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) continue;
    if (typeof value === 'boolean') safe[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'string' && value.length <= 200 &&
      !/[<>"'`\\;{}\r\n\x00-\x1f]/.test(value) && !/url\s*\(|expression\s*\(|@import/i.test(value)) safe[key] = value;
  }
  return safe;
}
