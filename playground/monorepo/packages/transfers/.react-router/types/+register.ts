import "react-router";

declare module "react-router" {
  interface Register {
    params: RouteParams;
  }

  interface RouteParams {
    "/transfers/:id": {
      id: string;
    };
  }
}
