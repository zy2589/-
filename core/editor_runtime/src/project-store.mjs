import {readLargeJson,writeLargeJson} from './large-json-file.mjs';
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { notifyCacheActivity } from './cache-service.mjs';
import { writeProjectMetadata, queryProjectCatalog } from './project-catalog.mjs';
import { supportRoot } from "./media.mjs";
import { archiveEntries, createArchive, extractArchive } from "./platform.mjs";

const normalizeWorkspaceMode = value => String(value || "edit") === "splice" ? "splice" : "edit";
const projectsRoot = (workspaceMode = "edit") => {
  const value = path.join(supportRoot(), normalizeWorkspaceMode(workspaceMode) === "splice" ? "splice-projects" : "projects");
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  return value;
};
const projectRoots = () => [projectsRoot("edit"), projectsRoot("splice")];
const PROJECT_FORMAT = "ClipAssistantProject";

function validateId(id) {
  const value = String(id || "");
  if (!/^[a-f0-9-]{24,64}$/i.test(value)) throw new Error("工程编号无效。");
  return value;
}

function projectDirectory(id, workspaceMode = "") {
  const safeId = validateId(id);
  if (workspaceMode) return path.join(projectsRoot(workspaceMode), safeId);
  for (const root of projectRoots()) {
    const candidate = path.join(root, safeId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(projectsRoot("edit"), safeId);
}
const projectFile = (id) => path.join(projectDirectory(id), "project.json");
const HISTORY_LIMIT = 20;
const HISTORY_INTERVAL_MS = 60_000;
const permanentlyDeletedProjectIds = new Set();
const deletingProjectIds = new Set();
const projectTrashCleanupJobs = new Set();
let legacyDeletionIndexLoaded = false;

function loadLegacyDeletedProjects() {
  if (legacyDeletionIndexLoaded) return;
  legacyDeletionIndexLoaded = true;
  const trashRoot = path.join(supportRoot(), "deleted-projects");
  try {
    for (const entry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
      const tombstone = entry.name.match(/^([a-f0-9-]{24,64})\.deleted$/i);
      if (entry.isFile() && tombstone) permanentlyDeletedProjectIds.add(tombstone[1]);
      const match = entry.name.match(/^([a-f0-9-]{24,64})-\d{10,16}$/i);
      if (entry.isDirectory() && match) {
        permanentlyDeletedProjectIds.add(match[1]);
        removeProjectTrashInBackground(path.join(trashRoot, entry.name));
      }
    }
  } catch {}
  for (const root of projectRoots()) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, ".deleted")))
          permanentlyDeletedProjectIds.add(entry.name);
      }
    } catch {}
  }
}

function assertProjectWritable(id) {
  loadLegacyDeletedProjects();
  if (permanentlyDeletedProjectIds.has(id) || deletingProjectIds.has(id))
    throw new Error("工程正在删除或已删除，已阻止自动保存恢复。");
}

function projectHistoryDirectory(id) {
  return path.join(projectDirectory(id), "autosave-history");
}

function historyFiles(id) {
  const directory = projectHistoryDirectory(id);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^autosave-\d{13}\.json$/.test(name))
    .sort((a, b) => b.localeCompare(a));
}

