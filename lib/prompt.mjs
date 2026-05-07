import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

let rl;

function getInterface() {
  if (!rl) {
    rl = readline.createInterface({ input, output });
  }

  return rl;
}

export async function promptText(message, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await getInterface().question(`${message}${suffix}: `)).trim();

  if (!answer && defaultValue) {
    return defaultValue;
  }

  if (!answer) {
    return promptText(message, defaultValue);
  }

  return answer;
}

export async function promptConfirm(message, defaultValue = true) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await getInterface().question(`${message}${suffix}: `)).trim().toLowerCase();

  if (!answer) {
    return defaultValue;
  }

  if (["y", "yes", "ha"].includes(answer)) {
    return true;
  }

  if (["n", "no", "yo'q", "yoq"].includes(answer)) {
    return false;
  }

  return promptConfirm(message, defaultValue);
}

export async function promptSelect(message, options, defaultIndex = 0) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`Tanlash uchun variant topilmadi: ${message}`);
  }

  console.log(`\n${message}`);
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? "*" : " ";
    console.log(`${marker} ${index + 1}. ${option.label}`);
    if (option.hint) {
      console.log(`   ${option.hint}`);
    }
  });

  const answer = await getInterface().question(`Variant raqami [${defaultIndex + 1}]: `);
  const normalized = answer.trim();

  if (!normalized) {
    return options[defaultIndex];
  }

  const index = Number(normalized) - 1;
  if (Number.isInteger(index) && options[index]) {
    return options[index];
  }

  return promptSelect(message, options, defaultIndex);
}

export function closePrompt() {
  if (rl) {
    rl.close();
    rl = undefined;
  }
}

