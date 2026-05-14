import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
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
import { ensureDir, pathExists, projectPath, readFile, writeFile } from "./lib/fs-utils.mjs";
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

function buildSingleHookOptions(operation) {
  const options = [];
  const hasPathParam = operationHasPathParam(operation);

  if (["get", "post"].includes(operation.method) && !hasPathParam) {
    options.push({ label: "useList hook", value: "list" });
    options.push({ label: "useInfiniteList hook", value: "infinite-list" });
  }
  if (operation.method === "get" && hasPathParam) {
    options.push({ label: "useSingle hook", value: "single" });
  }
  if (operation.method === "delete") {
    options.push({ label: "useDelete hook", value: "delete" });
  }

  return options;
}

function buildSingleFormOptions(operation) {
  const options = [];
  const hasPathParam = operationHasPathParam(operation);

  if (operation.method === "post" && !hasPathParam) {
    options.push({ label: "CreateForm", value: "create" });
  }
  if (["put", "patch"].includes(operation.method) || (operation.method === "post" && !hasPathParam)) {
    options.push({ label: "UpdateForm", value: "update" });
  }
  if (["post", "put", "patch"].includes(operation.method)) {
    options.push({ label: "Custom form", value: "custom-form" });
  }

  return options;
}

function buildSingleMutationOptions(operation, doc) {
  if (!["post", "put", "patch", "delete"].includes(operation.method)) {
    return [];
  }

  const options = [];
  const requestSchema = extractRequestSchema(operation.operation, doc);
  const requestFields = getSchemaFields(requestSchema, doc);
  const operationText = `${operation.path} ${operation.operationId} ${operation.summary}`.toLowerCase();
  const hasFileField = requestFields.some(
    (field) =>
      field.schema?.format === "binary" ||
      field.schema?.format === "base64" ||
      field.name.toLowerCase().includes("file"),
  );

  if (hasFileField || operationText.includes("upload")) {
    options.push({ label: "Upload mutation", value: "upload" });
  }

  options.push(
    { label: "Sync mutation", value: "sync" },
    { label: "Custom mutation", value: "custom-mutation" },
  );

  return options;
}

async function chooseTaggedOperation(operations, message, options = {}) {
  const selected = await promptSelect(
    message,
    operations.map((operation) => ({
      label: describeOperation(operation),
      value: operation,
    })),
    0,
    options,
  );

  return selected.value;
}

