---
to: src/modules/<%= outputPath %>/forms/UpdateForm.tsx
skip_if: <%= skipUpdateForm %>
---
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
<% if (hasMultiNameFormFields === "true") { %>
import { getMultiName } from "@/common/mapppers.ts";
<% } %>
import { <%= apiName %> } from "../api.ts";
import { <%= formConstantsImportSpec %> } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import { <%= validationName %>, type <%= valuesTypeName %> } from "../validation.ts";

type UpdateFormProps = {
  item: <%= entityTypeName %>;
  children: (props: FormikProps<<%= valuesTypeName %>>) => React.ReactNode;
} & Omit<UseMutationOptions<<%= entityTypeName %>, unknown, <%= valuesTypeName %>>, "mutationFn" | "mutationKey">;

export function UpdateForm({ item, children, ...mutationOptions }: UpdateFormProps) {
  const { mutateAsync } = useMutation({
    mutationKey: [ENTITY, "form", "update", item],
    async mutationFn(values: <%= valuesTypeName %>) {
      const { data } = await <%= apiName %>.update({ id: item.id, values });

      return <%= mapperName %>(data);
    },
    ...mutationOptions,
  });

  return (
    <Formik<<%= valuesTypeName %>>
      onSubmit={(values) => mutateAsync(values)}
      initialValues={{
<%- updateInitialValuesBlock %>
      }}
      validationSchema={<%= validationName %>}
      enableReinitialize
      validateOnChange
      validateOnBlur
    >
      {(props) => <Form>{children(props)}</Form>}
    </Formik>
  );
}
