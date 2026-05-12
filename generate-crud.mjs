import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { AUTH_MODES } from "./lib/constants.mjs";
import {
  buildApiMethodsBlock,
  buildConstantsImportSpec,
  buildCreateInitialValuesBlock,
  buildEnumConstantsBlock,
  buildEnumContext,
  buildMapperFieldsBlock,
  buildMapperImportsBlock,
  buildSchemaContext,
  buildSuggestedOutputPath,
  buildUpdateInitialValuesBlock,
  buildValidationFieldsBlock,
} from "./lib/codegen.mjs";
import { ensureDir, pathExists, projectPath, writeFile } from "./lib/fs-utils.mjs";
import { ensureGeneratorConfigFile, loadGeneratorConfig, resolveAuthConfig } from "./lib/generator-config.mjs";
import { buildModuleNames, toCamelCase, toPascalCase } from "./lib/naming.mjs";
import { detectExtraMutations, detectServiceKey, describeOperation, getOperationsByTag, getServers, getSwaggerDefinitions, getTags, loadConfigServices, loadOpenApiDocument, resolveCrudCandidates } from "./lib/openapi.mjs";
import { PromptBackError, closePrompt, promptConfirm, promptSelect, promptText } from "./lib/prompt.mjs";
import {
  getRelationKind,
  inferRelationCandidates,
  inferRelationCandidatesFromModules,
  isRelationLikeField,
} from "./lib/relations.mjs";
import { extractRequestSchema, getSchemaFields } from "./lib/schema.mjs";
import { activateTemplate, getCurrentTemplateName, listSavedTemplates, seedBundledDefaultTemplate } from "./lib/template-builder.mjs";

const require = createRequire(import.meta.url);

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

async function promptAuthConfig(options = {}) {
  const requiresAuth = await promptConfirm("Swagger uchun auth kerakmi?", false, options);

  if (!requiresAuth) {
    return { mode: AUTH_MODES.NONE };
  }

  const mode = await promptSelect("Auth turini tanlang", [
    { label: "Basic auth", value: AUTH_MODES.BASIC },
    { label: "Bearer token", value: AUTH_MODES.BEARER },
    { label: "Login/password orqali token", value: AUTH_MODES.LOGIN },
  ], 0, options);

  if (mode.value === AUTH_MODES.BASIC) {
    return {
      mode: AUTH_MODES.BASIC,
      username: await promptText("Login", "", options),
      password: await promptText("Parol", "", options),
    };
  }

  if (mode.value === AUTH_MODES.BEARER) {
    return {
      mode: AUTH_MODES.BEARER,
      token: await promptText("Bearer token", "", options),
    };
  }

  return {
    mode: AUTH_MODES.LOGIN,
    username: await promptText("Login", "", options),
    password: await promptText("Parol", "", options),
    authUrl: await promptText("Auth endpoint URL", "", options),
    authMethod: await promptText("Auth method", "POST", options),
    loginField: await promptText("Login field key", "username", options),
    passwordField: await promptText("Password field key", "password", options),
    tokenPath: await promptText("Token response path", "accessToken", options),
  };
}

