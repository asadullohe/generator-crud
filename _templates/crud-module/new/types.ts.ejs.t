---
to: src/modules/<%= outputPath %>/types.ts
skip_if: <%= skipTypes %>
---
export type Filter = {
  key: string;
  operation: ">" | ">=" | "<" | "<=" | "=" | "!=";
  value: string | number | string[];
};

export type Params = {
  page?: number;
  perPage?: number;
  sort?: {
    key?: string;
    direction?: "ASC" | "DESC";
  };
  filter?: Filter[];
};
