---
to: src/modules/<%= outputPath %>/hooks/useSingle.ts
skip_if: <%= skipUseSingle %>
---
import { useQuery } from "@tanstack/react-query";
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";

interface IProps {
  id: string;
}

type TData = {
  item: <%= entityTypeName %>;
};

export function useSingle({ id }: IProps) {
  const initialData = { item: <%= mapperName %>() } as TData;

  const { data = initialData, ...args } = useQuery({
    queryKey: [ENTITY, "single", id],
    async queryFn() {
      const { data } = await <%= apiName %>.single({ id });

      return {
        item: <%= mapperName %>(data),
      };
    },
    initialData,
    enabled: !!id,
  });

  return { ...data, ...args };
}
