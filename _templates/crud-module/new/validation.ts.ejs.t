---
to: src/modules/<%= outputPath %>/validation.ts
skip_if: <%= skipValidation %>
---
<% if (hasMultiNameFormFields === "true") { %>import { getMultiNameSchema } from "@/common/mapppers.ts";
<% } %>
import { yup } from "@/services";
<% if (validationConstantsImportSpec) { %>
import { <%= validationConstantsImportSpec %> } from "./constants.ts";
<% } %>

export const <%= validationName %> = yup.object().shape({
<%- validationFieldsBlock %>
});

export type <%= valuesTypeName %> = yup.InferType<typeof <%= validationName %>>;
