---
to: src/modules/<%= outputPath %>/forms/CreateForm.tsx
skip_if: <%= skipCreateForm %>
---
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { Form, Formik, type FormikProps } from "formik";
<% if (hasMultiNameFormFields === "true") { %>
import { getMultiName } from "@/common/mapppers.ts";
<% } %>
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import { <%= validationName %>, type <%= valuesTypeName %> } from "../validation.ts";

type CreateFormProps = {
  children: (props: FormikProps<<%= valuesTypeName %>>) => React.ReactNode;
} & Omit<UseMutationOptions<<%= entityTypeName %>, unknown, <%= valuesTypeName %>>, "mutationFn" | "mutationKey">;

export function CreateForm({ children, ...mutationOptions }: CreateFormProps) {
  const { mutateAsync } = useMutation({
    mutationKey: [ENTITY, "form", "create"],
    async mutationFn(values: <%= valuesTypeName %>) {
      const { data } = await <%= apiName %>.create({ values });

      return <%= mapperName %>(data);
    },
    ...mutationOptions,
  });

  return (
    <Formik<<%= valuesTypeName %>>
      onSubmit={(values) => mutateAsync(values)}
      initialValues={{
<%- createInitialValuesBlock %>
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
