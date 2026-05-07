---
to: src/modules/<%= outputPath %>/mappers.ts
---
import { get } from "radash";
<% if (hasMultiNameEntityFields === "true") { %>
import { getMultiName } from "@/common/mapppers.ts";
<% } %>
<% if (mapperImportsBlock) { %>
<%- mapperImportsBlock %>
<% } %>

export const <%= mapperName %> = (item?: any) => {
  return {
<%- mapperFieldsBlock %>
  };
};

export type <%= entityTypeName %> = ReturnType<typeof <%= mapperName %>>;
