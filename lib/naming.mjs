export function splitWords(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function toPascalCase(value) {
  return splitWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export function toCamelCase(value) {
  const pascal = toPascalCase(value);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : "";
}

export function toKebabCase(value) {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join("-");
}

export function toSnakeCase(value) {
  return splitWords(value)
    .map((word) => word.toLowerCase())
    .join("_");
}

export function toScreamingSnakeCase(value) {
  return splitWords(value)
    .map((word) => word.toUpperCase())
    .join("_");
}

export function singularize(value) {
  if (value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith("sses") || value.endsWith("shes") || value.endsWith("ches")) {
    return value.slice(0, -2);
  }

  if (value.endsWith("ses")) {
    return value.slice(0, -2);
  }

  if (value.endsWith("s") && !value.endsWith("ss")) {
    return value.slice(0, -1);
  }

  return value;
}

export function buildModuleNames(outputPath) {
  const segments = String(outputPath)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Output path bo'sh bo'lishi mumkin emas");
  }

  const entitySegment = segments.at(-1);
  const entityPascal = toPascalCase(singularize(entitySegment));
  const entityCamel = toCamelCase(singularize(entitySegment));
  const namespace = segments.map((segment) => toScreamingSnakeCase(segment)).join("/");

  return {
    outputPath: segments.join("/"),
    entitySegment,
    entityPascal,
    entityCamel,
    apiName: `${entityPascal}Api`,
    mapperName: `${entityPascal}Mapper`,
    entityTypeName: `T${entityPascal}`,
    validationName: `${entityPascal}Validation`,
    valuesTypeName: `${entityPascal}Values`,
    entityConstValue: `@@${namespace}`,
  };
}

