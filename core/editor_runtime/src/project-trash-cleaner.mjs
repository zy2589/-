import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { readLargeJson } from "./large-json-file.mjs";

const idPattern = /^[a-f0-9-]{24,64}$/i;
const { projectId, directory, root } = workerData;
const projectRoots = [path.join(root, "projects"), path.join(root, "splice-projects")];
const cacheRoots = [path.join(root, "previews"), path.join(root, "temp")];

function collectCachePaths(value, output) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) collectCachePaths(child, output);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["previewPath", "projectCoverPath", "thumbnailPath"].includes(key) &&
        typeof child === "string" && child) output.add(path.resolve(child).toLowerCase());
    else if (child && typeof child === "object") collectCachePaths(child, output);
  }
}

function projectCachePaths(projectDirectory) {
  const paths = new Set();
  const files = [path.join(projectDirectory, "project.json")];
  const history = path.join(projectDirectory, "autosave-history");
  try {
    for (const entry of fs.readdirSync(history, { withFileTypes: true })) {
      if (entry.isFile() && /^autosave-\d{13}\.json$/.test(entry.name))
        files.push(path.join(history, entry.name));
    }
  } catch {}
  for (const file of files) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) collectCachePaths(readLargeJson(file), paths);
    } catch {}
  }
  return paths;
}

function otherProjectReferences() {
  const paths = new Set();
  for (const projectRoot of projectRoots) {
    let entries;
    try { entries = fs.readdirSync(projectRoot, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === projectId || !idPattern.test(entry.name)) continue;
      const projectDirectory = path.join(projectRoot, entry.name);
      if (fs.existsSync(path.join(projectDirectory, ".deleted"))) continue;
      for (const file of projectCachePaths(projectDirectory)) paths.add(file);
    }
  }
  return paths;
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cacheFileIsSafe(file, cacheRoot) {
  if (!inside(cacheRoot, file)) return false;
  const resolvedRoot = path.resolve(cacheRoot).toLowerCase();
  let current = path.resolve(file);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch { return false; }
    if (current.toLowerCase() === resolvedRoot) break;
    if (!inside(cacheRoot, current)) return false;
    current = path.dirname(current);
  }
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

async function removeDirectory(target) {
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

try {
  const trashRoot = path.join(root, "deleted-projects");
  const oldTrash = [];
  try {
    for (const entry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(`${projectId}-`))
        oldTrash.push(path.join(trashRoot, entry.name));
    }
  } catch {}

  const targetCaches = projectCachePaths(directory);
  for (const oldDirectory of oldTrash) {
    for (const file of projectCachePaths(oldDirectory)) targetCaches.add(file);
  }
  const shared = otherProjectReferences();

  await removeDirectory(directory);
  for (const oldDirectory of oldTrash) {
    if (path.resolve(oldDirectory) === path.resolve(directory)) continue;
    await removeDirectory(oldDirectory);
  }
  for (const cachePath of targetCaches) {
    if (shared.has(cachePath)) continue;
    const cacheRoot = cacheRoots.find(candidate => inside(candidate, cachePath));
    if (!cacheRoot || !cacheFileIsSafe(cachePath, cacheRoot)) continue;
    try { await fs.promises.rm(cachePath, { force: true, maxRetries: 5, retryDelay: 100 }); }
    catch {}
  }
} catch {}
finally { parentPort?.close(); }
