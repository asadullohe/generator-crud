import { spawnSync } from "node:child_process";
import { AUTH_MODES } from "./lib/constants.mjs";
import { buildApiMethodsBlock, buildCreateInitialValuesBlock, buildMapperFieldsBlock, buildMapperImportsBlock, buildSchemaContext, buildSuggestedOutputPath, buildUpdateInitialValuesBlock, buildValidationFieldsBlock } from "./lib/codegen.mjs";
import { ensureDir, writeFile } from "./lib/fs-utils.mjs";
import { buildModuleNames, toCamelCase, toPascalCase } from "./lib/naming.mjs";
import { detectExtraMutations, detectServiceKey, describeOperation, getOperationsByTag, getServers, getTags, loadConfigServices, loadOpenApiDocument, resolveCrudCandidates } from "./lib/openapi.mjs";
import { closePrompt, promptConfirm, promptSelect, promptText } from "./lib/prompt.mjs";
import {
  getRelationKind,
  inferRelationCandidates,
  inferRelationCandidatesFromModules,
  isRelationLikeField,
} from "./lib/relations.mjs";
import { extractRequestSchema, getSchemaFields } from "./lib/schema.mjs";
import { activateTemplate, getCurrentTemplateName, listSavedTemplates, seedBundledDefaultTemplate } from "./lib/template-builder.mjs";

async function ensureTemplateReady() {
  let savedTemplates = await listSavedTemplates();

  if (!savedTemplates.length) {
    const seededTemplate = await seedBundledDefaultTemplate();
    if (seededTemplate) {
      return seededTemplate;
    }

    savedTemplates = await listSavedTemplates();
  }

  if (!savedTemplates.length) {
    throw new Error("Template topilmadi: package ichidagi standard template ham topilmadi.");
  }

  if (savedTemplates.length === 1) {
    return activateTemplate(savedTemplates[0].templateName);
  }

  const currentTemplateName = await getCurrentTemplateName();
  const defaultIndex = Math.max(
    savedTemplates.findIndex((template) => template.templateName === currentTemplateName),
    0,
  );
  const selected = await promptSelect(
    "Qaysi template bilan CRUD generatsiya qilinsin?",
    savedTemplates.map((template) => ({
      label: `${template.templateName} (${template.sourcePath})`,
      value: template.templateName,
    })),
    defaultIndex,
  );

  return activateTemplate(selected.value);
}

async function promptAuthConfig() {
  const requiresAuth = await promptConfirm("Swagger uchun auth kerakmi?", false);

  if (!requiresAuth) {
    return { mode: AUTH_MODES.NONE };
  }

  const mode = await promptSelect("Auth turini tanlang", [
    { label: "Basic auth", value: AUTH_MODES.BASIC },
    { label: "Bearer token", value: AUTH_MODES.BEARER },
    { label: "Login/password orqali token", value: AUTH_MODES.LOGIN },
  ]);

  if (mode.value === AUTH_MODES.BASIC) {
    return {
      mode: AUTH_MODES.BASIC,
      username: await promptText("Login"),
      password: await promptText("Parol"),
    };
  }

  if (mode.value === AUTH_MODES.BEARER) {
    return {
      mode: AUTH_MODES.BEARER,
      token: await promptText("Bearer token"),
    };
  }

  return {
    mode: AUTH_MODES.LOGIN,
    username: await promptText("Login"),
    password: await promptText("Parol"),
    authUrl: await promptText("Auth endpoint URL"),
    authMethod: await promptText("Auth method", "POST"),
    loginField: await promptText("Login field key", "username"),
    passwordField: await promptText("Password field key", "password"),
    tokenPath: await promptText("Token response path", "accessToken"),
  };
}

async function chooseOperation(kind, operations) {
  if (!operations.length) {
    return null;
  }

  if (operations.length === 1) {
    return operations[0];
  }

  const selected = await promptSelect(
    `${kind} uchun operation tanlang`,
    operations.map((operation) => ({
      label: describeOperation(operation),
      value: operation,
    })),
  );

  return selected.value;
}

function operationHasPathParam(operation) {
  return /\{[^}]+\}/.test(operation.path);
}

function buildCustomActionBaseName(operation, intent = "action") {
  const segments = operation.path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.includes("{"))
    .filter((segment) => !/^v\d+$/i.test(segment))
    .filter((segment) => segment !== "control");

  const lastSegments = segments.slice(-2).join(" ");
  const fallback = operation.operationId || operation.summary || `${intent} ${operation.method}`;

  return toCamelCase(lastSegments || fallback || intent);
}

