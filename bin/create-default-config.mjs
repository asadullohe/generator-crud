#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.resolve(process.env.INIT_CWD || process.cwd());
const configPath = path.join(targetRoot, "generate-crud.config.json");

const defaultConfig = {
  swaggerUrl: "https://example.com/service/swagger-ui/index.html",
  auth: {
    mode: "basic",
    usernameEnv: "SWAGGER_USERNAME",
    passwordEnv: "SWAGGER_PASSWORD",
  },
};

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.GENERATOR_CRUD_SKIP_CONFIG === "1") {
    return;
  }

  if (targetRoot === packageRoot || targetRoot.includes(`${path.sep}node_modules${path.sep}`)) {
    return;
  }

  if (await pathExists(configPath)) {
    return;
  }

  await fs.writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  console.log(`generator-crud: created ${path.relative(targetRoot, configPath)}`);
}

await main().catch((error) => {
  console.warn(`generator-crud: config yaratilmadi: ${error.message}`);
});
