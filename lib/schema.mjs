import { toCamelCase } from "./naming.mjs";

const MULTI_NAME_KEYS = ["uz", "ru", "en", "ka"];

export function resolveRef(ref, doc) {
  if (!ref?.startsWith?.("#/")) {
    return undefined;
  }

  return ref
    .slice(2)
    .split("/")
    .reduce((accumulator, key) => accumulator?.[key], doc);
}

export function dereference(schema, doc) {
  if (!schema) {
    return undefined;
  }

  if (schema.$ref) {
    return dereference(resolveRef(schema.$ref, doc), doc);
  }

  if (schema.allOf) {
    const merged = schema.allOf.reduce(
      (accumulator, item) => {
        const resolved = dereference(item, doc) || {};
        return {
          ...accumulator,
          ...resolved,
          properties: {
            ...(accumulator.properties || {}),
            ...(resolved.properties || {}),
          },
          required: [...new Set([...(accumulator.required || []), ...(resolved.required || [])])],
        };
      },
      { properties: {}, required: [] },
    );

    return {
      ...schema,
      ...merged,
      type: schema.type || merged.type || "object",
    };
  }

  if (schema.oneOf?.length) {
    return dereference(schema.oneOf[0], doc);
  }

  if (schema.anyOf?.length) {
    return dereference(schema.anyOf[0], doc);
  }

  if (!schema.type && schema.properties) {
    return {
      ...schema,
      type: "object",
    };
  }

  return schema;
}

export function pickJsonContent(content = {}) {
  return (
    content["application/json"] ||
    content["application/*+json"] ||
    content["multipart/form-data"] ||
    Object.values(content)[0]
  );
}

export function extractRequestSchema(operation, doc) {
  const mediaType = pickJsonContent(operation?.requestBody?.content);
  return dereference(mediaType?.schema, doc);
}

export function extractResponseSchema(operation, doc) {
  const response =
    operation?.responses?.["200"] ||
    operation?.responses?.["201"] ||
    operation?.responses?.default ||
    Object.values(operation?.responses || {})[0];
  const mediaType = pickJsonContent(response?.content);

  return dereference(mediaType?.schema, doc);
}

export function unwrapEntitySchema(schema, doc) {
  const resolved = dereference(schema, doc);

  if (!resolved) {
    return undefined;
  }

  if (resolved.type === "array" && resolved.items) {
    return dereference(resolved.items, doc);
  }

  if (resolved.properties?.content?.items) {
    return dereference(resolved.properties.content.items, doc);
  }

  if (resolved.properties?.data) {
    return unwrapEntitySchema(resolved.properties.data, doc);
  }

  return resolved;
}

export function getSchemaFields(schema, doc) {
  const resolved = dereference(schema, doc);

  if (!resolved?.properties) {
    return [];
  }

  const required = new Set(resolved.required || []);

  return Object.entries(resolved.properties).map(([name, propertySchema]) => {
    const normalized = dereference(propertySchema, doc) || {};
    return {
      name,
      camelName: toCamelCase(name),
      schema: normalized,
      required: required.has(name),
      isMultiName: isMultiNameSchema(normalized),
    };
  });
}

export function isMultiNameSchema(schema) {
  if (schema?.type !== "object" || !schema.properties) {
    return false;
  }

  const keys = Object.keys(schema.properties);
  return MULTI_NAME_KEYS.every((key) => keys.includes(key));
}

export function schemaToTsType(schema, enumInfo = null) {
  if (!schema) {
    return "any";
  }

  if (isMultiNameSchema(schema)) {
    return "IMultiName";
  }

  if (enumInfo) {
    const typeExpression = `(typeof ${enumInfo.constName})[number]`;
    return enumInfo.isArray ? `Array<${typeExpression}>` : typeExpression;
  }

  if (schema.enum?.length) {
    return schema.enum.map((item) => JSON.stringify(item)).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${schemaToTsType(schema.items || {})}[]`;
    case "object":
      return "Record<string, unknown>";
    default:
      return "any";
  }
}

export function schemaToYupType(schema, enumInfo = null) {
  if (isMultiNameSchema(schema)) {
    return "getMultiNameSchema()";
  }

  if (enumInfo) {
    const validator = `yup.mixed<(typeof ${enumInfo.constName})[number]>().oneOf([...${enumInfo.constName}])`;
    return enumInfo.isArray ? `yup.array().of(${validator})` : validator;
  }

  switch (schema?.type) {
    case "string":
      return "yup.string()";
    case "integer":
    case "number":
      return "yup.number()";
    case "boolean":
      return "yup.boolean()";
    case "array":
      return `yup.array().of(${schemaToYupType(schema.items || {})})`;
    case "object":
      return "yup.mixed()";
    default:
      return "yup.mixed()";
  }
}

export function schemaDefaultValue(schema, enumInfo = null) {
  if (isMultiNameSchema(schema)) {
    return "getMultiName()";
  }

  if (enumInfo) {
    if (enumInfo.isArray) {
      return schema?.default !== undefined ? JSON.stringify(schema.default) : "[]";
    }

    if (schema?.default !== undefined) {
      return `${enumInfo.constName}.find((item) => item === ${JSON.stringify(schema.default)}) ?? ${enumInfo.constName}[0]`;
    }

    return `${enumInfo.constName}[0]`;
  }

  if (schema?.default !== undefined) {
    return JSON.stringify(schema.default);
  }

  switch (schema?.type) {
    case "string":
      return '""';
    case "integer":
    case "number":
      return "0";
    case "boolean":
      return "false";
    case "array":
      return "[]";
    case "object":
      return "{}";
    default:
      return '""';
  }
}

export function mapperExpression(field) {
  if (field.isMultiName) {
    return `getMultiName(item, { fieldName: "${field.name}" })`;
  }

  const path = field.name;

  if (field.enumInfo) {
    const typeExpression = `(typeof ${field.enumInfo.constName})[number]`;
    return field.enumInfo.isArray
      ? `get<Array<${typeExpression}>>(item, "${path}") ?? []`
      : `get<${typeExpression}>(item, "${path}") ?? ${field.enumInfo.constName}[0]`;
  }

  switch (field.schema?.type) {
    case "string":
      return `get<string>(item, "${path}") ?? ""`;
    case "integer":
    case "number":
      return `get<number>(item, "${path}") ?? 0`;
    case "boolean":
      return `get<boolean>(item, "${path}") ?? false`;
    case "array":
      return `get<any[]>(item, "${path}") ?? []`;
    case "object":
      return `get<Record<string, unknown>>(item, "${path}") ?? {}`;
    default:
      return `get<any>(item, "${path}") ?? null`;
  }
}

export function itemExpression(field) {
  if (field.isMultiName) {
    return `item.${field.camelName} || getMultiName()`;
  }

  const path = `item.${field.camelName}`;

  if (field.enumInfo) {
    return field.enumInfo.isArray ? `${path} || []` : `${path} ?? ${field.enumInfo.constName}[0]`;
  }

  switch (field.schema?.type) {
    case "string":
      return `${path} ?? ""`;
    case "integer":
    case "number":
      return `${path} ?? 0`;
    case "boolean":
      return `${path} ?? false`;
    case "array":
      return `${path} || []`;
    case "object":
      return `${path} || {}`;
    default:
      return `${path} ?? ""`;
  }
}
