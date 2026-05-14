---
to: src/modules/<%= outputPath %>/hooks/index.ts
---
<% if (hasDelete === "true") { %>export * from "./useDelete.ts";
<% } %>
<% if (hasUseInfiniteList === "true") { %>
export * from "./useInfiniteList.ts";
<% } %>
<% if (hasUseList === "true") { %>
export * from "./useList.ts";
<% } %>
<% if (hasSingle === "true") { %>
export * from "./useSingle.ts";
<% } %>
