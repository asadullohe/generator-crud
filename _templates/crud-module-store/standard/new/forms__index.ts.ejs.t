---
to: src/modules/<%= outputPath %>/forms/index.ts
skip_if: <%= skipFormsIndex %>
---
<% if (hasCreateForm === "true") { %>export * from "./CreateForm.tsx";
<% } %>
<% if (hasUpdateForm === "true") { %>export * from "./UpdateForm.tsx";
<% } %>
