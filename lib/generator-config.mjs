import { pathToFileURL } from "node:url";
import { AUTH_MODES } from "./constants.mjs";
import { pathExists, projectPath, readFile } from "./fs-utils.mjs";

const DEFAULT_CONFIG_FILES = [
  "generate-crud.config.mjs",
  "generate-crud.config.js",
  "generate-crud.config.json",
];

export async function loadGeneratorConfig() {
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

  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }

  throw new Error(`${label} configda yoki ${envKey || "env"} orqali berilishi kerak`);
}