function archivePreviousSnapshot(id, previous, force = false) {
  if (!previous?.id || previous.id !== id) return;
  const directory = projectHistoryDirectory(id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const newest = historyFiles(id)[0];
  const newestTime = Number((newest?.match(/\d{13}/) || [0])[0]);
  if (!force && newestTime && Date.now() - newestTime < HISTORY_INTERVAL_MS) return;
  const timestamp = Math.max(Date.now(), newestTime + 1);
  const destination = path.join(directory, `autosave-${timestamp}.json`);
  writeLargeJson(destination, previous);
  for (const stale of historyFiles(id).slice(HISTORY_LIMIT))
    fs.rmSync(path.join(directory, stale), { force: true });
}

export function createProject(input = {}) {
  const id = crypto.randomUUID();
  const workspaceMode = normalizeWorkspaceMode(input.workspaceMode);
  const now = new Date().toISOString();
  const ratio = input.ratio === "16:9" ? "16:9" : "9:16";
  const name = String(input.name || "未命名工程").trim().slice(0, 80) || "未命名工程";
  const project = {
    format: PROJECT_FORMAT,
    version: 1,
    id,
    workspaceMode,
    name,
    createdAt: now,
    updatedAt: now,
    data: {
      ...(input.data && typeof input.data === "object" ? input.data : {}),
      projectId: id,
      projectName: name,
      ratio,
      width: ratio === "16:9" ? 1920 : 1080,
      height: ratio === "16:9" ? 1080 : 1920,
    },
  };
  fs.mkdirSync(projectDirectory(id, workspaceMode), { recursive: true, mode: 0o700 });
  return saveProjectSnapshot({
    projectId: id,
    projectName: project.name,
    workspaceMode,
    data: project.data,
    createdAt: now,
  });
}

export function saveProjectSnapshot(input = {}) {
  notifyCacheActivity();
  const id = validateId(input.projectId || input.data?.projectId);
  assertProjectWritable(id);
  const directory = projectDirectory(id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let previous = {};
  try {
    previous = readLargeJson(projectFile(id));
  } catch(error) {
    if(error.code!=='ENOENT')throw new Error('现有工程无法完整读取，已停止保存以保护原文件：'+error.message);
  }
  const now = new Date().toISOString();
  const data = { ...(input.data || {}), projectId: id };
  const workspaceMode = normalizeWorkspaceMode(previous.workspaceMode || input.workspaceMode || (path.dirname(directory) === projectsRoot("splice") ? "splice" : "edit"));
  const firstVideo = [data.video, ...(data.videoLayers || [])].find(Boolean);
  const project = {
    ...previous,
    format: PROJECT_FORMAT,
    version: 1,
    id,
    workspaceMode,
    name:
      String(
        input.projectName ||
          input.data?.projectName ||
          previous.name ||
          "未命名工程",
      )
        .trim()
        .slice(0, 80) || "未命名工程",
    createdAt: previous.createdAt || input.createdAt || now,
    updatedAt: now,
    ratio: data.ratio === "16:9" ? "16:9" : "9:16",
    thumbnailPath:
      data.projectCoverPath && fs.existsSync(data.projectCoverPath)
        ? data.projectCoverPath
        : firstVideo?.previewPath || "",
    videoName: firstVideo?.name || "",
    data,
  };
  archivePreviousSnapshot(id, previous);
  const temporary = path.join(directory, `.project-${crypto.randomUUID()}.tmp`);
  writeLargeJson(temporary, project);
  fs.renameSync(temporary, projectFile(id));
  try { writeProjectMetadata(directory, project); } catch {}
  return project;
}

export function queryProjects(query = {}) {
  loadLegacyDeletedProjects();
  const excludeIds = [...new Set([...permanentlyDeletedProjectIds, ...deletingProjectIds])];
  const workspaceMode = String(query.workspaceMode || "all");
  const roots = workspaceMode === "all" ? projectRoots() : [projectsRoot(workspaceMode)];
  return queryProjectCatalog(roots, { ...query, excludeIds });
}

export function loadProject(id) {
  const file = projectFile(id);
  if (!fs.existsSync(file)) throw new Error("工程不存在或已经被删除。");
  return readLargeJson(file);
}

export function listProjectHistory(id) {
  validateId(id);
  return historyFiles(id).map((name) => {
    const file = path.join(projectHistoryDirectory(id), name);
    try {
      const value = readLargeJson(file);
      return {
        id: name,
        savedAt: value.updatedAt || new Date(Number(name.match(/\d{13}/)?.[0] || 0)).toISOString(),
        name: value.name || "未命名工程",
        duration: Number(value.data?.duration || 0),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function restoreProjectHistory(id, historyId) {
  validateId(id);
  const name = String(historyId || "");
  if (!/^autosave-\d{13}\.json$/.test(name)) throw new Error("自动保存版本无效。");
  const file = path.join(projectHistoryDirectory(id), name);
  if (!fs.existsSync(file)) throw new Error("自动保存版本不存在或已经清理。");
  const value = readLargeJson(file);
  // Older integrated builds used a different format label. Match the stable
  // project ID and payload shape so history remains restorable across the
  // branding migration, then save the current format on restore.
  if (value.id !== id || !value.data || typeof value.data !== "object") throw new Error("自动保存版本与当前工程不匹配。");
  archivePreviousSnapshot(id, loadProject(id), true);
  return saveProjectSnapshot({
    projectId: id,
    projectName: value.name,
    createdAt: value.createdAt,
    data: value.data || {},
  });
}

export function renameProject(id, requestedName) {
  const current = loadProject(id);
  const name = String(requestedName || "").trim().slice(0, 80);
  if (!name) throw new Error("工程名称不能为空。");
  return saveProjectSnapshot({
    projectId: current.id,
    projectName: name,
    createdAt: current.createdAt,
    data: { ...(current.data || {}), projectName: name },
  });
}

export function listProjects(workspaceMode = "all") {
  const roots = String(workspaceMode || "all") === "all" ? projectRoots() : [projectsRoot(workspaceMode)];
  return roots.flatMap(root => fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const directory = path.join(root, entry.name);
        if (projectFolderHidden(directory)) return [];
        const value = readLargeJson(path.join(directory, "project.json"));
        const sources = [value.data?.video?.originalPath, value.data?.video?.path].filter(Boolean);
        const sourceAvailable = !sources.length || sources.some((candidate) => fs.existsSync(candidate));
        const thumbnailPath =
          sourceAvailable && value.thumbnailPath && fs.existsSync(value.thumbnailPath)
            ? value.thumbnailPath
            : "";
        return [
          {
            id: value.id,
            name: value.name,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
            ratio: value.data?.ratio || "9:16",
            duration: Number(value.data?.duration || 0),
            videoName: value.videoName || value.data?.video?.name || "",
            thumbnailPath,
          },
        ];
      } catch {
        return [];
      }
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function projectFolderHidden(directory) {
  loadLegacyDeletedProjects();
  return (
    permanentlyDeletedProjectIds.has(path.basename(directory)) ||
    deletingProjectIds.has(path.basename(directory)) ||
    fs.existsSync(path.join(directory, ".deleted")) ||
    !fs.existsSync(path.join(directory, "project.json"))
  );
}

function removeProjectTrashInBackground(directory) {
  if (projectTrashCleanupJobs.has(directory)) return;
  projectTrashCleanupJobs.add(directory);
  const match = path.basename(directory).match(/^([a-f0-9-]{24,64})-\d{10,16}$/i);
  if (!match) {
    projectTrashCleanupJobs.delete(directory);
    return;
  }
  const worker = new Worker(new URL("./project-trash-cleaner.mjs", import.meta.url), {
    workerData: { projectId: match[1], directory, root: supportRoot() },
    execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")),
  });
  worker.on("error", () => {});
  worker.on("exit", () => projectTrashCleanupJobs.delete(directory));
  worker.unref();
}

export async function deleteProject(id, options = {}) {
  notifyCacheActivity();
  id = validateId(id);
  const source = projectDirectory(id);
  if (!fs.existsSync(source)) {
    loadLegacyDeletedProjects();
    return permanentlyDeletedProjectIds.has(id)
      ? { deleted: true, alreadyDeleted: true, cacheFilesRemoved: 0, cacheCleanupFailures: 0 }
      : false;
  }
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error("不能删除链接工程目录");
  if (options.updatedAt && loadProject(id).updatedAt !== options.updatedAt)
    throw new Error("工程已更新，已跳过删除，请刷新后重新选择");

  deletingProjectIds.add(id);
  let deletionStarted = false;
  let tombstonePath = "";
  let tombstoneTemp = "";
  try {
    const deletionIndex = path.join(supportRoot(), "deleted-projects");
    await fs.promises.mkdir(deletionIndex, { recursive: true, mode: 0o700 });
    const indexStat = await fs.promises.lstat(deletionIndex);
    if (!indexStat.isDirectory() || indexStat.isSymbolicLink())
      throw new Error("工程删除索引目录无效，已停止删除。");
    if (options.updatedAt && loadProject(id).updatedAt !== options.updatedAt)
      throw new Error("工程已更新，已跳过删除，请刷新后重新选择");
    if ((await fs.promises.lstat(source)).isSymbolicLink())
      throw new Error("不能删除链接工程目录");
    const trashDirectory = path.join(deletionIndex, `${id}-${Date.now()}`);
    tombstonePath = path.join(deletionIndex, `${id}.deleted`);
    tombstoneTemp = `${tombstonePath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(tombstoneTemp, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
    try {
      // Both paths live under supportRoot, so this rename is a quick same-volume
      // operation. Recursive removal can then run without blocking the UI.
      await fs.promises.rename(source, trashDirectory);
      permanentlyDeletedProjectIds.add(id);
      deletionStarted = true;
      try {
        await fs.promises.rename(tombstoneTemp, tombstonePath);
        tombstoneTemp = "";
      } catch {
        // The timestamped trash directory also marks the project as deleted.
      }
      removeProjectTrashInBackground(trashDirectory);
      notifyCacheActivity();
      return { deleted: true, cleanupPending: true, cacheFilesRemoved: 0, cacheCleanupFailures: 0 };
    } catch (error) {
      await fs.promises.rm(tombstonePath, { force: true }).catch(() => {});
      tombstonePath = "";
      if (!fs.existsSync(source)) {
        permanentlyDeletedProjectIds.add(id);
        deletionStarted = true;
      }
      throw new Error("工程永久删除失败：" + error.message);
    }
  } finally {
    deletingProjectIds.delete(id);
    if (tombstoneTemp) await fs.promises.rm(tombstoneTemp, { force: true }).catch(() => {});
    if (!deletionStarted && !fs.existsSync(path.join(source, "project.json")))
      permanentlyDeletedProjectIds.add(id);
  }
}

export function resetProject(id) {
  const current = loadProject(id);
  const directory = projectDirectory(id);
  const media = path.join(directory, "media");
  if (fs.existsSync(media)) {
    const history = path.join(directory, "reset-history");
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    fs.renameSync(media, path.join(history, String(Date.now())));
  }
  fs.mkdirSync(media, { recursive: true, mode: 0o700 });
  return saveProjectSnapshot({
    projectId: id,
    projectName: current.name,
    data: {
      projectId: id,
      projectName: current.name,
      ratio: current.data?.ratio === "16:9" ? "16:9" : "9:16",
      width: current.data?.ratio === "16:9" ? 1920 : 1080,
      height: current.data?.ratio === "16:9" ? 1080 : 1920,
    },
  });
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function clearProjectCache(id) {
  const current = loadProject(id);
  const directory = projectDirectory(id);
  const media = path.join(directory, "media");
  const protectedSources=new Set();
  const identity=file=>{try{return fs.realpathSync(file).toLowerCase();}catch{return path.resolve(file).toLowerCase();}};
  const collectSources=value=>{
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      if(['path','sourcePath','originalPath','fontFile'].includes(key)&&typeof child==='string'&&child)protectedSources.add(identity(child));
      else if(child&&typeof child==='object')collectSources(child);
    }
  };
  collectSources(current.data);
  const cacheFiles = new Set([
    current.thumbnailPath,
    current.data?.projectCoverPath,
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.previewPath === "string") cacheFiles.add(value.previewPath);
    for (const child of Object.values(value)) visit(child);
  };
  visit(current.data);
  let removed = 0;
  for (const file of cacheFiles) {
    if (!file || !fs.existsSync(file)) continue;
    const allowed = inside(directory, file) || inside(path.join(supportRoot(), "previews"), file);
    if (!allowed || protectedSources.has(identity(file))) continue;
    let linked=false;
    for(let parent=path.resolve(file);;parent=path.dirname(parent)){
      if(fs.lstatSync(parent).isSymbolicLink()){linked=true;break;}
      if(path.dirname(parent)===parent)break;
    }
    if(linked || !fs.lstatSync(file).isFile())continue;
    fs.rmSync(file, { force: true });
    removed += 1;
  }
  // Legacy media may be the only surviving source. Cache cleanup must never
  // remove it; deletion is allowed only after an explicit successful relink.
  const stripCache = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map(stripCache).filter(Boolean);
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
      if (["previewPath", "previewUrl", "projectCoverPath"].includes(key)) continue;
      copy[key] = stripCache(child);
    }
    return copy;
  };
  const data = stripCache(current.data) || {};
  saveProjectSnapshot({ projectId: id, projectName: current.name, data });
  return { removed, project: loadProject(id) };
}

export function stageProjectAsset(projectId, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath))
    throw new Error("素材文件已经不存在。");
  const directory = path.join(projectDirectory(projectId), "media");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const extension = path.extname(sourcePath).slice(0, 12);
  const base =
    path
      .basename(sourcePath, extension)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .slice(0, 72) || "asset";
  const destination = path.join(
    directory,
    `${base}-${crypto.randomUUID().slice(0, 8)}${extension}`,
  );
  fs.copyFileSync(sourcePath, destination);
  return destination;
}

export async function stageProjectAssetAsync(projectId, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath))
    throw new Error("素材文件已经不存在。");
  const directory = path.join(projectDirectory(projectId), "media");
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const resolvedSource = path.resolve(sourcePath);
  if (path.dirname(resolvedSource) === path.resolve(directory))
    return resolvedSource;
  const extension = path.extname(sourcePath).slice(0, 12);
  const base =
    path
      .basename(sourcePath, extension)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .slice(0, 72) || "asset";
  const destination = path.join(
    directory,
    `${base}-${crypto.randomUUID().slice(0, 8)}${extension}`,
  );
  try {
    await fs.promises.link(resolvedSource, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "EMLINK", "EEXIST", "ENOENT"].includes(error?.code))
      throw error;
    if (!fs.existsSync(resolvedSource))
      throw new Error("处理后的素材文件尚未生成或已被清理，请重试。");
    try {
      await fs.promises.copyFile(
        resolvedSource,
        destination,
        fs.constants.COPYFILE_FICLONE,
      );
    } catch {
      await fs.promises.copyFile(resolvedSource, destination);
    }
  }
  return destination;
}

export const stageMedia = stageProjectAsset;
export const projectStoragePath = projectDirectory;
export const appSupportRoot = supportRoot;

function archiveEntriesSafe(archive) {
  for (const entry of archiveEntries(archive)) {
    const normalized = String(entry || "").replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.split("/").includes(".."))
      throw new Error("备份包路径不安全，已停止恢复。");
  }
}

export function exportBackup(destination) {
  if (!destination) return null;
  const items = ["projects", "splice-projects", "fonts", "caption-presets.json"].filter((name) =>
    fs.existsSync(path.join(supportRoot(), name)),
  );
  if (!items.length) throw new Error("目前没有可备份的工程。");
  return createArchive(destination, items, supportRoot());
}

export function importBackup(archive) {
  if (!archive || !fs.existsSync(archive)) return null;
  loadLegacyDeletedProjects();
  archiveEntriesSafe(archive);
  const destination = path.join(
    supportRoot(),
    `restore-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  extractArchive(archive, destination);
  const incomingFonts = path.join(destination, "fonts");
  if (fs.existsSync(incomingFonts))
    fs.cpSync(incomingFonts, path.join(supportRoot(), "fonts"), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  let count = 0;
  for (const incomingName of ["projects", "splice-projects"]) {
    const incoming = path.join(destination, incomingName);
    if (!fs.existsSync(incoming)) continue;
    const defaultMode = incomingName === "splice-projects" ? "splice" : "edit";
    for (const entry of fs
      .readdirSync(incoming, { withFileTypes: true })
      .filter((item) => item.isDirectory())) {
      const source = path.join(incoming, entry.name);
      const file = path.join(source, "project.json");
      if (!fs.existsSync(file)) continue;
      const value = readLargeJson(file);
      const workspaceMode = normalizeWorkspaceMode(value.workspaceMode || defaultMode);
      let id = value.id;
      if (
        !/^[a-f0-9-]{24,64}$/i.test(String(id || "")) ||
        permanentlyDeletedProjectIds.has(id) ||
        fs.existsSync(projectDirectory(id))
      ) {
        id = crypto.randomUUID();
        value.id = id;
        value.name = `${value.name || "恢复工程"}（恢复）`;
        value.data = {
          ...(value.data || {}),
          projectId: id,
          projectName: value.name,
        };
        writeLargeJson(file, value);
      }
      const restoredDirectory = projectDirectory(id, workspaceMode);
      fs.cpSync(source, restoredDirectory, { recursive: true });
      const restoredFile = path.join(restoredDirectory, "project.json");
      const restored = readLargeJson(restoredFile);
      const restoredMedia = path.join(restoredDirectory, "media");
      const restoredFonts = path.join(supportRoot(), "fonts");
      const rebase = (input, key = "") => {
        if (Array.isArray(input)) return input.map((item) => rebase(item));
        if (!input || typeof input !== "object") {
          if (typeof input !== "string") return input;
          if (["url", "previewUrl"].includes(key)) return "";
          if (key === "previewPath") return "";
          if (!["path", "fontFile", "sourcePath"].includes(key)) return input;
          const mediaCandidate = path.join(restoredMedia, path.basename(input));
          if (fs.existsSync(mediaCandidate)) return mediaCandidate;
          const fontCandidate = path.join(restoredFonts, path.basename(input));
          if (fs.existsSync(fontCandidate)) return fontCandidate;
          return fs.existsSync(input) ? input : "";
        }
        return Object.fromEntries(
          Object.entries(input).map(([childKey, childValue]) => [
            childKey,
            rebase(childValue, childKey),
          ]),
        );
      };
      restored.id = id;
      restored.workspaceMode = workspaceMode;
      restored.thumbnailPath = "";
      restored.data = rebase({
        ...(restored.data || {}),
        projectId: id,
        projectName: restored.name,
      });
      writeLargeJson(restoredFile, restored);
      count += 1;
    }
  }
  for (const name of ["fonts", "caption-presets.json"]) {
    const source = path.join(destination, name);
    if (fs.existsSync(source))
      fs.cpSync(source, path.join(supportRoot(), name), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
  }
  fs.rmSync(destination, { recursive: true, force: true });
  return { restored: count };
}
