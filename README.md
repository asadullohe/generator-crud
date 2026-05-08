# Generator CRUD

`generator-crud` Swagger/OpenAPI hujjatidan `src/modules/...` uchun CRUD modul generatsiya qiladi.

## O'rnatish

```bash
pnpm add -D @asadullohe/generator-crud
```

CLI sifatida ishlatish:

```bash
pnpm exec generator-crud template
pnpm exec generator-crud crud
```

Yoki local package ichida:

```bash
pnpm template
pnpm crud
```

## Ishlatish

Generator har doim target loyiha root'idan ishga tushiriladi. Ya'ni `cwd` sifatida CRUD generatsiya qilinadigan repo turishi kerak.

Misol:

```bash
cd /path/to/target-project
pnpm exec generator-crud template
pnpm exec generator-crud crud
```

## Template oqimi

`template` command:

- source patternni project ichidan scan qiladi
- topilgan patternlardan birini tanlatadi yoki custom path qabul qiladi
- template nomini so'raydi
- template'ni saqlaydi
- active template'ni yangilaydi

Saqlanadigan joylar:

- saqlangan template'lar: `_templates/crud-module-store/<templateName>`
- active template: `_templates/crud-module`

`crud` command:

- saqlangan template'lar orasidan bittasini tanlatadi
- Swagger/OpenAPI URL so'raydi
- auth kerak bo'lsa auth ma'lumotlarini oladi
- tag va operationlarni tanlatadi
- `src/modules/...` ichiga CRUD modul generatsiya qiladi

## Qo'llab-quvvatlanadigan holatlar

- `list`, `single`, `create`, `update`, `delete`
- `sync`, `upload`, va boshqa custom mutation/form operationlar
- multilingual fieldlar uchun `getMultiName` / `getMultiNameSchema`
- relation mapper suggestion:
  registry, module scan, yoki manual mapper path orqali

## Publish

Package publish uchun kerakli fayllar `files` orqali cheklangan:

- `bin`
- `lib`
- `_templates`
- `build-template.mjs`
- `generate-crud.mjs`
- `README.md`
