import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

let rl;

export class PromptBackError extends Error {
  constructor() {
    super("Ortga qaytish");
    this.name = "PromptBackError";
  }
}

function getInterface() {
  if (!rl) {
    rl = readline.createInterface({ input, output });
  }

  return rl;
}

export async function promptText(message, defaultValue = "", options = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const backHint = options.allowBack ? " (:back - ortga)" : "";
  const answer = (await getInterface().question(`${message}${suffix}${backHint}: `)).trim();

  if (options.allowBack && answer === ":back") {
    throw new PromptBackError();
  }

  if (!answer && defaultValue) {
    return defaultValue;
  }

  if (!answer) {
    return promptText(message, defaultValue, options);
  }

  return answer;
}

export async function promptConfirm(message, defaultValue = true, options = {}) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const backHint = options.allowBack ? " (:back - ortga)" : "";
  const answer = (await getInterface().question(`${message}${suffix}${backHint}: `)).trim().toLowerCase();

  if (options.allowBack && answer === ":back") {
    throw new PromptBackError();
  }

  if (!answer) {
    return defaultValue;
  }

  if (["y", "yes", "ha"].includes(answer)) {
    return true;
  }

  if (["n", "no", "yo'q", "yoq"].includes(answer)) {
    return false;
  }

  return promptConfirm(message, defaultValue, options);
}

export async function promptSelect(message, options, defaultIndex = 0, promptOptions = {}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`Tanlash uchun variant topilmadi: ${message}`);
  }

  console.log(`\n${message}`);
  if (promptOptions.allowBack) {
    console.log("  0. Ortga qaytish");
  }
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? "*" : " ";
    console.log(`${marker} ${index + 1}. ${option.label}`);
    if (option.hint) {
      console.log(`   ${option.hint}`);
    }
  });

  const answer = await getInterface().question(`Variant raqami [${defaultIndex + 1}]: `);
  const normalized = answer.trim();

  if (promptOptions.allowBack && normalized === "0") {
    throw new PromptBackError();
  }

  if (!normalized) {
    return options[defaultIndex];
  }

  const index = Number(normalized) - 1;
  if (Number.isInteger(index) && options[index]) {
    return options[index];
  }

  return promptSelect(message, options, defaultIndex, promptOptions);
}

export function closePrompt() {
  if (rl) {
    rl.close();
    rl = undefined;
  }
}