async function chooseOperation(kind, operations, options = {}) {
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
    0,
    options,
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

async function classifyRemainingOperations({ operations, resolvedOperations, autoExtraActions, doc }, promptOptions = {}) {
  const selected = new Set(Object.values(resolvedOperations).filter(Boolean));
  const autoSet = new Set(autoExtraActions.map((action) => action.operation));
  const usedNames = new Set(autoExtraActions.map((action) => action.apiMethodName));
  const extraActions = [...autoExtraActions];

  for (const operation of operations) {
    if (selected.has(operation) || autoSet.has(operation)) {
      continue;
    }

    const classificationOptions = buildClassificationOptions(operation, resolvedOperations);
    const selectedOption = await promptSelect(
      `Operation nima bo'lishini tanlang: ${describeOperation(operation)}`,
      classificationOptions,
      0,
      promptOptions,
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
  const hygenPackagePath = require.resolve("hygen/package.json");
  const hygenBin = path.join(path.dirname(hygenPackagePath), "dist/bin.js");
  const args = [hygenBin, "crud-module", "new"];

  for (const [key, value] of Object.entries(locals)) {
    args.push(`--${key}`, String(value));
  }

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Hygen generator muvaffaqiyatsiz tugadi");
  }
}

function inferServiceKeyFromServer(serverUrl) {
  try {
    const url = new URL(serverUrl, "http://localhost");
    const firstSegment = url.pathname.split("/").filter(Boolean)[0];
    return firstSegment ? toCamelCase(firstSegment) : "api";
  } catch {
    return "api";
  }
}

async function chooseServer(doc, swaggerUrl, config, options = {}) {
  const servers = getServers(doc, swaggerUrl);

  if (config.serverUrl) {
    return {
      server: {
        label: config.serverUrl,
        value: config.serverUrl,
      },
      prompted: false,
    };
  }

  if (servers.length === 1 && !options.allowBack) {
    return { server: servers[0], prompted: false };
  }

  const selected = await promptSelect(
    "Service uchun server tanlang",
    servers.map((serverItem) => ({
      label: serverItem.label,
      value: serverItem.value,
    })),
    0,
    options,
  );

  return { server: selected, prompted: true };
}

async function chooseDefinition(swaggerUrl, auth, config, options = {}) {
  if (config.definitionUrl) {
    return {
      definition: {
        name: config.definitionName || config.definitionUrl,
        label: config.definitionName || config.definitionUrl,
        url: config.definitionUrl,
      },
      prompted: false,
    };
  }

  const definitions = await getSwaggerDefinitions(swaggerUrl, auth);

  if (!definitions.length) {
    return { definition: null, prompted: false };
  }

  if (config.definitionName) {
    const matched = definitions.find((definition) => definition.name === config.definitionName);
    if (!matched) {
      throw new Error(`Swagger definition topilmadi: ${config.definitionName}`);
    }

    return { definition: matched, prompted: false };
  }

  const pageUrl = new URL(swaggerUrl, "http://localhost");
  const primaryName = pageUrl.searchParams.get("urls.primaryName");
  if (primaryName) {
    const matched = definitions.find((definition) => definition.name === primaryName);
    if (matched) {
      return { definition: matched, prompted: false };
    }
  }

  if (definitions.length === 1 && !options.allowBack) {
    return { definition: definitions[0], prompted: false };
  }

  const selected = await promptSelect(
    "Swagger definition tanlang",
    definitions.map((definition) => ({
      label: definition.label,
      value: definition,
    })),
    0,
    options,
  );

  return { definition: selected.value, prompted: true };
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
    const constantsImportSpec = buildConstantsImportSpec({
      fields: action.requestFields,
      includeEntity: true,
    });
    const formContent = `import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
${action.hasMultiNameFormFields ? 'import { getMultiName, getMultiNameSchema } from "@/common/mapppers.ts";\n' : ""}import { yup } from "@/services";
import { ${apiName} } from "../api.ts";
import { ${constantsImportSpec} } from "../constants.ts";
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

async function promptAvailableOutputPath(defaultPath, options = {}) {
  let suggestedPath = defaultPath;

  while (true) {
    const outputPath = await promptText(
      "Module output path (`src/modules/` dan keyingi qism)",
      suggestedPath,
      options,
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
      options,
    );
  }
}

async function resolveEntityRelationBindings(fields, options = {}) {
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
      options,
    );

    if (selected.value === "manual") {
      const modulePath = await promptText(
        `"${field.name}" uchun mapper import path`,
        "@/modules/",
        options,
      );
      const mapperName = await promptText(`"${field.name}" uchun mapper nomi`, "", options);

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

function buildAutoExtraActions(operations, resolvedOperations, doc) {
  return detectExtraMutations(operations, resolvedOperations, doc).map((action) => ({
    ...action,
    generationType: "mutation",
    hasPathParam: operationHasPathParam(action.operation),
    requestFields: [],
    hasMultiNameFormFields: false,
    formName: `${toPascalCase(action.apiMethodName)}Form`,
    validationName: `${toPascalCase(action.apiMethodName)}Validation`,
    valuesTypeName: `${toPascalCase(action.apiMethodName)}Values`,
  }));
}

function hasGeneratableOperations(finalOperations, extraActions) {
  return (
    finalOperations.list ||
    finalOperations.single ||
    finalOperations.create ||
    finalOperations.update ||
    finalOperations.delete ||
    extraActions.length
  );
}

function previousInteractiveStep(steps, currentIndex) {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (steps[index].wasInteractive ?? steps[index].interactive) {
      return index;
    }
  }

  return null;
}

async function runCrudWizard({ config, manifest }) {
  const state = { config, manifest };
  const promptOptions = { allowBack: true };
  const steps = [
    {
      key: "swagger",
      interactive: !config.swaggerUrl,
      run: async () => {
        state.swaggerUrl = config.swaggerUrl || await promptText("Swagger/OpenAPI URL yoki local file path", "", promptOptions);
      },
    },
    {
      key: "auth",
      interactive: !config.auth,
      run: async () => {
        state.auth = resolveAuthConfig(config.auth) || await promptAuthConfig(promptOptions);
      },
    },
    {
      key: "definition",
      interactive: false,
      run: async () => {
        const result = await chooseDefinition(state.swaggerUrl, state.auth, config, promptOptions);
        state.definition = result.definition;
        steps.find((step) => step.key === "definition").wasInteractive = result.prompted;
      },
    },
    {
      key: "document",
      interactive: false,
      run: async () => {
        state.doc = await loadOpenApiDocument(state.definition?.url || state.swaggerUrl, state.auth);
        state.services = await loadConfigServices(projectPath("src/config.ts"));
      },
    },
    {
      key: "server",
      interactive: false,
      run: async () => {
        const result = await chooseServer(state.doc, state.swaggerUrl, config, promptOptions);
        state.server = result.server;
        steps.find((step) => step.key === "server").wasInteractive = result.prompted;
        state.serviceKey =
          config.serviceKey ||
          detectServiceKey(state.server.value, state.services) ||
          inferServiceKeyFromServer(state.server.value);
      },
    },
    {
      key: "tag",
      interactive: true,
      run: async () => {
        state.tag = await promptSelect(
          "Tag tanlang",
          getTags(state.doc).map((tagItem) => ({
            label: tagItem.label,
            value: tagItem.value,
          })),
          0,
          promptOptions,
        );
        state.operations = getOperationsByTag(state.doc, state.tag.value);
        if (!state.operations.length) {
          throw new Error(`"${state.tag.value}" tagi uchun operation topilmadi`);
        }
      },
    },
    {
      key: "operations",
      interactive: true,
      run: async () => {
        const candidates = resolveCrudCandidates(state.operations);
        state.resolvedOperations = {
          list: await chooseOperation("list", candidates.list, promptOptions),
          single: await chooseOperation("single", candidates.single, promptOptions),
          create: await chooseOperation("create", candidates.create, promptOptions),
          update: await chooseOperation("update", candidates.update, promptOptions),
          delete: await chooseOperation("delete", candidates.delete, promptOptions),
        };
        state.autoExtraActions = buildAutoExtraActions(state.operations, state.resolvedOperations, state.doc);
      },
    },
    {
      key: "extraOperations",
      interactive: true,
      run: async () => {
        const classified = await classifyRemainingOperations(
          {
            operations: state.operations,
            resolvedOperations: { ...state.resolvedOperations },
            autoExtraActions: state.autoExtraActions,
            doc: state.doc,
          },
          promptOptions,
        );
        state.finalOperations = classified.resolvedOperations;
        state.extraActions = classified.extraActions;

        if (!hasGeneratableOperations(state.finalOperations, state.extraActions)) {
          throw new Error("Tanlangan tag uchun generatsiya qilsa bo'ladigan operation topilmadi");
        }
      },
    },
    {
      key: "outputPath",
      interactive: true,
      run: async () => {
        state.names = await promptAvailableOutputPath(
          buildSuggestedOutputPath(state.tag.value, state.finalOperations),
          promptOptions,
        );
      },
    },
    {
      key: "relations",
      interactive: true,
      run: async () => {
        state.schemaContext = buildSchemaContext(state.doc, state.finalOperations);
        state.relationBindings = await resolveEntityRelationBindings(
          state.schemaContext.entityFields,
          promptOptions,
        );
      },
    },
  ];

  for (let index = 0; index < steps.length;) {
    try {
      await steps[index].run();
      index += 1;
    } catch (error) {
      if (!(error instanceof PromptBackError)) {
        throw error;
      }

      const previousIndex = previousInteractiveStep(steps, index);
      if (previousIndex == null) {
        console.log("Oldingi step yo'q.");
        continue;
      }

      index = previousIndex;
    }
  }

  return state;
}

async function main() {
  await ensureGeneratorConfigFile();
  const config = await loadGeneratorConfig();
  const manifest = await ensureTemplateReady();
  const {
    doc,
    serviceKey,
    finalOperations,
    extraActions,
    names,
    schemaContext,
    relationBindings,
  } = await runCrudWizard({ config, manifest });
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
  const enumContext = buildEnumContext({
    schemaContext,
    extraActions,
  });
  const generatedSchemaContext = enumContext.schemaContext;
  const generatedExtraActions = enumContext.extraActions;

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
    enumConstantsBlock: buildEnumConstantsBlock(enumContext.enumDefinitions),
    mapperConstantsImportSpec: buildConstantsImportSpec({
      fields: generatedSchemaContext.entityFields,
    }),
    validationConstantsImportSpec: buildConstantsImportSpec({
      fields: generatedSchemaContext.formFields,
    }),
    formConstantsImportSpec: buildConstantsImportSpec({
      fields: generatedSchemaContext.formFields,
      includeEntity: true,
      enumValueMode: "direct",
    }),
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
      extraMutations: generatedExtraActions,
    }),
    mapperImportsBlock: buildMapperImportsBlock(relationBindings),
    mapperFieldsBlock: buildMapperFieldsBlock(generatedSchemaContext.entityFields, relationBindings),
    validationFieldsBlock: buildValidationFieldsBlock(generatedSchemaContext.formFields),
    createInitialValuesBlock: buildCreateInitialValuesBlock(generatedSchemaContext.formFields),
    updateInitialValuesBlock: buildUpdateInitialValuesBlock(
      generatedSchemaContext.formFields,
      generatedSchemaContext.entityFields,
      relationBindings,
    ),
  });

  await writeExtraMutations({
    names,
    extraActions: generatedExtraActions,
    apiName: names.apiName,
  });
  await writeExtraForms({
    names,
    extraActions: generatedExtraActions,
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
