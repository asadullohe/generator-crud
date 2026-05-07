---
to: src/modules/<%= outputPath %>/index.ts
---
export * as Constants from "./constants";
<% if (hasList === "true") { %>export * as Types from "./types";
<% } %>
export * as Hooks from "./hooks";
<% if (hasCreateForm === "true" || hasUpdateForm === "true" || hasCustomForms === "true") { %>export * as Forms from "./forms";
<% } %>
<% if (hasMutations === "true") { %>export * as Mutations from "./mutations";
<% } %>
