---
to: src/modules/<%= outputPath %>/hooks/index.ts
---
<% if (hasDelete === "true") { %>export * from "./useDelete.ts";
<% } %>
<% if (hasList === "true") { %>
export * from "./useInfiniteList.ts";
export * from "./useList.ts";
<% } %>
<% if (hasSingle === "true") { %>
export * from "./useSingle.ts";
<% } %>
