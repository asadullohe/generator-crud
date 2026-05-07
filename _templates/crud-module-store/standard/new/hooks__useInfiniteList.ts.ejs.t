---
to: src/modules/<%= outputPath %>/hooks/useInfiniteList.ts
skip_if: <%= skipUseInfiniteList %>
---
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { get } from "radash";
import { Meta } from "@/common/mapppers.ts";
import { config } from "@/config.ts";
import { <%= apiName %> } from "../api.ts";
import { ENTITY } from "../constants.ts";
import { <%= mapperName %>, type <%= entityTypeName %> } from "../mappers.ts";
import type { Params } from "../types.ts";

type QueryResult = {
  items: <%= entityTypeName %>[];
  meta: ReturnType<typeof Meta>;
};

type UseInfiniteListProps = {
  params?: Params;
  enabled?: boolean;
};

export const useInfiniteList = ({ params, enabled = true }: UseInfiniteListProps = {}) => {
  const initialData = {
    pages: [],
    pageParams: [],
  } as InfiniteData<QueryResult>;

  const paramsWithDefaults = {
    perPage: params?.perPage || config.list.perPage,
    sort: {
      key: params?.sort?.key || "<%= defaultSortKey %>",
      direction: params?.sort?.direction || "DESC",
    },
    filter: (params?.filter || []).filter((i) => !!(i as any).value),
  };

  const { data = initialData, ...args } = useInfiniteQuery({
    queryKey: [ENTITY, "infinite-list", paramsWithDefaults],
    queryFn: async ({ pageParam = 1 }) => {
      const { data } = await <%= apiName %>.list({
        params: {
          ...paramsWithDefaults,
          page: pageParam as number,
        },
      });

      const items = (get<Array<any>>(data, "content") || []).map((item) => <%= mapperName %>(item));
      const meta = Meta(get(data as any, "meta"));

      return { items, meta };
    },
    initialPageParam: 1,
    initialData,
    enabled,
    getNextPageParam: (lastPage) =>
      lastPage.meta.current < lastPage.meta.totalPages ? lastPage.meta.current + 1 : undefined,
    retry: false,
  });

  return { ...args, data };
};
