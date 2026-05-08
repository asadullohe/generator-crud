import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_TEMPLATE_SOURCE = "src/modules/fhdy/branch";
export const DEFAULT_TEMPLATE_NAME = "standard";
export const ACTIVE_TEMPLATE_ROOT = "_templates/crud-module";
export const ACTIVE_TEMPLATE_ACTION_ROOT = path.join(ACTIVE_TEMPLATE_ROOT, "new");
export const ACTIVE_TEMPLATE_MANIFEST = path.join(ACTIVE_TEMPLATE_ROOT, "manifest.json");
export const TEMPLATE_STORE_ROOT = "_templates/crud-module-store";
export const TEMPLATE_CURRENT_REF = path.join(TEMPLATE_STORE_ROOT, "current.json");

export function getStoredTemplateRoot(templateName) {
  return path.join(TEMPLATE_STORE_ROOT, templateName);
}

export function getStoredTemplateActionRoot(templateName) {
  return path.join(getStoredTemplateRoot(templateName), "new");
}

export function getStoredTemplateManifest(templateName) {
  return path.join(getStoredTemplateRoot(templateName), "manifest.json");
}

export function packagePath(...parts) {
  return path.join(PACKAGE_ROOT, ...parts);
}

export const STANDARD_TEMPLATE_FILES = [
  "api.ts",
  "constants.ts",
  "types.ts",
  "mappers.ts",
  "validation.ts",
  "index.ts",
  "forms/index.ts",
  "forms/CreateForm.tsx",
  "forms/UpdateForm.tsx",
  "hooks/index.ts",
  "hooks/useList.ts",
  "hooks/useSingle.ts",
  "hooks/useDelete.ts",
  "hooks/useInfiniteList.ts",
];

export const CRUD_KINDS = ["list", "single", "create", "update", "delete"];

export const AUTH_MODES = {
  NONE: "none",
  BASIC: "basic",
  BEARER: "bearer",
  LOGIN: "login",
};
