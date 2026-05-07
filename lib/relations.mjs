import fs from "node:fs/promises";
import path from "node:path";
import { projectPath, readFile } from "./fs-utils.mjs";
import { singularize, splitWords, toCamelCase, toSnakeCase } from "./naming.mjs";

export const RELATION_REGISTRY = [
  {
    key: "bank",
    label: "Bank katalogi",
    aliases: ["bank", "bank_id", "bank_ids", "banks"],
    modulePath: "@/modules/globalSettings/billing/bankCatalog/mappers.ts",
    mapperName: "BankCatalogMapper",
  },
  {
    key: "merchant",
    label: "Merchant",
    aliases: ["merchant", "merchant_id", "merchant_ids", "merchants"],
    modulePath: "@/modules/globalSettings/billing/merchant/mappers.ts",
    mapperName: "MerchantMapper",
  },
  {
    key: "paymentChannel",
    label: "To'lov kanali",
    aliases: [
      "payment_channel",
      "payment_channel_id",
      "payment_channel_ids",
      "payment_channels",
    ],
    modulePath: "@/modules/globalSettings/billing/paymentChannel/mappers.ts",
    mapperName: "PaymentChannelMapper",
  },
  {
    key: "participant",
    label: "Participant",
    aliases: ["participant", "participant_id", "participant_ids", "user", "user_id", "user_ids"],
    modulePath: "@/modules/participant/mappers.ts",
    mapperName: "Participant",
  },
  {
    key: "organization",
    label: "Tashkilot",
    aliases: ["organization", "organization_id", "organization_ids", "organizations"],
    modulePath: "@/modules/organization/organization/mappers.ts",
    mapperName: "Organization",
  },
];

let discoveredRelationsPromise;

function normalizeRelationName(value = "") {
  let normalized = String(value).trim();

  if (normalized.endsWith("_ids")) {
    normalized = normalized.slice(0, -4);
  } else if (normalized.endsWith("_id")) {
    normalized = normalized.slice(0, -3);
  }

  return toCamelCase(singularize(normalized));
}

function normalizeAlias(value = "") {
  return normalizeRelationName(toSnakeCase(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasIdentityShape(schema) {
  if (!schema?.properties) {
    return false;
  }

  const keys = Object.keys(schema.properties);
  return (
    keys.includes("id") &&
    (keys.includes("name") ||
      keys.includes("full_name") ||
      keys.includes("code") ||
      keys.includes("title"))
  );
}

export function getRelationKind(field) {
  if (field.schema?.type === "object") {
    return "object";
  }

  if (field.schema?.type === "array" && field.schema?.items?.type === "object") {
    return "array";
  }

  return null;
}

function hasSiblingIdField(field, fields = []) {
  const normalizedFieldName = normalizeRelationName(field.name);
  const siblingIdName = `${toSnakeCase(normalizedFieldName)}_id`;
  const siblingIdsName = `${toSnakeCase(normalizedFieldName)}_ids`;

  return fields.some(
    (candidate) => candidate.name === siblingIdName || candidate.name === siblingIdsName,
  );
}

export function isRelationLikeField(field, fields = []) {
  const relationKind = getRelationKind(field);

  if (!relationKind || field.isMultiName) {
    return false;
  }

  const identityShape =
    relationKind === "array" ? hasIdentityShape(field.schema?.items) : hasIdentityShape(field.schema);

  return hasSiblingIdField(field, fields) || identityShape;
}

function scoreRelationCandidate(entry, field, fields = []) {
  const relationKind = getRelationKind(field);
  const normalizedFieldName = normalizeRelationName(field.name);
  const identityShape =
    relationKind === "array" ? hasIdentityShape(field.schema?.items) : hasIdentityShape(field.schema);
  let score = 80;

  if (entry.key === normalizedFieldName) {
    score += 10;
  }

  if (hasSiblingIdField(field, fields)) {
    score += 10;
  }

  if (identityShape) {
    score += 5;
  }

  return {
    ...entry,
    fieldName: field.name,
    relationKind,
    confidence: score >= 90 ? "high" : score >= 80 ? "medium" : "low",
    score,
  };
}

export function inferRelationCandidates(field, fields = []) {
  const relationKind = getRelationKind(field);
  if (!relationKind || field.isMultiName) {
    return [];
  }

  const normalizedFieldName = normalizeRelationName(field.name);

  return RELATION_REGISTRY.map((entry) => {
    const normalizedAliases = entry.aliases.map(normalizeRelationName);
    const directMatch = normalizedAliases.includes(normalizedFieldName);

    if (!directMatch) {
      return null;
    }

    return scoreRelationCandidate(entry, field, fields);
  })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
}

async function walkFiles(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath)));
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

function extractMapperNames(content = "") {
  const matches = [
    ...content.matchAll(/export const\s+([A-Za-z0-9_]+)/g),
    ...content.matchAll(/export function\s+([A-Za-z0-9_]+)/g),
  ];

  return unique(
    matches
      .map((match) => match[1])
      .filter((name) => !name.startsWith("T") && !name.startsWith("use"))
      .filter((name) => !["ReferenceResponse", "Media", "Meta"].includes(name)),
  );
}

function buildDiscoveredRelation({ relativePath, mapperName }) {
  const normalizedRelativePath = relativePath.replace(/\\/g, "/");
  const importPath = `@/${normalizedRelativePath.replace(/^src\//, "")}`;
  const pathSegments = relativePath
    .replace(/^src\/modules\//, "")
    .replace(/\/mappers\.ts$/, "")
    .split("/")
    .filter(Boolean);
  const moduleSegments = pathSegments.slice(0, -1);
  const entitySegment = pathSegments.at(-1) || "";
  const mapperBaseName = mapperName.replace(/Mapper$/, "");
  const aliases = unique([
    entitySegment,
    singularize(entitySegment),
    mapperBaseName,
    ...moduleSegments,
    ...splitWords(mapperBaseName),
  ]).map(normalizeAlias);

  return {
    key: normalizeAlias(entitySegment || mapperBaseName),
    label: mapperBaseName,
    aliases,
    modulePath: importPath,
    mapperName,
  };
}

async function discoverModuleRelations() {
  const modulesRoot = projectPath("src/modules");
  const files = await walkFiles(modulesRoot);
  const mapperFiles = files.filter(
    (filePath) => filePath.endsWith("/mappers.ts") || filePath.endsWith("\\mappers.ts"),
  );
  const discovered = [];

  for (const filePath of mapperFiles) {
    const relativePath = path.relative(process.cwd(), filePath);
    const content = await readFile(filePath);
    const mapperNames = extractMapperNames(content);

    mapperNames.forEach((mapperName) => {
      discovered.push(buildDiscoveredRelation({ relativePath, mapperName }));
    });
  }

  return discovered;
}

async function getDiscoveredRelations() {
  if (!discoveredRelationsPromise) {
    discoveredRelationsPromise = discoverModuleRelations();
  }

  return discoveredRelationsPromise;
}

export async function inferRelationCandidatesFromModules(field, fields = []) {
  const relationKind = getRelationKind(field);
  if (!relationKind || field.isMultiName) {
    return [];
  }

  const discovered = await getDiscoveredRelations();
  const normalizedFieldName = normalizeRelationName(field.name);

  return discovered
    .map((entry) => {
      if (!entry.aliases.includes(normalizedFieldName)) {
        return null;
      }

      return scoreRelationCandidate(entry, field, fields);
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
}
