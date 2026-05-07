---
to: src/modules/<%= outputPath %>/hooks/useList.ts
skip_if: <%= skipUseList %>
---
import { useQuery } from "@tanstack/react-query";
import { get } from "radash";
import { Meta } from "@/common/mapppers.ts";
import type { IMeta } from "@/common/types.ts";
import { config } from "@/config.ts";
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import type { Params } from "../types.ts";

type UseListProps = {
  params?: Partial<Params>;
  enabled?: boolean;
  retry?: boolean | number;
};

type TData = {
  items: <%= entityTypeName %>[];
  meta: IMeta;
};

export function useList({ params = {}, enabled = true, retry = false }: UseListProps) {
  const initialData = { items: [], meta: Meta() } as TData;
  const defaultParams = {
    page: params?.page || 1,
    perPage: params?.perPage || config.list.perPage,
    sort: {
      key: params?.sort?.key || "<%= defaultSortKey %>",
      direction: params?.sort?.direction || "DESC",
    },
    filter: (params?.filter || []).filter((i) => !!i.value),
  } satisfies Params;

  const { data = initialData, ...args } = useQuery({
    queryKey: [ENTITY, "list", defaultParams],
    async queryFn() {
      const { data } = await <%= apiName %>.list({
        params: defaultParams,
      });

      const items = (get<any[]>(data, "content") || []).map(<%= mapperName %>);
      const meta = Meta(get(data, "meta"));

      return {
        items,
        meta,
      };
    },
    initialData,
    enabled,
    retry,
  });

  return { ...data, ...args };
}
