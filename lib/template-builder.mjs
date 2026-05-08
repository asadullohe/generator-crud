import path from "node:path";
import {
  ACTIVE_TEMPLATE_ACTION_ROOT,
  ACTIVE_TEMPLATE_MANIFEST,
  ACTIVE_TEMPLATE_ROOT,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_SOURCE,
  getStoredTemplateActionRoot,
  getStoredTemplateManifest,
  getStoredTemplateRoot,
  packagePath,
  STANDARD_TEMPLATE_FILES,
  TEMPLATE_CURRENT_REF,
  TEMPLATE_STORE_ROOT,
} from "./constants.mjs";
import { copyDir, emptyDir, listDirs, pathExists, projectPath, readFile, removePath, writeFile } from "./fs-utils.mjs";

async function extractTemplateDefaults(sourcePath) {
  const absoluteSource = projectPath(sourcePath);
  const useListPath = path.join(absoluteSource, "hooks", "useList.ts");
  const defaults = {
    sourcePath,
    defaultSortKey: "created_at",
    templateFiles: STANDARD_TEMPLATE_FILES,
  };

  if (await pathExists(useListPath)) {
    const content = await readFile(useListPath);
    const match = content.match(/key:\s*params\?\.sort\?\.key\s*\|\|\s*"([^"]+)"/);
    if (match?.[1]) {
      defaults.defaultSortKey = match[1];
    }
  }

  return defaults;
}

function templateFile(outputPath, content) {
  return `---\nto: src/modules/<%= outputPath %>/${outputPath}\n---\n${content}`;
}

function rootTemplateFile(outputFile, content) {
  return `---\nto: src/modules/<%= outputPath %>/${outputFile}\n---\n${content}`;
}

function conditionalTemplateFile(outputPath, skipVariable, content) {
  return `---\nto: src/modules/<%= outputPath %>/${outputPath}\nskip_if: <%= ${skipVariable} %>\n---\n${content}`;
}

function renderApiTemplate() {
  return rootTemplateFile(
    "api.ts",
    `import { config } from "@/config.ts";
import { http } from "@/services";
<% if (hasList === "true") { %>
import type { Params } from "./types.ts";
<% } %>
<% if (hasCreate === "true" || hasUpdate === "true") { %>
import type { <%= valuesTypeName %> } from "./validation.ts";
<% } %>

export const <%= apiName %> = {
<%- apiMethodsBlock %>
} as const;
`,
  );
}

function renderConstantsTemplate() {
  return rootTemplateFile(
    "constants.ts",
    `export const ENTITY = "<%= entityConstValue %>";
`,
  );
}

