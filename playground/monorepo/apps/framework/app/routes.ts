import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("products/:id", "routes/product.tsx"),
  route("transfers/:id", "../../../packages/transfers/src/routes/transfers._index.tsx"),
  route("accounts", "../../../packages/accounts/src/routes/accounts._index.tsx"),
] satisfies RouteConfig;
 