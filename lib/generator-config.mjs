import { pathToFileURL } from "node:url";
import { AUTH_MODES } from "./constants.mjs";
import { DEFAULT_GENERATOR_CONFIG } from "./default-config.mjs";
import { pathExists, projectPath, readFile, writeFile } from "./fs-utils.mjs";

const DEFAULT_CONFIG_FILES = [
  "generate-crud.config.mjs",
  "generate-crud.config.js",
  "generate-crud.config.json",
];

const DEFAULT_ENV_FILES = [".env", ".env.local"];
let envLoaded = false;

export async function loadGeneratorConfig() {
  await loadGeneratorEnvFiles();

  const cliConfigPath = process.argv.find((arg) => arg.startsWith("--config="))?.split("=")[1];
  const candidates = cliConfigPath ? [cliConfigPath] : DEFAULT_CONFIG_FILES;

  for (const candidate of candidates) {
    const absolutePath = projectPath(candidate);
    if (!(await pathExists(absolutePath))) {
      continue;
    }

    const config = await readConfigFile(absolutePath);
    return {
      ...config,
      configPath: absolutePath,
    };
  }

  return {};
}

export async function loadGeneratorEnvFiles() {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  for (const envFile of DEFAULT_ENV_FILES) {
    const envPath = projectPath(envFile);
    if (!(await pathExists(envPath))) {
      continue;
    }

    loadEnvContent(await readFile(envPath));
  }
}

export async function ensureGeneratorConfigFile() {
  const configPath = projectPath("generate-crud.config.json");

  if (await pathExists(configPath)) {
    return false;
  }

  await writeFile(configPath, JSON.stringify(DEFAULT_GENERATOR_CONFIG, null, 2));
  return true;
}

async function readConfigFile(configPath) {
  if (configPath.endsWith(".json")) {
    return JSON.parse(await readFile(configPath));
  }

  const module = await import(pathToFileURL(configPath).href);
  return module.default || module;
}

export function resolveAuthConfig(auth = null) {
  if (!auth) {
    return null;
  }

  const mode = auth.mode || AUTH_MODES.NONE;

  if (mode === AUTH_MODES.NONE) {
    return { mode };
  }

  if (mode === AUTH_MODES.BASIC) {
    return {
      mode,
      username: resolveConfigValue(auth.username, auth.usernameEnv, "auth.username"),
      password: resolveConfigValue(auth.password, auth.passwordEnv, "auth.password"),
    };
  }

  if (mode === AUTH_MODES.BEARER) {
    return {
      mode,
      token: resolveConfigValue(auth.token, auth.tokenEnv, "auth.token"),
    };
  }

  if (mode === AUTH_MODES.LOGIN) {
    return {
      mode,
      username: resolveConfigValue(auth.username, auth.usernameEnv, "auth.username"),
      password: resolveConfigValue(auth.password, auth.passwordEnv, "auth.password"),
      authUrl: resolveConfigValue(auth.authUrl, auth.authUrlEnv, "auth.authUrl"),
      authMethod: auth.authMethod || "POST",
      loginField: auth.loginField || "username",
      passwordField: auth.passwordField || "password",
      tokenPath: auth.tokenPath || "accessToken",
    };
  }

  throw new Error(`Noma'lum auth mode: ${mode}`);
}

function resolveConfigValue(value, envKey, label) {
  if (value) {
    return value;
  }

  if (envKey) {
    const envValue = process.env[envKey];
    if (envValue) {
      return envValue;
    }

    throw new Error(`${label} uchun ${envKey} env qiymati bo'sh yoki topilmadi`);
  }

  throw new Error(`${label} configda berilishi kerak`);
}

function loadEnvContent(content) {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = normalizeEnvValue(rawValue);
  }
}

function normalizeEnvValue(rawValue) {
  const value = rawValue.trim();
  const quote = value[0];

  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trim();
}