function buildExtraAction({
  operation,
  doc,
  generationType,
  kind = "custom",
  usedNames,
}) {
  const requestSchema = extractRequestSchema(operation.operation, doc);
  const requestFields = getSchemaFields(requestSchema, doc);
  const binaryField = requestFields.find(
    (field) =>
      field.schema?.format === "binary" ||
      field.schema?.format === "base64" ||
      field.name.toLowerCase().includes("file"),
  );

  let apiMethodName = buildCustomActionBaseName(operation, kind);
  if (!apiMethodName) {
    apiMethodName = kind === "custom" ? "customAction" : kind;
  }

  let dedupedMethodName = apiMethodName;
  let counter = 1;
  while (usedNames.has(dedupedMethodName)) {
    counter += 1;
    dedupedMethodName = `${apiMethodName}${counter}`;
  }
  usedNames.add(dedupedMethodName);

  return {
    generationType,
    kind,
    operation,
    apiMethodName: dedupedMethodName,
    hookName: `use${toPascalCase(dedupedMethodName)}`,
    formName: `${toPascalCase(dedupedMethodName)}Form`,
    validationName: `${toPascalCase(dedupedMethodName)}Validation`,
    valuesTypeName: `${toPascalCase(dedupedMethodName)}Values`,
    fileFieldName: binaryField?.name || "file",
    hasPayload: requestFields.length > 0,
    hasPathParam: operationHasPathParam(operation),
    requestFields,
    hasMultiNameFormFields: requestFields.some((field) => field.isMultiName),
  };
}

function buildClassificationOptions(operation, resolvedOperations) {
  const options = [];
  const method = operation.method;
  const hasPathParam = operationHasPathParam(operation);

  if (!resolvedOperations.list && ["get", "post"].includes(method) && !hasPathParam) {
    options.push({ label: "List / Infinite list", value: "list" });
  }
  if (!resolvedOperations.single && method === "get" && hasPathParam) {
    options.push({ label: "Single", value: "single" });
  }
  if (!resolvedOperations.create && method === "post" && !hasPathParam) {
    options.push({ label: "Create form", value: "create" });
  }
  if (!resolvedOperations.update && ["put", "patch"].includes(method)) {
    options.push({ label: "Update form", value: "update" });
  }
  if (!resolvedOperations.update && method === "post" && !hasPathParam) {
    options.push({ label: "Update form", value: "update" });
  }
  if (!resolvedOperations.delete && method === "delete") {
    options.push({ label: "Delete", value: "delete" });
  }

  if (["post", "put", "patch"].includes(method)) {
    options.push({ label: "Sync mutation", value: "sync" });
    options.push({ label: "Upload mutation", value: "upload" });
    options.push({ label: "Custom mutation", value: "custom-mutation" });
    options.push({ label: "Custom form", value: "custom-form" });
  }

  options.push({ label: "Skip", value: "skip" });
  return options;
}

async function classifyRemainingOperations({ operations, resolvedOperations, autoExtraActions, doc }) {
  const selected = new Set(Object.values(resolvedOperations).filter(Boolean));
  const autoSet = new Set(autoExtraActions.map((action) => action.operation));
  const usedNames = new Set(autoExtraActions.map((action) => action.apiMethodName));
  const extraActions = [...autoExtraActions];

  for (const operation of operations) {
    if (selected.has(operation) || autoSet.has(operation)) {
      continue;
    }

    const options = buildClassificationOptions(operation, resolvedOperations);
    const selectedOption = await promptSelect(
      `Operation nima bo'lishini tanlang: ${describeOperation(operation)}`,
      options,
    );

    switch (selectedOption.value) {
      case "list":
      case "single":
      case "create":
      case "update":
      case "delete":
        resolvedOperations[selectedOption.value] = operation;
        selected.add(operation);
        break;
      case "sync":
      case "upload":
        extraActions.push(
          buildExtraAction({
            operation,
            doc,
            generationType: "mutation",
            kind: selectedOption.value,
            usedNames,
          }),
        );
        break;
      case "custom-mutation":
        extraActions.push(
          buildExtraAction({
            operation,
            doc,
            generationType: "mutation",
            kind: "custom",
            usedNames,
          }),
        );
        break;
      case "custom-form":
        extraActions.push(
          buildExtraAction({
            operation,
            doc,
            generationType: "form",
            kind: "custom",
            usedNames,
          }),
        );
        break;
      default:
        break;
    }
  }

  return { resolvedOperations, extraActions };
}