function renderTypesTemplate() {
  return conditionalTemplateFile(
    "types.ts",
    "skipTypes",
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

function renderMappersTemplate() {
  return rootTemplateFile(
    "mappers.ts",
    `import { get } from "radash";
<% if (hasMultiNameEntityFields === "true") { %>
import { getMultiName } from "@/common/mapppers.ts";
<% } %>
<% if (mapperImportsBlock) { %>
<%- mapperImportsBlock %>
<% } %>

export const <%= mapperName %> = (item?: any) => {
  return {
<%- mapperFieldsBlock %>
  };
};

export type <%= entityTypeName %> = ReturnType<typeof <%= mapperName %>>;
`,
  );
}

function renderValidationTemplate() {
  return conditionalTemplateFile(
    "validation.ts",
    "skipValidation",
    `<% if (hasMultiNameFormFields === "true") { %>import { getMultiNameSchema } from "@/common/mapppers.ts";
<% } %>
import { yup } from "@/services";

export const <%= validationName %> = yup.object().shape({
<%- validationFieldsBlock %>
});

export type <%= valuesTypeName %> = yup.InferType<typeof <%= validationName %>>;
`,
  );
}

function renderIndexTemplate() {
  return rootTemplateFile(
    "index.ts",
    `export * as Constants from "./constants";
<% if (hasList === "true") { %>export * as Types from "./types";
<% } %>
export * as Hooks from "./hooks";
<% if (hasCreateForm === "true" || hasUpdateForm === "true" || hasCustomForms === "true") { %>export * as Forms from "./forms";
<% } %>
<% if (hasMutations === "true") { %>export * as Mutations from "./mutations";
<% } %>
`,
  );
}

function renderFormsIndexTemplate() {
  return conditionalTemplateFile(
    "forms/index.ts",
    "skipFormsIndex",
    `<% if (hasCreateForm === "true") { %>export * from "./CreateForm.tsx";
<% } %>
<% if (hasUpdateForm === "true") { %>export * from "./UpdateForm.tsx";
<% } %>
`,
  );
}

function renderCreateFormTemplate() {
  return conditionalTemplateFile(
    "forms/CreateForm.tsx",
    "skipCreateForm",
    `import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
<% if (hasMultiNameFormFields === "true") { %>
import { getMultiName } from "@/common/mapppers.ts";
<% } %>
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import { <%= validationName %>, type <%= valuesTypeName %> } from "../validation.ts";

type CreateFormProps = {
  children: (props: FormikProps<<%= valuesTypeName %>>) => React.ReactNode;
} & Omit<UseMutationOptions<<%= entityTypeName %>, unknown, <%= valuesTypeName %>>, "mutationFn" | "mutationKey">;

export function CreateForm({ children, ...mutationOptions }: CreateFormProps) {
  const { mutateAsync } = useMutation({
    mutationKey: [ENTITY, "form", "create"],
    async mutationFn(values: <%= valuesTypeName %>) {
      const { data } = await <%= apiName %>.create({ values });

      return <%= mapperName %>(data);
    },
    ...mutationOptions,
  });

  return (
    <Formik<<%= valuesTypeName %>>
      onSubmit={(values) => mutateAsync(values)}
      initialValues={{
<%- createInitialValuesBlock %>
      }}
      validationSchema={<%= validationName %>}
      enableReinitialize
      validateOnChange
      validateOnBlur
    >
      {(props) => <Form>{children(props)}</Form>}
    </Formik>
  );
}
`,
  );
}

function renderUpdateFormTemplate() {
  return conditionalTemplateFile(
    "forms/UpdateForm.tsx",
    "skipUpdateForm",
    `import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
<% if (hasMultiNameFormFields === "true") { %>
import { getMultiName } from "@/common/mapppers.ts";
<% } %>
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import { <%= validationName %>, type <%= valuesTypeName %> } from "../validation.ts";

type UpdateFormProps = {
  item: <%= entityTypeName %>;
  children: (props: FormikProps<<%= valuesTypeName %>>) => React.ReactNode;
} & Omit<UseMutationOptions<<%= entityTypeName %>, unknown, <%= valuesTypeName %>>, "mutationFn" | "mutationKey">;

export function UpdateForm({ item, children, ...mutationOptions }: UpdateFormProps) {
  const { mutateAsync } = useMutation({
    mutationKey: [ENTITY, "form", "update", item],
    async mutationFn(values: <%= valuesTypeName %>) {
      const { data } = await <%= apiName %>.update({ id: item.id, values });

      return <%= mapperName %>(data);
    },
    ...mutationOptions,
  });

  return (
    <Formik<<%= valuesTypeName %>>
      onSubmit={(values) => mutateAsync(values)}
      initialValues={{
<%- updateInitialValuesBlock %>
      }}
      validationSchema={<%= validationName %>}
      enableReinitialize
      validateOnChange
      validateOnBlur
    >
      {(props) => <Form>{children(props)}</Form>}
    </Formik>
  );
}
`,
  );
}

function renderHooksIndexTemplate() {
  return templateFile(
    "hooks/index.ts",
    `<% if (hasDelete === "true") { %>export * from "./useDelete.ts";
<% } %>
<% if (hasList === "true") { %>
export * from "./useInfiniteList.ts";
export * from "./useList.ts";
<% } %>
<% if (hasSingle === "true") { %>
export * from "./useSingle.ts";
<% } %>
`,
  );
}

function renderUseListTemplate() {
  return conditionalTemplateFile(
    "hooks/useList.ts",
    "skipUseList",
    `import { useQuery } from "@tanstack/react-query";
import { get } from "radash";
import { Meta } from "@/common/mapppers.ts";
import type { IMeta } from "@/common/types.ts";
import { config } from "@/config.ts";
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import type { Params } from "../types.ts";

type UseListProps = {
  params?: Partial<Params>;
  enabled?: boolean;
  retry?: boolean | number;
};

type TData = {
  items: <%= entityTypeName %>[];
  meta: IMeta;
};

export function useList({ params = {}, enabled = true, retry = false }: UseListProps) {
  const initialData = { items: [], meta: Meta() } as TData;
  const defaultParams = {
    page: params?.page || 1,
    perPage: params?.perPage || config.list.perPage,
    sort: {
      key: params?.sort?.key || "<%= defaultSortKey %>",
      direction: params?.sort?.direction || "DESC",
    },
    filter: (params?.filter || []).filter((i) => !!i.value),
  } satisfies Params;

  const { data = initialData, ...args } = useQuery({
    queryKey: [ENTITY, "list", defaultParams],
    async queryFn() {
      const { data } = await <%= apiName %>.list({
        params: defaultParams,
      });

      const items = (get<any[]>(data, "content") || []).map(<%= mapperName %>);
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
`,
  );
}

function renderUseSingleTemplate() {
  return conditionalTemplateFile(
    "hooks/useSingle.ts",
    "skipUseSingle",
    `import { useQuery } from "@tanstack/react-query";
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";

interface IProps {
  id: string;
}

type TData = {
  item: <%= entityTypeName %>;
};

export function useSingle({ id }: IProps) {
  const initialData = { item: <%= mapperName %>() } as TData;

  const { data = initialData, ...args } = useQuery({
    queryKey: [ENTITY, "single", id],
    async queryFn() {
      const { data } = await <%= apiName %>.single({ id });

      return {
        item: <%= mapperName %>(data),
      };
    },
    initialData,
    enabled: !!id,
  });

  return { ...data, ...args };
}
`,
  );
}

function renderUseDeleteTemplate() {
  return conditionalTemplateFile(
    "hooks/useDelete.ts",
    "skipUseDelete",
    `import { type UseMutationOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { <%= apiName %> } from "../api";
import { ENTITY } from "../constants";

interface UseDeleteProps
  extends Omit<UseMutationOptions<any, unknown, { id: string }>, "mutationFn" | "mutationKey"> {}

export function useDelete(mutationOptions?: UseDeleteProps) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [ENTITY, "delete"],
    mutationFn({ id }: { id: string }) {
      return <%= apiName %>.delete({ id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === ENTITY,
      });
    },
    ...mutationOptions,
  });
}
`,
  );
}

function renderUseInfiniteListTemplate() {
  return conditionalTemplateFile(
    "hooks/useInfiniteList.ts",
    "skipUseInfiniteList",
    `import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { get } from "radash";
import { Meta } from "@/common/mapppers.ts";
import { config } from "@/config.ts";
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import type { Params } from "../types.ts";

type QueryResult = {
  items: <%= entityTypeName %>[];
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
      key: params?.sort?.key || "<%= defaultSortKey %>",
      direction: params?.sort?.direction || "DESC",
    },
    filter: (params?.filter || []).filter((i) => !!(i as any).value),
  };

  const { data = initialData, ...args } = useInfiniteQuery({
    queryKey: [ENTITY, "infinite-list", paramsWithDefaults],
    queryFn: async ({ pageParam = 1 }) => {
      const { data } = await <%= apiName %>.list({
        params: {
          ...paramsWithDefaults,
          page: pageParam as number,
        },
      });

      const items = (get<Array<any>>(data, "content") || []).map((item) => <%= mapperName %>(item));
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
`,
  );
}

function renderTemplateFiles() {
  return [
    ["api.ts.ejs.t", renderApiTemplate()],
    ["constants.ts.ejs.t", renderConstantsTemplate()],
    ["types.ts.ejs.t", renderTypesTemplate()],
    ["mappers.ts.ejs.t", renderMappersTemplate()],
    ["validation.ts.ejs.t", renderValidationTemplate()],
    ["index.ts.ejs.t", renderIndexTemplate()],
    ["forms__index.ts.ejs.t", renderFormsIndexTemplate()],
    ["forms__CreateForm.tsx.ejs.t", renderCreateFormTemplate()],
    ["forms__UpdateForm.tsx.ejs.t", renderUpdateFormTemplate()],
    ["hooks__index.ts.ejs.t", renderHooksIndexTemplate()],
    ["hooks__useList.ts.ejs.t", renderUseListTemplate()],
    ["hooks__useSingle.ts.ejs.t", renderUseSingleTemplate()],
    ["hooks__useDelete.ts.ejs.t", renderUseDeleteTemplate()],
    ["hooks__useInfiniteList.ts.ejs.t", renderUseInfiniteListTemplate()],
  ];
}

export async function buildCrudTemplate({ sourcePath = DEFAULT_TEMPLATE_SOURCE } = {}) {
  return buildNamedCrudTemplate({ sourcePath, templateName: DEFAULT_TEMPLATE_NAME });
}

export async function seedBundledDefaultTemplate() {
  const bundledTemplateRoot = packagePath(getStoredTemplateRoot(DEFAULT_TEMPLATE_NAME));
  const bundledManifestPath = packagePath(getStoredTemplateManifest(DEFAULT_TEMPLATE_NAME));

  if (!(await pathExists(bundledTemplateRoot)) || !(await pathExists(bundledManifestPath))) {
    return null;
  }

  await copyDir(bundledTemplateRoot, projectPath(getStoredTemplateRoot(DEFAULT_TEMPLATE_NAME)));
  return activateTemplate(DEFAULT_TEMPLATE_NAME);
}

export async function listSavedTemplates() {
  const templateNames = await listDirs(projectPath(TEMPLATE_STORE_ROOT));
  const templates = [];

  for (const templateName of templateNames) {
    const manifestPath = projectPath(getStoredTemplateManifest(templateName));
    if (!(await pathExists(manifestPath))) {
      continue;
    }

    templates.push(JSON.parse(await readFile(manifestPath)));
  }

  return templates.sort((left, right) => {
    if (left.templateName === DEFAULT_TEMPLATE_NAME) {
      return -1;
    }

    if (right.templateName === DEFAULT_TEMPLATE_NAME) {
      return 1;
    }

    return left.templateName.localeCompare(right.templateName);
  });
}

export async function getCurrentTemplateName() {
  const currentPath = projectPath(TEMPLATE_CURRENT_REF);
  if (!(await pathExists(currentPath))) {
    return null;
  }

  const current = JSON.parse(await readFile(currentPath));
  return current.templateName || null;
}

export async function activateTemplate(templateName) {
  const storedRoot = projectPath(getStoredTemplateRoot(templateName));
  const storedManifestPath = projectPath(getStoredTemplateManifest(templateName));

  if (!(await pathExists(storedRoot)) || !(await pathExists(storedManifestPath))) {
    throw new Error(`Saqlangan template topilmadi: ${templateName}`);
  }

  await emptyDir(projectPath(ACTIVE_TEMPLATE_ROOT));
  await copyDir(storedRoot, projectPath(ACTIVE_TEMPLATE_ROOT));
  await writeFile(
    projectPath(TEMPLATE_CURRENT_REF),
    JSON.stringify({ templateName, activatedAt: new Date().toISOString() }, null, 2),
  );

  return JSON.parse(await readFile(projectPath(ACTIVE_TEMPLATE_MANIFEST)));
}

export async function buildNamedCrudTemplate({
  sourcePath = DEFAULT_TEMPLATE_SOURCE,
  templateName = DEFAULT_TEMPLATE_NAME,
} = {}) {
  const absoluteSource = projectPath(sourcePath);
  if (!(await pathExists(absoluteSource))) {
    throw new Error(`Source module topilmadi: ${sourcePath}`);
  }

  const defaults = await extractTemplateDefaults(sourcePath);
  const storedTemplateRoot = projectPath(getStoredTemplateActionRoot(templateName));
  const storedManifestPath = projectPath(getStoredTemplateManifest(templateName));

  await emptyDir(storedTemplateRoot);

  for (const [filename, content] of renderTemplateFiles()) {
    await writeFile(path.join(storedTemplateRoot, filename), content);
  }

  await writeFile(
    storedManifestPath,
    JSON.stringify(
      {
        ...defaults,
        templateName,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  await activateTemplate(templateName);

  return {
    sourcePath,
    templateName,
    templateRoot: projectPath(getStoredTemplateRoot(templateName)),
    activeTemplateRoot: projectPath(ACTIVE_TEMPLATE_ROOT),
    manifestPath: storedManifestPath,
  };
}
