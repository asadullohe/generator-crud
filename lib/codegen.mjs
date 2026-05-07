import {
  extractRequestSchema,
  extractResponseSchema,
  getSchemaFields,
  itemExpression,
  mapperExpression,
  schemaDefaultValue,
  schemaToTsType,
  schemaToYupType,
  unwrapEntitySchema,
} from "./schema.mjs";
import { singularize, toCamelCase, toKebabCase } from "./naming.mjs";

function fallbackField(name, type = "string", required = false) {
  return {
    name,
    camelName: toCamelCase(name),
    schema: { type },
    required,
    isMultiName: false,
  };
}

function indent(lines, spaces = 2) {
  const prefix = " ".repeat(spaces);
  return lines
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}

function normalizePathToTemplate(pathValue, placeholder = "id") {
  return pathValue.replace(/\{[^}]+\}/g, `\${${placeholder}}`);
}

function buildListApiMethod(operation, serviceKey) {
  const url = `\`${"${config.services."}${serviceKey}}${operation.path}\``;

  if (operation.method === "get") {
    return `list({ params }: { params: Params }) {
  return http.request.get(${url}, {
    params: {
      per_page: params.perPage,
      page: params.page,
      sort: params.sort,
      search: params.filter,
    },
  });
}`;
  }

  return `list({ params }: { params: Params }) {
  return http.request.post(${url}, {
    per_page: params.perPage,
    page: params.page,
    sort: params.sort,
    search: params.filter,
  });
}`;
}

function buildSingleApiMethod(operation, serviceKey) {
  const url = `\`${"${config.services."}${serviceKey}}${normalizePathToTemplate(operation.path)}\``;
  return `single({ id }: { id: string }) {
  return http.request.get(${url});
}`;
}

function buildCreateApiMethod(operation, serviceKey, valuesTypeName) {
  const url = `\`${"${config.services."}${serviceKey}}${operation.path}\``;
  return `create({ values }: { values: ${valuesTypeName} }) {
  return http.request.${operation.method}(${url}, {
    ...values,
  });
}`;
}

function buildUpdateApiMethod(operation, serviceKey, valuesTypeName) {
  const usesPathId = /\{[^}]+\}/.test(operation.path);
  const url = usesPathId
    ? `\`${"${config.services."}${serviceKey}}${normalizePathToTemplate(operation.path)}\``
    : `\`${"${config.services."}${serviceKey}}${operation.path}\``;

  if (usesPathId) {
    return `update({ id, values }: { id: string; values: ${valuesTypeName} }) {
  return http.request.${operation.method}(${url}, {
    ...values,
  });
}`;
  }

  return `update({ id, values }: { id: string; values: ${valuesTypeName} }) {
  return http.request.${operation.method}(${url}, {
    id,
    ...values,
  });
}`;
}

function buildDeleteApiMethod(operation, serviceKey) {
  const url = `\`${"${config.services."}${serviceKey}}${normalizePathToTemplate(operation.path)}\``;
  return `delete({ id }: { id: string }) {
  return http.request.delete(${url});
}`;
}

function buildExtraMutationApiMethod(mutation, serviceKey) {
  const url = mutation.hasPathParam
    ? `\`${"${config.services."}${serviceKey}}${normalizePathToTemplate(mutation.operation.path)}\``
    : `\`${"${config.services."}${serviceKey}}${mutation.operation.path}\``;

  if (mutation.kind === "upload") {
    return `${mutation.apiMethodName}({ ${mutation.hasPathParam ? "id, " : ""}values }: { ${mutation.hasPathParam ? "id: string; " : ""}values: Record<string, unknown> & { ${mutation.fileFieldName}: File } }) {
  const form = new FormData();
  Object.entries(values).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => form.append(key, item instanceof Blob ? item : String(item)));
      return;
    }
    form.append(key, value instanceof Blob ? value : String(value));
  });
  return http.request.${mutation.operation.method}(${url}, form, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
}`;
  }

  if (mutation.hasPayload) {
    return `${mutation.apiMethodName}({ ${mutation.hasPathParam ? "id, " : ""}values }: { ${mutation.hasPathParam ? "id: string; " : ""}values: Record<string, unknown> }) {
  return http.request.${mutation.operation.method}(${url}, values);
}`;
  }

  return `${mutation.apiMethodName}(${mutation.hasPathParam ? "{ id }: { id: string }" : ""}) {
  return http.request.${mutation.operation.method}(${url});
}`;
}

export function buildApiMethodsBlock({ operations, serviceKey, valuesTypeName, extraMutations = [] }) {
  const methods = [];

  if (operations.list) {
    methods.push(buildListApiMethod(operations.list, serviceKey));
  }
  if (operations.single) {
    methods.push(buildSingleApiMethod(operations.single, serviceKey));
  }
  if (operations.create) {
    methods.push(buildCreateApiMethod(operations.create, serviceKey, valuesTypeName));
  }
  if (operations.update) {
    methods.push(buildUpdateApiMethod(operations.update, serviceKey, valuesTypeName));
  }
  if (operations.delete) {
    methods.push(buildDeleteApiMethod(operations.delete, serviceKey));
  }
  extraMutations.forEach((mutation) => {
    methods.push(buildExtraMutationApiMethod(mutation, serviceKey));
  });

  return indent(methods.join(",\n"), 2);
}

