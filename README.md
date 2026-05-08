# Generator CRUD

`generator-crud` Swagger/OpenAPI hujjatidan `src/modules/...` uchun CRUD modul generatsiya qiladi.

## O'rnatish

```bash
pnpm add -D @asadullohe/generator-crud
```

Install qilinganda target project root'ida `generate-crud.config.json` default qiymatlar bilan yaratiladi. Agar package manager install scriptlarini o'tkazib yuborsa, `pnpm generate-crud` birinchi ishga tushganda ham config faylni yaratadi. Mavjud fayl ustidan yozilmaydi.

Target project `package.json`iga script qo'shish:

```json
{
  "scripts": {
    "generate-crud": "generator-crud crud",
    "crud:generate-template": "generator-crud template"
  }
}
```

CRUD generatsiya qilish:

```bash
pnpm generate-crud
```

`standard` template package ichida bor. Oddiy CRUD generatsiya uchun avval `template` command ishlatish shart emas.

Script qo'shmasdan to'g'ridan-to'g'ri ishlatish ham mumkin:

```bash
pnpm exec generator-crud crud
```

Config faylni qo'lda yaratish kerak bo'lsa:

```bash
pnpm exec generator-crud init
```

## Ishlatish

Generator har doim target loyiha root'idan ishga tushiriladi. Ya'ni `cwd` sifatida CRUD generatsiya qilinadigan repo turishi kerak.

Swagger URL va auth ma'lumotlarini har safar kiritmaslik uchun target project root'ida `generate-crud.config.json` yaratish mumkin:

```json
{
  "swaggerUrl": "",
  "auth": {
    "mode": "none"
  }
}
```

Keyin:

```bash
SWAGGER_USERNAME=login SWAGGER_PASSWORD=parol pnpm generate-crud
```

Login/parolni configga bevosita yozish ham mumkin, lekin repositoryga commit qilinadigan projectlarda env ishlatish tavsiya qilinadi.

`serviceKey` yozish shart emas. Generator Swagger/OpenAPI `servers` ro'yxatini chiqaradi, tanlangan server `/service-name` bo'lsa `serviceKey` avtomatik `serviceName` bo'ladi. Agar majburan berish kerak bo'lsa:

```json
{
  "serviceKey": "serviceName"
}
```

Auth `mode` variantlari:

Auth yo'q:

```json
{
  "auth": {
    "mode": "none"
  }
}
```

Basic auth:

```json
{
  "auth": {
    "mode": "basic",
    "usernameEnv": "SWAGGER_USERNAME",
    "passwordEnv": "SWAGGER_PASSWORD"
  }
}
```

Bearer token:

```json
{
  "auth": {
    "mode": "bearer",
    "tokenEnv": "SWAGGER_TOKEN"
  }
}
```

Login endpoint orqali token olish:

```json
{
  "auth": {
    "mode": "login",
    "authUrl": "https://example.com/auth/login",
    "authMethod": "POST",
    "usernameEnv": "SWAGGER_USERNAME",
    "passwordEnv": "SWAGGER_PASSWORD",
    "loginField": "username",
    "passwordField": "password",
    "tokenPath": "accessToken"
  }
}
```

Misol:

```bash
cd /path/to/target-project
pnpm generate-crud
```

Custom module pattern asosida yangi template saqlash kerak bo'lsa:

```bash
pnpm crud:generate-template
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

- agar projectda template bo'lmasa, package ichidagi `standard` template'ni avtomatik aktiv qiladi
- bir nechta saqlangan template bo'lsa, qaysi biri bilan ishlashni tanlatadi
- configda bo'lmasa Swagger/OpenAPI URL so'raydi
- configda bo'lmasa auth ma'lumotlarini oladi
- tag va operationlarni tanlatadi
- `src/modules/...` ichiga CRUD modul generatsiya qiladi

Qo'llab-quvvatlanadigan config fayllar:

- `generate-crud.config.json`
- `generate-crud.config.mjs`
- `generate-crud.config.js`

Custom config path berish:

```bash
pnpm generate-crud --config=./crud.config.json
```

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
