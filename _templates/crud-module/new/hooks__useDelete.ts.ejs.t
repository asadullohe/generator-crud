---
to: src/modules/<%= outputPath %>/hooks/useDelete.ts
skip_if: <%= skipUseDelete %>
---
import { type UseMutationOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { <%= apiName %> } from "../api";
import { ENTITY } from "../constants";

interface UseDeleteProps
  extends Omit<UseMutationOptions<any, unknown, { id: string }>, "mutationFn" | "mutationKey"> {}

export function useDelete(mutationOptions?: UseDeleteProps) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [ENTITY, "delete"],
    mutationFn({ id }: { id: string }) {
      return <%= apiName %>.delete({ id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === ENTITY,
      });
    },
    ...mutationOptions,
  });
}
