import fs from "node:fs/promises";
import path from "node:path";

export function projectPath(...parts) {
  return path.resolve(process.cwd(), ...parts);
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function emptyDir(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
  await ensureDir(targetPath);
}

export async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function copyDir(sourcePath, targetPath) {
  await ensureDir(targetPath);
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      await copyDir(sourceEntryPath, targetEntryPath);
      continue;
    }

    await ensureDir(path.dirname(targetEntryPath));
    await fs.copyFile(sourceEntryPath, targetEntryPath);
  }
}

export async function listDirs(targetPath) {
  if (!(await pathExists(targetPath))) {
    return [];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function writeFile(targetPath, content) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, normalizeTrailingNewline(content), "utf8");
}

export async function readFile(targetPath) {
  return fs.readFile(targetPath, "utf8");
}

export function normalizeTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`;
}