export function buildSchemaContext(doc, operations) {
  const requestSchema = operations.create
    ? extractRequestSchema(operations.create.operation, doc)
    : operations.update
      ? extractRequestSchema(operations.update.operation, doc)
      : undefined;
  const entitySchema = unwrapEntitySchema(
    extractResponseSchema(
      operations.single?.operation ||
        operations.list?.operation ||
        operations.create?.operation ||
        operations.update?.operation,
      doc,
    ),
    doc,
  );
  let entityFields = getSchemaFields(entitySchema, doc);
  const formFields = getSchemaFields(requestSchema, doc);

  if (entityFields.length === 0) {
    if (formFields.length > 0) {
      entityFields = [
        fallbackField("id"),
        ...formFields.filter((field) => field.name !== "id"),
      ];
    } else {
      entityFields = [fallbackField("id")];
    }
  }

  return {
    entityFields,
    formFields,
  };
}

function buildRelationMapperExpression(field, relation) {
  const path = field.name;

  if (relation.relationKind === "array") {
    return `(get<any[]>(item, "${path}") || []).map((item) => ${relation.mapperName}(item))`;
  }

  return `${relation.mapperName}(get(item, "${path}"))`;
}

export function buildMapperImportsBlock(relationBindings = {}) {
  const uniqueImports = Array.from(
    new Map(
      Object.values(relationBindings).map((relation) => [
        `${relation.modulePath}:${relation.mapperName}`,
        relation,
      ]),
    ).values(),
  );

  return uniqueImports
    .map((relation) => `import { ${relation.mapperName} } from "${relation.modulePath}";`)
    .join("\n");
}

export function buildMapperFieldsBlock(fields, relationBindings = {}) {
  return fields
    .map((field) => {
      const relation = relationBindings[field.name];
      const expression = relation ? buildRelationMapperExpression(field, relation) : mapperExpression(field);

      return `    ${field.camelName}: ${expression},`;
    })
    .join("\n");
}

export function buildValidationFieldsBlock(fields) {
  return fields
    .map((field) => {
      if (field.isMultiName) {
        return `  ${field.name}: ${field.required ? "getMultiNameSchema()" : "getMultiNameSchema({ isRequired: false })"},`;
      }

      const validator = schemaToYupType(field.schema);
      const suffix = field.required ? ".required()" : ".notRequired()";
      return `  ${field.name}: ${validator}${suffix},`;
    })
    .join("\n");
}

export function buildCreateInitialValuesBlock(fields) {
  return fields
    .map((field) => `        ${field.name}: ${schemaDefaultValue(field.schema)},`)
    .join("\n");
}

function normalizeRelationAlias(value = "") {
  let normalized = String(value).trim();

  if (normalized.endsWith("_ids")) {
    normalized = normalized.slice(0, -4);
  } else if (normalized.endsWith("_id")) {
    normalized = normalized.slice(0, -3);
  }

  return toCamelCase(singularize(normalized));
}

function buildRelationUpdateExpression({ formField, entityField, relation }) {
  const itemPath = `item.${entityField.camelName}`;

  if (formField.name.endsWith("_ids") || relation.relationKind === "array") {
    return `(${itemPath} || []).map((item) => item.id)`;
  }

  return `${itemPath}?.id || ""`;
}

function resolveRelationUpdateExpression(formField, entityFields = [], relationBindings = {}) {
  const normalizedFormField = normalizeRelationAlias(formField.name);

  for (const entityField of entityFields) {
    const relation = relationBindings[entityField.name];

    if (!relation) {
      continue;
    }

    const aliases = [entityField.name, ...(relation.aliases || [])].map(normalizeRelationAlias);

    if (!aliases.includes(normalizedFormField)) {
      continue;
    }

    return buildRelationUpdateExpression({ formField, entityField, relation });
  }

  return null;
}

export function buildUpdateInitialValuesBlock(fields, entityFields = [], relationBindings = {}) {
  return fields
    .map((field) => {
      const relationExpression = resolveRelationUpdateExpression(
        field,
        entityFields,
        relationBindings,
      );

      return `        ${field.name}: ${relationExpression || itemExpression(field)},`;
    })
    .join("\n");
}

export function buildFormTypeBlock(fields) {
  return fields
    .map((field) => `  ${field.name}${field.required ? "" : "?"}: ${schemaToTsType(field.schema)};`)
    .join("\n");
}

export function buildSuggestedOutputPath(tag, operations) {
  const collectionPath =
    operations.create?.path ||
    operations.list?.path ||
    operations.update?.path ||
    operations.single?.path ||
    "";
  const segments = collectionPath
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.includes("{"));
  let tail = segments.at(-1);

  if (["pageable", "search"].includes(tail)) {
    tail = segments.at(-2);
  }

  const fallbackEntity = singularize(toKebabCase(tag || "entity"));
  const entitySegment = tail ? singularize(toCamelCase(tail)) : fallbackEntity;

  return `generated/${entitySegment}`;
}