function runHygen(locals) {
  const args = ["hygen", "crud-module", "new"];

  for (const [key, value] of Object.entries(locals)) {
    args.push(`--${key}`, String(value));
  }

  const result = spawnSync("pnpm", args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Hygen generator muvaffaqiyatsiz tugadi");
  }
}

async function writeExtraMutations({ names, extraActions, apiName }) {
  const mutationActions = extraActions.filter((action) => action.generationType === "mutation");
  if (!mutationActions.length) {
    return;
  }

  const mutationsDir = projectPath("src/modules", names.outputPath, "mutations");
  await ensureDir(mutationsDir);

  const exportLines = [];

  for (const mutation of mutationActions) {
    const filename = `${mutation.hookName}.ts`;
    exportLines.push(`export { default as ${mutation.hookName} } from "./${mutation.hookName}";`);

    const hookBody =
      mutation.kind === "upload"
        ? `import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ${apiName} } from "../api";
import { ENTITY } from "../constants";

type Payload = Record<string, unknown> & { ${mutation.fileFieldName}: File };

const ${mutation.hookName} = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: Payload) => {
      const { data } = await ${apiName}.${mutation.apiMethodName}({ values });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === ENTITY,
      });
    },
  });
};

export default ${mutation.hookName};
`
        : mutation.hasPayload
          ? `import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ${apiName} } from "../api";
import { ENTITY } from "../constants";

type Payload = Record<string, unknown>;

const ${mutation.hookName} = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: Payload) => {
      const { data } = await ${apiName}.${mutation.apiMethodName}({ values });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === ENTITY,
      });
    },
  });
};

export default ${mutation.hookName};
`
          : `import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ${apiName} } from "../api";
import { ENTITY } from "../constants";

const ${mutation.hookName} = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data } = await ${apiName}.${mutation.apiMethodName}();

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === ENTITY,
      });
    },
  });
};

export default ${mutation.hookName};
`;

    await writeFile(projectPath("src/modules", names.outputPath, "mutations", filename), hookBody);
  }

  await writeFile(projectPath("src/modules", names.outputPath, "mutations", "index.ts"), exportLines.join("\n"));
}

async function writeExtraForms({
  names,
  extraActions,
  apiName,
  mapperName,
  entityTypeName,
  hasCreateForm,
  hasUpdateForm,
}) {
  const formActions = extraActions.filter((action) => action.generationType === "form");
  if (!formActions.length && !hasCreateForm && !hasUpdateForm) {
    return;
  }

  const formsDir = projectPath("src/modules", names.outputPath, "forms");
  await ensureDir(formsDir);
  const exportLines = [];

  if (hasCreateForm) {
    exportLines.push('export * from "./CreateForm.tsx";');
  }
  if (hasUpdateForm) {
    exportLines.push('export * from "./UpdateForm.tsx";');
  }

  for (const action of formActions) {
    exportLines.push(`export * from "./${action.formName}.tsx";`);
    const formContent = `import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
${action.hasMultiNameFormFields ? 'import { getMultiName, getMultiNameSchema } from "@/common/mapppers.ts";\n' : ""}import { yup } from "@/services";
import { ${apiName} } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { ${mapperName}, type ${entityTypeName} } from "../mappers.ts";

const ${action.validationName} = yup.object().shape({
${buildValidationFieldsBlock(action.requestFields)}
});

type ${action.valuesTypeName} = yup.InferType<typeof ${action.validationName}>;

type ${action.formName}Props = {
  ${action.hasPathParam ? "id: string;\n  " : ""}children: (props: FormikProps<${action.valuesTypeName}>) => React.ReactNode;
} & Omit<UseMutationOptions<${entityTypeName}, unknown, ${action.valuesTypeName}>, "mutationFn" | "mutationKey">;

export function ${action.formName}({ ${action.hasPathParam ? "id, " : ""}children, ...mutationOptions }: ${action.formName}Props) {
  const { mutateAsync } = useMutation({
    mutationKey: [ENTITY, "form", "${action.apiMethodName}"],
    async mutationFn(values: ${action.valuesTypeName}) {
      const { data } = await ${apiName}.${action.apiMethodName}({ ${action.hasPathParam ? "id, " : ""}values });

      return ${mapperName}(data);
    },
    ...mutationOptions,
  });

  return (
    <Formik<${action.valuesTypeName}>
      onSubmit={(values) => mutateAsync(values)}
      initialValues={{
${buildCreateInitialValuesBlock(action.requestFields)}
      }}
      validationSchema={${action.validationName}}
      enableReinitialize
      validateOnChange
      validateOnBlur
    >
      {(props) => <Form>{children(props)}</Form>}
    </Formik>
  );
}
`;
    await writeFile(projectPath("src/modules", names.outputPath, "forms", `${action.formName}.tsx`), formContent);
  }

  await writeFile(projectPath("src/modules", names.outputPath, "forms", "index.ts"), exportLines.join("\n"));
}

