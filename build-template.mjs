import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TEMPLATE_NAME, DEFAULT_TEMPLATE_SOURCE } from "./lib/constants.mjs";
import { buildNamedCrudTemplate, listSavedTemplates } from "./lib/template-builder.mjs";
import { closePrompt, promptSelect, promptText } from "./lib/prompt.mjs";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".idea",
  ".vscode",
  "_templates",
  "coverage",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function findTemplateCandidates(rootPath, depth = 0) {
  if (depth > 5) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const candidates = [];

  const hasMappers = entries.some((entry) => entry.isFile() && entry.name === "mappers.ts");
  const hasHooksDir = entries.some((entry) => entry.isDirectory() && entry.name === "hooks");

  if (hasMappers && hasHooksDir) {
    candidates.push(path.relative(process.cwd(), rootPath));
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    candidates.push(...(await findTemplateCandidates(path.join(rootPath, entry.name), depth + 1)));
  }

  return candidates;
}

async function chooseSourcePath(cliSourcePath) {
  if (cliSourcePath) {
    return cliSourcePath;
  }

  const candidates = unique(await findTemplateCandidates(process.cwd()));
  const defaultIndex = Math.max(candidates.indexOf(DEFAULT_TEMPLATE_SOURCE), 0);
  const sourceMode = await promptSelect("Template source qayerdan olinadi?", [
    {
      label: "Topilgan patternlardan tanlash",
      value: "candidate",
    },
    {
      label: "Path'ni qo'lda kiritish",
      value: "custom",
    },
  ]);

  if (sourceMode.value === "custom" || candidates.length === 0) {
    return promptText("Template source path", DEFAULT_TEMPLATE_SOURCE);
  }

  const selected = await promptSelect(
    "Template source path tanlang",
    candidates.map((candidate) => ({
      label: candidate,
      value: candidate,
    })),
    defaultIndex,
  );

  return selected.value;
}

async function chooseTemplateName(cliTemplateName, sourcePath) {
  if (cliTemplateName) {
    return cliTemplateName;
  }

  const savedTemplates = await listSavedTemplates();
  const defaultName =
    sourcePath === DEFAULT_TEMPLATE_SOURCE
      ? DEFAULT_TEMPLATE_NAME
      : path.basename(sourcePath).replace(/[^A-Za-z0-9_-]+/g, "-") || DEFAULT_TEMPLATE_NAME;

  const selectedMode = await promptSelect("Template nomini tanlang", [
    {
      label: `Yangi nom kiritish (${defaultName})`,
      value: "new",
    },
    ...(savedTemplates.length
      ? [
          {
            label: "Mavjud template ustiga yozish",
            value: "existing",
          },
        ]
      : []),
  ]);

  if (selectedMode.value === "existing") {
    const selected = await promptSelect(
      "Qaysi template yangilanadi?",
      savedTemplates.map((template) => ({
        label: `${template.templateName} (${template.sourcePath})`,
        value: template.templateName,
      })),
    );
    return selected.value;
  }

  return promptText("Template nomi", defaultName);
}

async function main() {
  const cliSourcePath = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1];
  const cliTemplateName = process.argv.find((arg) => arg.startsWith("--name="))?.split("=")[1];
  const sourcePath = await chooseSourcePath(cliSourcePath);
  const templateName = await chooseTemplateName(cliTemplateName, sourcePath);
  const result = await buildNamedCrudTemplate({ sourcePath, templateName });

  console.log(`\nTemplate yaratildi:
- name: ${result.templateName}
- source: ${result.sourcePath}
- stored: ${result.templateRoot}
- active: ${result.activeTemplateRoot}
- manifest: ${result.manifestPath}`);
}

await main()
  .catch((error) => {
    console.error(`\nXatolik: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closePrompt();
  });
