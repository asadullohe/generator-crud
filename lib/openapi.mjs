import fs from "node:fs/promises";
import { pathExists } from "./fs-utils.mjs";
import { AUTH_MODES } from "./constants.mjs";
import { toCamelCase, toPascalCase } from "./naming.mjs";
import { extractRequestSchema, getSchemaFields } from "./schema.mjs";

export async function loadConfigServices(configPath) {
  const content = await fs.readFile(configPath, "utf8");
  const servicesBlock = content.match(/services:\s*\{([\s\S]*?)\n\s*\},/);

  if (!servicesBlock) {
    return {};
  }

  return Object.fromEntries(
    [...servicesBlock[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
  );
}

export async function loadOpenApiDocument(source, auth = { mode: AUTH_MODES.NONE }) {
  if (await pathExists(source)) {
    const raw = await fs.readFile(source, "utf8");
    return parseOpenApi(raw, source);
  }

  const headers = await buildAuthHeaders(auth);
  const response = await fetch(source, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`Swagger yuklanmadi: ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (looksLikeHtml(raw, contentType)) {
    return loadSwaggerUiDocument(source, headers, raw);
  }

  return parseOpenApi(raw, source);
}

export function parseOpenApi(raw, sourceLabel = "Swagger") {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `${sourceLabel} OpenAPI JSON bo'lishi kerak yoki Swagger UI page bo'lishi kerak.`,
    );
  }
}

function looksLikeHtml(raw, contentType = "") {
  return contentType.includes("text/html") || /^\s*<!doctype html/i.test(raw) || /^\s*<html/i.test(raw);
}

async function loadSwaggerUiDocument(source, headers, html = "") {
  const attempts = [];
  const inlineConfig = extractSwaggerUiInlineConfig(html);

  if (inlineConfig) {
    attempts.push(inlineConfig);
  }

  try {
    const config = await loadSwaggerUiConfig(source, headers);
    attempts.push(config);
  } catch (error) {
    if (inlineConfig == null) {
      console.warn(`Swagger config fetch ishlamadi, fallback ishlatiladi: ${error.message}`);
    }
  }

  for (const config of attempts) {
    const specUrl = resolveSpecUrlFromConfig(source, config);
    if (!specUrl) {
      continue;
    }

    const doc = await tryLoadSpec(specUrl, headers);
    if (doc) {
      return doc;
    }
  }

  for (const specUrl of buildCommonSpecCandidates(source)) {
    const doc = await tryLoadSpec(specUrl, headers);
    if (doc) {
      return doc;
    }
  }

  throw new Error(
    "Swagger UI sahifasidan OpenAPI spec topilmadi. To'g'ridan-to'g'ri api-docs yoki swagger.json URL bering.",
  );
}

async function loadSwaggerUiConfig(source, headers) {
  const url = new URL(source);
  const configUrl = new URL("./swagger-config", url);

  const response = await fetch(configUrl, { headers });
  if (!response.ok) {
    throw new Error(`Swagger config yuklanmadi: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function resolveSpecUrlFromConfig(source, config) {
  const pageUrl = new URL(source);
  const primaryName = pageUrl.searchParams.get("urls.primaryName");
  const urls = Array.isArray(config?.urls) ? config.urls : [];

  const selected =
    (primaryName && urls.find((item) => item.name === primaryName)) ||
    urls[0] ||
    (config?.url ? { url: config.url } : undefined);

  if (!selected?.url) {
    return undefined;
  }

  return new URL(selected.url, pageUrl.origin).toString();
}

function extractSwaggerUiInlineConfig(html) {
  if (!html) {
    return undefined;
  }

  const urlMatch = html.match(/(?:["'])url(?:["'])\s*:\s*(?:["'])([^"']+)(?:["'])/);
  const configUrlMatch = html.match(/(?:["'])configUrl(?:["'])\s*:\s*(?:["'])([^"']+)(?:["'])/);
  const urlsBlockMatch = html.match(/(?:["'])urls(?:["'])\s*:\s*(\[[\s\S]*?\])/);

  let urls;
  if (urlsBlockMatch?.[1]) {
    try {
      urls = JSON.parse(urlsBlockMatch[1].replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"'));
    } catch {
      urls = undefined;
    }
  }

  if (!urlMatch?.[1] && !configUrlMatch?.[1] && !urls) {
    return undefined;
  }

  return {
    ...(urlMatch?.[1] ? { url: urlMatch[1] } : {}),
    ...(configUrlMatch?.[1] ? { configUrl: configUrlMatch[1] } : {}),
    ...(urls ? { urls } : {}),
  };
}

function buildCommonSpecCandidates(source) {
  const pageUrl = new URL(source);
  const baseCandidates = [
    "./v3/api-docs",
    "../v3/api-docs",
    "/v3/api-docs",
    "./api-docs",
    "../api-docs",
    "/api-docs",
    "./swagger.json",
    "../swagger.json",
    "/swagger.json",
  ];

  return [...new Set(baseCandidates.map((candidate) => new URL(candidate, pageUrl).toString()))];
}

async function tryLoadSpec(specUrl, headers) {
  const response = await fetch(specUrl, { headers });

  if (!response.ok) {
    return undefined;
  }

  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (looksLikeHtml(raw, contentType)) {
    return undefined;
  }

  try {
    return parseOpenApi(raw, specUrl);
  } catch {
    return undefined;
  }
}

export async function buildAuthHeaders(auth) {
  switch (auth.mode) {
    case AUTH_MODES.BASIC: {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      return {
        Authorization: `Basic ${encoded}`,
      };
    }
    case AUTH_MODES.BEARER:
      return {
        Authorization: `Bearer ${auth.token}`,
      };
    case AUTH_MODES.LOGIN: {
      const token = await loginAndGetToken(auth);
      return {
        Authorization: `Bearer ${token}`,
      };
    }
    default:
      return {};
  }
}

async function loginAndGetToken(auth) {
  const body = {
    [auth.loginField]: auth.username,
    [auth.passwordField]: auth.password,
  };

  const response = await fetch(auth.authUrl, {
    method: auth.authMethod || "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Auth request muvaffaqiyatsiz: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const token = auth.tokenPath
    .split(".")
    .reduce((accumulator, key) => accumulator?.[key], data);

  if (!token || typeof token !== "string") {
    throw new Error("Token response path bo'yicha access token topilmadi");
  }

  return token;
}

export function getServers(doc, fallbackUrl) {
  const servers = doc?.servers?.length ? doc.servers : [{ url: fallbackUrl, description: "Swagger URL" }];

  return servers.map((server, index) => ({
    value: server.url,
    label: server.description ? `${server.description} (${server.url})` : server.url,
    index,
  }));
}

export function getTags(doc) {
  const counters = new Map();

  for (const [, pathItem] of Object.entries(doc.paths || {})) {
    for (const operation of Object.values(pathItem || {})) {
      for (const tag of operation?.tags || []) {
        counters.set(tag, (counters.get(tag) || 0) + 1);
      }
    }
  }

  return [...counters.entries()]
    .map(([value, count]) => ({
      value,
      label: `${value} (${count} ta operation)`,
      count,
    }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export function getOperationsByTag(doc, tag) {
  const operations = [];

  for (const [path, pathItem] of Object.entries(doc.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!operation?.tags?.includes(tag)) {
        continue;
      }

      operations.push({
        method: method.toLowerCase(),
        path,
        operationId: operation.operationId || "",
        summary: operation.summary || operation.description || "",
        operation,
      });
    }
  }

  return operations;
}

function hasPathParam(path) {
  return /\{[^}]+\}/.test(path);
}

function scoreListCandidate(operation) {
  let score = 0;
  if (operation.path.includes("pageable")) score += 100;
  if (operation.path.includes("search")) score += 50;
  if (operation.method === "get") score += 40;
  if (operation.method === "post") score += 30;
  if (!hasPathParam(operation.path)) score += 20;
  return score;
}

function scoreCreateCandidate(operation) {
  let score = 0;
  if (operation.method === "post") score += 100;
  if (!operation.path.includes("pageable")) score += 20;
  if (!hasPathParam(operation.path)) score += 10;
  return score;
}

function scoreUpdateCandidate(operation) {
  let score = 0;
  if (operation.method === "put") score += 100;
  if (operation.method === "patch") score += 90;
  if (operation.method === "post") score += 70;
  if (!operation.path.includes("pageable")) score += 10;
  return score;
}

function scoreSingleCandidate(operation) {
  return operation.method === "get" && hasPathParam(operation.path) ? 100 : 0;
}

function scoreDeleteCandidate(operation) {
  return operation.method === "delete" && hasPathParam(operation.path) ? 100 : 0;
}

export function resolveCrudCandidates(operations) {
  const pageableCandidates = operations.filter(
    (operation) =>
      ["get", "post"].includes(operation.method) &&
      !hasPathParam(operation.path) &&
      /(pageable|search)/.test(operation.path),
  );

  const list = (pageableCandidates.length
    ? pageableCandidates
    : operations.filter(
        (operation) =>
          ["get", "post"].includes(operation.method) &&
          !hasPathParam(operation.path) &&
          !/(upload|sync)/.test(operation.path),
      )
  ).sort((left, right) => scoreListCandidate(right) - scoreListCandidate(left));

  const create = operations
    .filter(
      (operation) =>
        operation.method === "post" &&
        !hasPathParam(operation.path) &&
        !/(pageable|search|upload|sync)/.test(operation.path),
    )
    .sort((left, right) => scoreCreateCandidate(right) - scoreCreateCandidate(left));

  const update = operations
    .filter(
      (operation) =>
        ((["put", "patch"].includes(operation.method) && !/(sync|upload)/.test(operation.path)) ||
          (operation.method === "post" &&
            !hasPathParam(operation.path) &&
            !/(pageable|search|sync|upload)/.test(operation.path))),
    )
    .sort((left, right) => scoreUpdateCandidate(right) - scoreUpdateCandidate(left));

  const single = operations
    .filter((operation) => operation.method === "get" && hasPathParam(operation.path))
    .sort((left, right) => scoreSingleCandidate(right) - scoreSingleCandidate(left));

  const deleteCandidates = operations
    .filter((operation) => operation.method === "delete" && hasPathParam(operation.path))
    .sort((left, right) => scoreDeleteCandidate(right) - scoreDeleteCandidate(left));

  return {
    list,
    single,
    create,
    update,
    delete: deleteCandidates,
  };
}

export function describeOperation(operation) {
  const title = operation.summary ? `${operation.summary} ` : "";
  return `${title}[${operation.method.toUpperCase()}] ${operation.path}`;
}

export function detectServiceKey(serverUrl, services) {
  const matches = Object.entries(services).filter(([, value]) => serverUrl.includes(value));

  if (matches.length === 1) {
    return matches[0][0];
  }

  return undefined;
}

function isSyncOperation(operation) {
  const text = `${operation.path} ${operation.operationId} ${operation.summary}`.toLowerCase();
  return /\bsync\b/.test(text) || text.includes("/sync");
}

function isUploadOperation(operation, doc) {
  const text = `${operation.path} ${operation.operationId} ${operation.summary}`.toLowerCase();
  if (text.includes("upload")) {
    return true;
  }

  const requestSchema = extractRequestSchema(operation.operation, doc);
  const fields = getSchemaFields(requestSchema, doc);
  return fields.some(
    (field) =>
      field.schema?.format === "binary" ||
      field.schema?.format === "base64" ||
      field.name.toLowerCase().includes("file"),
  );
}

function buildMutationBaseName(operation, kind) {
  const segments = operation.path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.includes("{"))
    .filter((segment) => !/^v\d+$/i.test(segment))
    .filter((segment) => segment !== "control");

  if (kind === "upload") {
    const uploadIndex = segments.lastIndexOf("upload");
    const tail = uploadIndex >= 0 ? segments.slice(uploadIndex + 1).join(" ") : segments.at(-1) || "";
    return `upload${tail ? toPascalCase(tail) : ""}`;
  }

  const syncIndex = segments.lastIndexOf("sync");
  const tail = syncIndex >= 0 ? segments.slice(syncIndex + 1).join(" ") : "";
  return `sync${tail ? toPascalCase(tail) : ""}`;
}

export function detectExtraMutations(operations, resolvedOperations, doc) {
  const selected = new Set(Object.values(resolvedOperations).filter(Boolean));
  const extras = [];
  const usedNames = new Set();

  for (const operation of operations) {
    if (selected.has(operation)) {
      continue;
    }

    const kind = isUploadOperation(operation, doc) ? "upload" : isSyncOperation(operation) ? "sync" : null;
    if (!kind) {
      continue;
    }

    const requestSchema = extractRequestSchema(operation.operation, doc);
    const requestFields = getSchemaFields(requestSchema, doc);
    const binaryField = requestFields.find(
      (field) =>
        field.schema?.format === "binary" ||
        field.schema?.format === "base64" ||
        field.name.toLowerCase().includes("file"),
    );

    let apiMethodName = toCamelCase(buildMutationBaseName(operation, kind));
    if (!apiMethodName) {
      apiMethodName = kind;
    }

    let dedupedMethodName = apiMethodName;
    let counter = 1;
    while (usedNames.has(dedupedMethodName)) {
      counter += 1;
      dedupedMethodName = `${apiMethodName}${counter}`;
    }
    usedNames.add(dedupedMethodName);

    extras.push({
      kind,
      operation,
      apiMethodName: dedupedMethodName,
      hookName: `use${toPascalCase(dedupedMethodName)}`,
      fileFieldName: binaryField?.name || "file",
      hasPayload: requestFields.length > 0,
    });
  }

  return extras;
}