async function promptAvailableOutputPath(defaultPath) {
  let suggestedPath = defaultPath;

  while (true) {
    const outputPath = await promptText(
      "Module output path (`src/modules/` dan keyingi qism)",
      suggestedPath,
    );
    const names = buildModuleNames(outputPath);
    const absoluteOutput = projectPath("src/modules", names.outputPath);

    if (!(await pathExists(absoluteOutput))) {
      return names;
    }

    console.log(`\nBu path band: src/modules/${names.outputPath}`);
    suggestedPath = await promptText(
      "Yangi output path kiriting",
      `${names.outputPath}Copy`,
    );
  }
}

async function resolveEntityRelationBindings(fields) {
  const bindings = {};

  for (const field of fields) {
    const suggestions = [
      ...inferRelationCandidates(field, fields),
      ...(await inferRelationCandidatesFromModules(field, fields)),
    ].filter(
      (candidate, index, array) =>
        array.findIndex(
          (item) =>
            item.modulePath === candidate.modulePath && item.mapperName === candidate.mapperName,
        ) === index,
    );
    const relationKind = getRelationKind(field);
    const shouldPromptManual = !suggestions.length && isRelationLikeField(field, fields);

    if (!suggestions.length && !shouldPromptManual) {
      continue;
    }

    if (suggestions.length === 1 && suggestions[0].confidence === "high") {
      bindings[field.name] = suggestions[0];
      console.log(
        `Relation auto tanlandi: "${field.name}" -> ${suggestions[0].label} (${suggestions[0].mapperName})`,
      );
      continue;
    }

    const selected = await promptSelect(
      `"${field.name}" fieldi uchun relation mapper tanlang`,
      [
        {
          label: "Oddiy field",
          value: null,
          hint: "Mapper ishlatilmaydi, field oddiy object/array bo'lib qoladi",
        },
        {
          label: "Qo'lda relation kiritish",
          value: "manual",
          hint: "Module path va mapper nomini o'zingiz kiritasiz",
        },
        ...suggestions.map((suggestion) => ({
          label: `${suggestion.label} -> ${suggestion.mapperName}`,
          value: suggestion,
          hint:
            suggestion.relationKind === "array"
              ? "Array relation sifatida map qilinadi"
              : "Nested object relation sifatida map qilinadi",
        })),
      ],
      suggestions.length ? 1 : 0,
    );

    if (selected.value === "manual") {
      const modulePath = await promptText(
        `"${field.name}" uchun mapper import path`,
        "@/modules/",
      );
      const mapperName = await promptText(`"${field.name}" uchun mapper nomi`);

      bindings[field.name] = {
        key: field.name,
        label: field.name,
        aliases: [field.name],
        relationKind: relationKind || "object",
        modulePath,
        mapperName,
        confidence: "manual",
      };
      continue;
    }

    if (selected.value) {
      bindings[field.name] = selected.value;
    }
  }

  return bindings;
}

