import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const allowedSeeds = new Set([
  "one-click-presets.json",
  "export-preferences.json",
  "speech-settings.json",
  "review-settings.json",
  "sidebar-panels.json",
]);

export function seedUserPreference(destinationPath, seedName) {
  if (!allowedSeeds.has(String(seedName || ""))) return false;
  const destination = path.resolve(destinationPath);
  if (fs.existsSync(destination)) return false;

  const bundled = new URL(`./assets/user-seed/${seedName}`, import.meta.url);
  if (!fs.existsSync(bundled)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) return false;

  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(bundled, temporary, fs.constants.COPYFILE_EXCL);
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return fs.existsSync(destination);
}
