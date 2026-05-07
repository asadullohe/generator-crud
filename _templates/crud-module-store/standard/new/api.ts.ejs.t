---
to: src/modules/<%= outputPath %>/api.ts
---
import { config } from "@/config.ts";
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