async function main() {
  const manifest = await ensureTemplateReady();
  const swaggerUrl = await promptText("Swagger/OpenAPI URL yoki local file path");
  const auth = await promptAuthConfig();
  const doc = await loadOpenApiDocument(swaggerUrl, auth);
  const services = await loadConfigServices(projectPath("src/config.ts"));

  const server = await promptSelect(
    "Service uchun server tanlang",
    getServers(doc, swaggerUrl).map((serverItem) => ({
      label: serverItem.label,
      value: serverItem.value,
    })),
  );

  let serviceKey = detectServiceKey(server.value, services);

  if (!serviceKey) {
    serviceKey = (
      await promptSelect(
        "config.services ichidan service key tanlang",
        Object.keys(services).map((key) => ({
          label: `${key} (${services[key]})`,
          value: key,
        })),
      )
    ).value;
  }

  const tag = await promptSelect(
    "Tag tanlang",
    getTags(doc).map((tagItem) => ({
      label: tagItem.label,
      value: tagItem.value,
    })),
  );

  const operations = getOperationsByTag(doc, tag.value);
  if (!operations.length) {
    throw new Error(`"${tag.value}" tagi uchun operation topilmadi`);
  }

  const candidates = resolveCrudCandidates(operations);
  const resolvedOperations = {
    list: await chooseOperation("list", candidates.list),
    single: await chooseOperation("single", candidates.single),
    create: await chooseOperation("create", candidates.create),
    update: await chooseOperation("update", candidates.update),
    delete: await chooseOperation("delete", candidates.delete),
  };
  const autoExtraActions = detectExtraMutations(operations, resolvedOperations, doc).map((action) => ({
    ...action,
    generationType: "mutation",
    hasPathParam: operationHasPathParam(action.operation),
    requestFields: [],
    hasMultiNameFormFields: false,
    formName: `${toPascalCase(action.apiMethodName)}Form`,
    validationName: `${toPascalCase(action.apiMethodName)}Validation`,
    valuesTypeName: `${toPascalCase(action.apiMethodName)}Values`,
  }));
  const classified = await classifyRemainingOperations({
    operations,
    resolvedOperations,
    autoExtraActions,
    doc,
  });
  const finalOperations = classified.resolvedOperations;
  const extraActions = classified.extraActions;

  if (
    !finalOperations.list &&
    !finalOperations.single &&
    !finalOperations.create &&
    !finalOperations.update &&
    !finalOperations.delete &&
    !extraActions.length
  ) {
    throw new Error("Tanlangan tag uchun generatsiya qilsa bo'ladigan operation topilmadi");
  }

  const names = await promptAvailableOutputPath(buildSuggestedOutputPath(tag.value, finalOperations));
  const schemaContext = buildSchemaContext(doc, finalOperations);
  const relationBindings = await resolveEntityRelationBindings(schemaContext.entityFields);
  const hasCreateForm = Boolean(finalOperations.create && schemaContext.formFields.length);
  const hasUpdateForm = Boolean(finalOperations.update && schemaContext.formFields.length);
  const hasList = Boolean(finalOperations.list);
  const hasSingle = Boolean(finalOperations.single);
  const hasCreate = Boolean(finalOperations.create);
  const hasUpdate = Boolean(finalOperations.update);
  const hasDelete = Boolean(finalOperations.delete);
  const hasMutations = extraActions.some((action) => action.generationType === "mutation");
  const hasCustomForms = extraActions.some((action) => action.generationType === "form");
  const hasMultiNameEntityFields = schemaContext.entityFields.some((field) => field.isMultiName);
  const hasMultiNameFormFields = schemaContext.formFields.some((field) => field.isMultiName);

  runHygen({
    ...names,
    serviceKey,
    defaultSortKey: manifest.defaultSortKey || "created_at",
    hasList,
    hasSingle,
    hasCreate,
    hasUpdate,
    hasDelete,
    hasMutations,
    hasCustomForms,
    hasCreateForm,
    hasUpdateForm,
    hasMultiNameEntityFields,
    hasMultiNameFormFields,
    skipTypes: hasList ? "false" : "true",
    skipValidation: hasCreate || hasUpdate ? "false" : "true",
    skipFormsIndex: hasCreateForm || hasUpdateForm ? "false" : "true",
    skipCreateForm: hasCreateForm ? "false" : "true",
    skipUpdateForm: hasUpdateForm ? "false" : "true",
    skipUseList: hasList ? "false" : "true",
    skipUseSingle: hasSingle ? "false" : "true",
    skipUseDelete: hasDelete ? "false" : "true",
    skipUseInfiniteList: hasList ? "false" : "true",
    apiMethodsBlock: buildApiMethodsBlock({
      operations: finalOperations,
      serviceKey,
      valuesTypeName: names.valuesTypeName,
      extraMutations: extraActions,
    }),
    mapperImportsBlock: buildMapperImportsBlock(relationBindings),
    mapperFieldsBlock: buildMapperFieldsBlock(schemaContext.entityFields, relationBindings),
    validationFieldsBlock: buildValidationFieldsBlock(schemaContext.formFields),
    createInitialValuesBlock: buildCreateInitialValuesBlock(schemaContext.formFields),
    updateInitialValuesBlock: buildUpdateInitialValuesBlock(
      schemaContext.formFields,
      schemaContext.entityFields,
      relationBindings,
    ),
  });

  await writeExtraMutations({
    names,
    extraActions,
    apiName: names.apiName,
  });
  await writeExtraForms({
    names,
    extraActions,
    apiName: names.apiName,
    mapperName: names.mapperName,
    entityTypeName: names.entityTypeName,
    hasCreateForm,
    hasUpdateForm,
  });

  console.log(`\nCRUD modul yaratildi: src/modules/${names.outputPath}`);
}

await main()
  .catch((error) => {
    console.error(`\nXatolik: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closePrompt();
  });