async function resolveSingleArtifact({ artifactMode, operations, doc }, promptOptions = {}) {
  const generatableOperations = operations.filter((operation) => {
    if (artifactMode === "hook") {
      return buildSingleHookOptions(operation).length > 0;
    }
    if (artifactMode === "form") {
      return buildSingleFormOptions(operation).length > 0;
    }
    return buildSingleMutationOptions(operation, doc).length > 0;
  });

  if (!generatableOperations.length) {
    throw new Error(`Tanlangan tag uchun ${artifactMode} generatsiya qilsa bo'ladigan operation topilmadi`);
  }

  const operation = await chooseTaggedOperation(
    generatableOperations,
    "Qaysi operation uchun generatsiya qilinsin?",
    promptOptions,
  );
  const resolvedOperations = {};
  const extraActions = [];
  const artifact = { mode: artifactMode };

  if (artifactMode === "hook") {
    const hookOptions = buildSingleHookOptions(operation);
    const selectedHook = await promptSelect("Qaysi hook generatsiya qilinsin?", hookOptions, 0, promptOptions);
    artifact.hookKind = selectedHook.value;

    if (selectedHook.value === "list" || selectedHook.value === "infinite-list") {
      resolvedOperations.list = operation;
    } else {
      resolvedOperations[selectedHook.value] = operation;
    }

    return { resolvedOperations, extraActions, artifact };
  }

  if (artifactMode === "form") {
    const formOptions = buildSingleFormOptions(operation);
    const selectedForm = await promptSelect("Qaysi forma generatsiya qilinsin?", formOptions, 0, promptOptions);
    artifact.formKind = selectedForm.value;

    if (selectedForm.value === "create" || selectedForm.value === "update") {
      resolvedOperations[selectedForm.value] = operation;
    } else {
      extraActions.push(
        buildExtraAction({
          operation,
          doc,
          generationType: "form",
          kind: "custom",
          usedNames: new Set(),
        }),
      );
    }

    return { resolvedOperations, extraActions, artifact };
  }

  const mutationOptions = buildSingleMutationOptions(operation, doc);
  const selectedMutation = await promptSelect(
    "Qaysi mutation generatsiya qilinsin?",
    mutationOptions,
    0,
    promptOptions,
  );
  artifact.mutationKind = selectedMutation.value;
  extraActions.push(
    buildExtraAction({
      operation,
      doc,
      generationType: "mutation",
      kind: selectedMutation.value === "custom-mutation" ? "custom" : selectedMutation.value,
      usedNames: new Set(),
    }),
  );

  return { resolvedOperations, extraActions, artifact };
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

async function mergeFileLines(filePath, lines) {
  const existingLines = (await pathExists(filePath))
    ? (await readFile(filePath)).split(/\r?\n/).filter(Boolean)
    : [];
  const mergedLines = [...existingLines];

  for (const line of lines.filter(Boolean)) {
    if (!mergedLines.includes(line)) {
      mergedLines.push(line);
    }
  }

  await writeFile(filePath, mergedLines.join("\n"));
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
${mutation.hasPathParam ? "\ntype MutationArgs = { id: string; values: Payload };" : ""}

const ${mutation.hookName} = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (${mutation.hasPathParam ? "{ id, values }: MutationArgs" : "values: Payload"}) => {
      const { data } = await ${apiName}.${mutation.apiMethodName}({ ${mutation.hasPathParam ? "id, " : ""}values });

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
${mutation.hasPathParam ? "\ntype MutationArgs = { id: string; values: Payload };" : ""}

const ${mutation.hookName} = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (${mutation.hasPathParam ? "{ id, values }: MutationArgs" : "values: Payload"}) => {
      const { data } = await ${apiName}.${mutation.apiMethodName}({ ${mutation.hasPathParam ? "id, " : ""}values });

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
    mutationFn: async (${mutation.hasPathParam ? "{ id }: { id: string }" : ""}) => {
      const { data } = await ${apiName}.${mutation.apiMethodName}(${mutation.hasPathParam ? "{ id }" : ""});

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

  await mergeFileLines(projectPath("src/modules", names.outputPath, "mutations", "index.ts"), exportLines);
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

  await mergeFileLines(projectPath("src/modules", names.outputPath, "forms", "index.ts"), exportLines);
}

function hasExportedConst(content, constName) {
  return new RegExp(`export\\s+const\\s+${constName}\\b`).test(content);
}

function parseImportSpec(importSpec = "") {
  return importSpec
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeImportSpec(existingSpec, requiredNames) {
  const existingNames = parseImportSpec(existingSpec);
  const names = [...existingNames];

  for (const name of requiredNames) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  return names.join(", ");
}

function ensureNamedImport(content, importSpec, sourcePath) {
  const requiredNames = parseImportSpec(importSpec);
  if (!requiredNames.length) {
    return content;
  }

  const sourceWithoutExtension = sourcePath.replace(/\.ts$/, "");
  const sourcePattern = sourcePath.endsWith(".ts")
    ? `${escapeRegExp(sourceWithoutExtension)}(?:\\.ts)?`
    : escapeRegExp(sourcePath);
  const importPattern = new RegExp(
    `^import\\s+\\{\\s*([^}]+?)\\s*\\}\\s+from\\s+["'](${sourcePattern})["'];?`,
    "m",
  );
  const match = content.match(importPattern);

  if (match) {
    const mergedSpec = mergeImportSpec(match[1], requiredNames);
    return content.replace(match[0], `import { ${mergedSpec} } from "${match[2]}";`);
  }

  return `import { ${requiredNames.join(", ")} } from "${sourcePath}";\n${content}`;
}

async function ensureFileImport(filePath, importSpec, sourcePath) {
  if (!importSpec || !(await pathExists(filePath))) {
    return;
  }

  const content = await readFile(filePath);
  const nextContent = ensureNamedImport(content, importSpec, sourcePath);

  if (nextContent !== content) {
    await writeFile(filePath, nextContent);
  }
}

async function writeEnumConstants({ names, enumDefinitions }) {
  if (!enumDefinitions.length) {
    return;
  }

  const constantsPath = projectPath("src/modules", names.outputPath, "constants.ts");
  const existingContent = await pathExists(constantsPath)
    ? await readFile(constantsPath)
    : `export const ENTITY = "${names.entityConstValue}";\n`;
  const missingDefinitions = enumDefinitions.filter(
    (definition) => !hasExportedConst(existingContent, definition.constName),
  );

  if (!missingDefinitions.length) {
    return;
  }

  const enumConstantsBlock = buildEnumConstantsBlock(missingDefinitions);
  const nextContent = `${existingContent.trimEnd()}\n\n${enumConstantsBlock}\n`;

  await writeFile(constantsPath, nextContent);
}

async function writeEnumImports({
  names,
  schemaContext,
  hasCreateForm,
  hasUpdateForm,
}) {
  const moduleRoot = projectPath("src/modules", names.outputPath);
  const mapperImportSpec = buildConstantsImportSpec({
    fields: schemaContext.entityFields,
  });
  const validationImportSpec = buildConstantsImportSpec({
    fields: schemaContext.formFields,
  });
  const formEnumImportSpec = buildConstantsImportSpec({
    fields: schemaContext.formFields,
    enumValueMode: "direct",
  });
  const formImportSpec = formEnumImportSpec && buildConstantsImportSpec({
    fields: schemaContext.formFields,
    includeEntity: true,
    enumValueMode: "direct",
  });

  await ensureFileImport(path.join(moduleRoot, "mappers.ts"), mapperImportSpec, "./constants.ts");
  await ensureFileImport(path.join(moduleRoot, "validation.ts"), validationImportSpec, "./constants.ts");

  if (hasCreateForm) {
    await ensureFileImport(path.join(moduleRoot, "forms", "CreateForm.tsx"), formImportSpec, "../constants.ts");
  }
  if (hasUpdateForm) {
    await ensureFileImport(path.join(moduleRoot, "forms", "UpdateForm.tsx"), formImportSpec, "../constants.ts");
  }
}

async function writeExtraFormEnumImports({ names, extraActions }) {
  const formActions = extraActions.filter((action) => action.generationType === "form");

  for (const action of formActions) {
    const enumImportSpec = buildConstantsImportSpec({
      fields: action.requestFields,
      enumValueMode: "direct",
    });
    const importSpec = enumImportSpec && buildConstantsImportSpec({
      fields: action.requestFields,
      includeEntity: true,
      enumValueMode: "direct",
    });

    await ensureFileImport(
      projectPath("src/modules", names.outputPath, "forms", `${action.formName}.tsx`),
      importSpec,
      "../constants.ts",
    );
  }
}

function buildApiMethodNames(operations, extraMutations = []) {
  return [
    operations.list ? "list" : null,
    operations.single ? "single" : null,
    operations.create ? "create" : null,
    operations.update ? "update" : null,
    operations.delete ? "delete" : null,
    ...extraMutations.map((mutation) => mutation.apiMethodName),
  ].filter(Boolean);
}

async function appendApiMethods({ names, operations, serviceKey, extraMutations = [] }) {
  const apiPath = projectPath("src/modules", names.outputPath, "api.ts");
  if (!(await pathExists(apiPath))) {
    throw new Error(`Append uchun api.ts topilmadi: src/modules/${names.outputPath}/api.ts`);
  }

  const content = await readFile(apiPath);
  const missingMethodNames = buildApiMethodNames(operations, extraMutations).filter(
    (methodName) => !new RegExp(`\\b${methodName}\\s*\\(`).test(content),
  );

  if (!missingMethodNames.length) {
    return;
  }

  const methodsBlock = buildApiMethodsBlock({
    operations,
    serviceKey,
    valuesTypeName: names.valuesTypeName,
    extraMutations,
  }).trimEnd();
  const closingPattern = /\n} as const;\s*$/;
  const match = content.match(closingPattern);

  if (!match) {
    throw new Error(`api.ts formatini aniqlab bo'lmadi: src/modules/${names.outputPath}/api.ts`);
  }

  const beforeClose = content.slice(0, match.index).trimEnd();
  const separator = beforeClose.endsWith("{") ? "\n" : beforeClose.endsWith(",") ? "\n" : ",\n";
  const nextContent = `${beforeClose}${separator}${methodsBlock}\n} as const;\n`;

  await writeFile(apiPath, nextContent);
}

async function ensureTypesFile({ names }) {
  const typesPath = projectPath("src/modules", names.outputPath, "types.ts");
  if (await pathExists(typesPath)) {
    return;
  }

  await writeFile(
    typesPath,
    `export type Filter = {
  key: string;
  operation: ">" | ">=" | "<" | "<=" | "=" | "!=";
  value: string | number | string[];
};

export type Params = {
  page?: number;
  perPage?: number;
  sort?: {
    key?: string;
    direction?: "ASC" | "DESC";
  };
  filter?: Filter[];
};
`,
  );
}

async function ensureValidationFile({
  names,
  fields,
  validationConstantsImportSpec,
  hasMultiNameFormFields,
}) {
  const validationPath = projectPath("src/modules", names.outputPath, "validation.ts");
  const validationBlock = `${hasMultiNameFormFields ? 'import { getMultiNameSchema } from "@/common/mapppers.ts";\n' : ""}import { yup } from "@/services";
${validationConstantsImportSpec ? `import { ${validationConstantsImportSpec} } from "./constants.ts";\n` : ""}
export const ${names.validationName} = yup.object().shape({
${buildValidationFieldsBlock(fields)}
});

export type ${names.valuesTypeName} = yup.InferType<typeof ${names.validationName}>;
`;

  if (!(await pathExists(validationPath))) {
    await writeFile(validationPath, validationBlock);
    return;
  }

  const content = await readFile(validationPath);
  if (hasExportedConst(content, names.validationName)) {
    return;
  }

  await writeFile(validationPath, `${content.trimEnd()}\n\n${validationBlock}`);
}

function renderUseListHook({ names, defaultSortKey }) {
  return `import { useQuery } from "@tanstack/react-query";
import { get } from "radash";
import { Meta } from "@/common/mapppers.ts";
import type { IMeta } from "@/common/types.ts";
import { config } from "@/config.ts";
import { ${names.apiName} } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { ${names.mapperName}, type ${names.entityTypeName} } from "../mappers.ts";
import type { Params } from "../types.ts";

type UseListProps = {
  params?: Partial<Params>;
  enabled?: boolean;
  retry?: boolean | number;
};

type TData = {
  items: ${names.entityTypeName}[];
  meta: IMeta;
};

export function useList({ params = {}, enabled = true, retry = false }: UseListProps) {
  const initialData = { items: [], meta: Meta() } as TData;
  const defaultParams = {
    page: params?.page || 1,
    perPage: params?.perPage || config.list.perPage,
    sort: {
      key: params?.sort?.key || "${defaultSortKey}",
      direction: params?.sort?.direction || "DESC",
    },
    filter: (params?.filter || []).filter((i) => !!i.value),
  } satisfies Params;

  const { data = initialData, ...args } = useQuery({
    queryKey: [ENTITY, "list", defaultParams],
    async queryFn() {
      const { data } = await ${names.apiName}.list({
        params: defaultParams,
      });

      const items = (get<any[]>(data, "content") || []).map(${names.mapperName});
      const meta = Meta(get(data, "meta"));

      return {
        items,
        meta,
      };
    },
    initialData,
    enabled,
    retry,
  });

  return { ...data, ...args };
}
`;
}

function renderUseInfiniteListHook({ names, defaultSortKey }) {
  return `import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { get } from "radash";
import { Meta } from "@/common/mapppers.ts";
import { config } from "@/config.ts";
import { ${names.apiName} } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { ${names.mapperName}, type ${names.entityTypeName} } from "../mappers.ts";
import type { Params } from "../types.ts";

type QueryResult = {
  items: ${names.entityTypeName}[];
  meta: ReturnType<typeof Meta>;
};

type UseInfiniteListProps = {
  params?: Params;
  enabled?: boolean;
};

export const useInfiniteList = ({ params, enabled = true }: UseInfiniteListProps = {}) => {
  const initialData = {
    pages: [],
    pageParams: [],
  } as InfiniteData<QueryResult>;

  const paramsWithDefaults = {
    perPage: params?.perPage || config.list.perPage,
    sort: {
      key: params?.sort?.key || "${defaultSortKey}",
      direction: params?.sort?.direction || "DESC",
    },
    filter: (params?.filter || []).filter((i) => !!(i as any).value),
  };

  const { data = initialData, ...args } = useInfiniteQuery({
    queryKey: [ENTITY, "infinite-list", paramsWithDefaults],
    queryFn: async ({ pageParam = 1 }) => {
      const { data } = await ${names.apiName}.list({
        params: {
          ...paramsWithDefaults,
          page: pageParam as number,
        },
      });

      const items = (get<Array<any>>(data, "content") || []).map((item) => ${names.mapperName}(item));
      const meta = Meta(get(data as any, "meta"));

      return { items, meta };
    },
    initialPageParam: 1,
    initialData,
    enabled,
    getNextPageParam: (lastPage) =>
      lastPage.meta.current < lastPage.meta.totalPages ? lastPage.meta.current + 1 : undefined,
    retry: false,
  });

  return { ...args, data };
};
`;
}

function renderUseSingleHook({ names }) {
  return `import { useQuery } from "@tanstack/react-query";
import { ${names.apiName} } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { ${names.mapperName}, type ${names.entityTypeName} } from "../mappers.ts";

interface IProps {
  id: string;
}

type TData = {
  item: ${names.entityTypeName};
};

export function useSingle({ id }: IProps) {
  const initialData = { item: ${names.mapperName}() } as TData;

  const { data = initialData, ...args } = useQuery({
    queryKey: [ENTITY, "single", id],
    async queryFn() {
      const { data } = await ${names.apiName}.single({ id });

      return {
        item: ${names.mapperName}(data),
      };
    },
    initialData,
    enabled: !!id,
  });

  return { ...data, ...args };
}
`;
}

function renderUseDeleteHook({ names }) {
  return `import { type UseMutationOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ${names.apiName} } from "../api";
import { ENTITY } from "../constants";

interface UseDeleteProps
  extends Omit<UseMutationOptions<any, unknown, { id: string }>, "mutationFn" | "mutationKey"> {}

export function useDelete(mutationOptions?: UseDeleteProps) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [ENTITY, "delete"],
    mutationFn({ id }: { id: string }) {
      return ${names.apiName}.delete({ id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === ENTITY,
      });
    },
    ...mutationOptions,
  });
}
`;
}

function renderStandardForm({
  names,
  kind,
  createInitialValuesBlock,
  updateInitialValuesBlock,
  formConstantsImportSpec,
  hasMultiNameFormFields,
}) {
  const isCreate = kind === "create";
  const formName = isCreate ? "CreateForm" : "UpdateForm";
  const propsName = `${formName}Props`;
  const itemProp = isCreate ? "" : `  item: ${names.entityTypeName};\n`;
  const itemArg = isCreate ? "" : "item, ";
  const mutationKeyTail = isCreate ? '"create"' : '"update", item';
  const apiCall = isCreate
    ? `${names.apiName}.create({ values })`
    : `${names.apiName}.update({ id: item.id, values })`;
  const mapperInput = isCreate ? createInitialValuesBlock : updateInitialValuesBlock;

  return `import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
${hasMultiNameFormFields ? 'import { getMultiName } from "@/common/mapppers.ts";\n' : ""}import { ${names.apiName} } from "../api.ts";
import { ${formConstantsImportSpec} } from "../constants.ts";
import { ${names.mapperName}, type ${names.entityTypeName} } from "../mappers.ts";
import { ${names.validationName}, type ${names.valuesTypeName} } from "../validation.ts";

type ${propsName} = {
${itemProp}  children: (props: FormikProps<${names.valuesTypeName}>) => React.ReactNode;
} & Omit<UseMutationOptions<${names.entityTypeName}, unknown, ${names.valuesTypeName}>, "mutationFn" | "mutationKey">;

export function ${formName}({ ${itemArg}children, ...mutationOptions }: ${propsName}) {
  const { mutateAsync } = useMutation({
    mutationKey: [ENTITY, "form", ${mutationKeyTail}],
    async mutationFn(values: ${names.valuesTypeName}) {
      const { data } = await ${apiCall};

      return ${names.mapperName}(data);
    },
    ...mutationOptions,
  });

  return (
    <Formik<${names.valuesTypeName}>
      onSubmit={(values) => mutateAsync(values)}
      initialValues={{
${mapperInput}
      }}
      validationSchema={${names.validationName}}
      enableReinitialize
      validateOnChange
      validateOnBlur
    >
      {(props) => <Form>{children(props)}</Form>}
    </Formik>
  );
}
`;
}

async function appendPartialArtifact({
  names,
  serviceKey,
  finalOperations,
  extraActions,
  artifact,
  manifest,
  schemaContext,
  generatedSchemaContext,
  generatedExtraActions,
  hasMultiNameFormFields,
}) {
  await appendApiMethods({
    names,
    operations: finalOperations,
    serviceKey,
    extraMutations: generatedExtraActions,
  });

  await mergeFileLines(projectPath("src/modules", names.outputPath, "index.ts"), [
    artifact.mode === "hook" ? 'export * as Hooks from "./hooks";' : "",
    artifact.mode === "hook" && finalOperations.list ? 'export * as Types from "./types";' : "",
    artifact.mode === "form" ? 'export * as Forms from "./forms";' : "",
    artifact.mode === "mutation" ? 'export * as Mutations from "./mutations";' : "",
  ]);

  if (artifact.mode === "hook") {
    const hooksDir = projectPath("src/modules", names.outputPath, "hooks");
    await ensureDir(hooksDir);

    if (artifact.hookKind === "list") {
      await ensureTypesFile({ names });
      await writeFile(
        path.join(hooksDir, "useList.ts"),
        renderUseListHook({ names, defaultSortKey: manifest.defaultSortKey || "created_at" }),
      );
      await mergeFileLines(path.join(hooksDir, "index.ts"), ['export * from "./useList.ts";']);
    } else if (artifact.hookKind === "infinite-list") {
      await ensureTypesFile({ names });
      await writeFile(
        path.join(hooksDir, "useInfiniteList.ts"),
        renderUseInfiniteListHook({ names, defaultSortKey: manifest.defaultSortKey || "created_at" }),
      );
      await mergeFileLines(path.join(hooksDir, "index.ts"), ['export * from "./useInfiniteList.ts";']);
    } else if (artifact.hookKind === "single") {
      await writeFile(path.join(hooksDir, "useSingle.ts"), renderUseSingleHook({ names }));
      await mergeFileLines(path.join(hooksDir, "index.ts"), ['export * from "./useSingle.ts";']);
    } else if (artifact.hookKind === "delete") {
      await writeFile(path.join(hooksDir, "useDelete.ts"), renderUseDeleteHook({ names }));
      await mergeFileLines(path.join(hooksDir, "index.ts"), ['export * from "./useDelete.ts";']);
    }
  }

  if (artifact.mode === "form") {
    const standardFormKind = artifact.formKind;
    if (standardFormKind === "create" || standardFormKind === "update") {
      const formsDir = projectPath("src/modules", names.outputPath, "forms");
      await ensureDir(formsDir);
      const validationConstantsImportSpec = buildConstantsImportSpec({
        fields: generatedSchemaContext.formFields,
      });
      const formConstantsImportSpec = buildConstantsImportSpec({
        fields: generatedSchemaContext.formFields,
        includeEntity: true,
        enumValueMode: "direct",
      });

      await ensureValidationFile({
        names,
        fields: generatedSchemaContext.formFields,
        validationConstantsImportSpec,
        hasMultiNameFormFields,
      });
      await writeFile(
        path.join(formsDir, standardFormKind === "create" ? "CreateForm.tsx" : "UpdateForm.tsx"),
        renderStandardForm({
          names,
          kind: standardFormKind,
          createInitialValuesBlock: buildCreateInitialValuesBlock(generatedSchemaContext.formFields),
          updateInitialValuesBlock: buildUpdateInitialValuesBlock(
            generatedSchemaContext.formFields,
            generatedSchemaContext.entityFields,
            {},
          ),
          formConstantsImportSpec,
          hasMultiNameFormFields,
        }),
      );
      await mergeFileLines(path.join(formsDir, "index.ts"), [
        standardFormKind === "create"
          ? 'export * from "./CreateForm.tsx";'
          : 'export * from "./UpdateForm.tsx";',
      ]);
    } else {
      await writeExtraForms({
        names,
        extraActions: generatedExtraActions,
        apiName: names.apiName,
        mapperName: names.mapperName,
        entityTypeName: names.entityTypeName,
        hasCreateForm: false,
        hasUpdateForm: false,
      });
    }
  }

  if (artifact.mode === "mutation") {
    await writeExtraMutations({
      names,
      extraActions: generatedExtraActions,
      apiName: names.apiName,
    });
  }
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

async function findExistingModulePaths(rootPath = projectPath("src/modules"), depth = 0) {
  if (depth > 6 || !(await pathExists(rootPath))) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const hasModuleFiles = entries.some((entry) => entry.isFile() && entry.name === "api.ts");
  const candidates = [];

  if (hasModuleFiles) {
    candidates.push(path.relative(projectPath("src/modules"), rootPath).replace(/\\/g, "/"));
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    candidates.push(...(await findExistingModulePaths(path.join(rootPath, entry.name), depth + 1)));
  }

  return candidates;
}

async function promptExistingOutputPath(options = {}) {
  const candidates = (await findExistingModulePaths()).sort();

  if (!candidates.length) {
    return null;
  }

  const selected = await promptSelect(
    "Qaysi mavjud modulga append qilinsin?",
    [
      ...candidates.map((candidate) => ({
        label: candidate,
        value: candidate,
      })),
      {
        label: "Path'ni qo'lda kiritish",
        value: "custom",
      },
    ],
    0,
    options,
  );

  if (selected.value === "custom") {
    return promptText("Mavjud module output path (`src/modules/` dan keyingi qism)", "", options);
  }

  return selected.value;
}

async function promptOutputPathForGeneration(defaultPath, { isPartial = false } = {}, options = {}) {
  if (!isPartial) {
    const names = await promptAvailableOutputPath(defaultPath, options);
    return { names, appendToExisting: false };
  }

  const existingModules = await findExistingModulePaths();
  if (!existingModules.length) {
    const names = await promptAvailableOutputPath(defaultPath, options);
    return { names, appendToExisting: false };
  }

  const mode = await promptSelect(
    "Qayerga generatsiya qilinsin?",
    [
      { label: "Mavjud modulga append qilish", value: "append" },
      { label: "Yangi modul yaratish", value: "new" },
    ],
    0,
    options,
  );

  if (mode.value === "new") {
    const names = await promptAvailableOutputPath(defaultPath, options);
    return { names, appendToExisting: false };
  }

  const existingPath = await promptExistingOutputPath(options);
  const names = buildModuleNames(existingPath);
  const absoluteOutput = projectPath("src/modules", names.outputPath);
  if (!(await pathExists(absoluteOutput))) {
    throw new Error(`Mavjud module topilmadi: src/modules/${names.outputPath}`);
  }

  return { names, appendToExisting: true };
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
      key: "generationMode",
      interactive: true,
      run: async () => {
        state.generationMode = await promptSelect(
          "Nima generatsiya qilinsin?",
          [
            { label: "Full CRUD module", value: "full" },
            { label: "Bitta hook", value: "hook" },
            { label: "Bitta forma", value: "form" },
            { label: "Bitta mutation", value: "mutation" },
          ],
          0,
          promptOptions,
        );
      },
    },
    {
      key: "operations",
      interactive: true,
      run: async () => {
        if (state.generationMode.value !== "full") {
          const resolved = await resolveSingleArtifact(
            {
              artifactMode: state.generationMode.value,
              operations: state.operations,
              doc: state.doc,
            },
            promptOptions,
          );
          state.resolvedOperations = resolved.resolvedOperations;
          state.finalOperations = resolved.resolvedOperations;
          state.extraActions = resolved.extraActions;
          state.artifact = resolved.artifact;
          state.autoExtraActions = [];
          return;
        }

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
        if (state.generationMode.value !== "full") {
          if (!hasGeneratableOperations(state.finalOperations, state.extraActions)) {
            throw new Error("Tanlangan artifact uchun generatsiya qilsa bo'ladigan operation topilmadi");
          }
          return;
        }

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
        const result = await promptOutputPathForGeneration(
          buildSuggestedOutputPath(state.tag.value, state.finalOperations),
          { isPartial: state.generationMode.value !== "full" },
          promptOptions,
        );
        state.names = result.names;
        state.appendToExisting = result.appendToExisting;
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
    artifact,
    appendToExisting,
  } = await runCrudWizard({ config, manifest });
  const hasCreateForm = Boolean(finalOperations.create && schemaContext.formFields.length);
  const hasUpdateForm = Boolean(finalOperations.update && schemaContext.formFields.length);
  const hasList = Boolean(finalOperations.list);
  const hasSingle = Boolean(finalOperations.single);
  const hasCreate = Boolean(finalOperations.create);
  const hasUpdate = Boolean(finalOperations.update);
  const hasDelete = Boolean(finalOperations.delete);
  const hasUseList = hasList && artifact?.hookKind !== "infinite-list";
  const hasUseInfiniteList = hasList && artifact?.hookKind !== "list";
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

  if (appendToExisting) {
    await appendPartialArtifact({
      names,
      serviceKey,
      finalOperations,
      extraActions,
      artifact,
      manifest,
      schemaContext,
      generatedSchemaContext,
      generatedExtraActions,
      hasMultiNameFormFields,
    });
  } else {
    runHygen({
      ...names,
      serviceKey,
      defaultSortKey: manifest.defaultSortKey || "created_at",
      hasList,
      hasSingle,
      hasCreate,
      hasUpdate,
      hasDelete,
      hasUseList,
      hasUseInfiniteList,
      hasMutations,
      hasCustomForms,
      hasCreateForm,
      hasUpdateForm,
      hasMultiNameEntityFields,
      hasMultiNameFormFields,
      enumConstantsBlock: "",
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
      skipUseList: hasUseList ? "false" : "true",
      skipUseSingle: hasSingle ? "false" : "true",
      skipUseDelete: hasDelete ? "false" : "true",
      skipUseInfiniteList: hasUseInfiniteList ? "false" : "true",
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
  }
  await writeEnumConstants({
    names,
    enumDefinitions: enumContext.enumDefinitions,
  });
  await writeEnumImports({
    names,
    schemaContext: generatedSchemaContext,
    hasCreateForm,
    hasUpdateForm,
  });
  await writeExtraFormEnumImports({
    names,
    extraActions: generatedExtraActions,
  });

  console.log(`\nCRUD modul ${appendToExisting ? "yangilandi" : "yaratildi"}: src/modules/${names.outputPath}`);
}

await main()
  .catch((error) => {
    console.error(`\nXatolik: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closePrompt();
  });
