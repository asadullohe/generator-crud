#!/usr/bin/env node

const command = process.argv[2];

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(`Generator CRUD

Foydalanish:
  generator-crud crud
  generator-crud template
`);
  process.exit(0);
}

if (command === "crud") {
  await import("../generate-crud.mjs");
  process.exit(process.exitCode || 0);
}

if (command === "template") {
  await import("../build-template.mjs");
  process.exit(process.exitCode || 0);
}

console.error(`Noma'lum command: ${command}`);
process.exit(1);
