import * as React from "react";
import type {
  HydrationState,
  LoaderFunction,
  Router as RemixRouter,
} from "../../router";
import { createBrowserHistory, createRouter, matchRoutes } from "../../router";
import type { DataRouteObject } from "../../context";

import "../global";
import { mapRouteProperties } from "../../components";
import { RouterProvider } from "../lib";
import type { AssetsManifest } from "./entry";
import { deserializeErrors } from "./errors";
import type {
  ClientActionFunction,
  ClientLoaderFunction,
  RouteModules,
} from "./routeModules";
import invariant from "./invariant";
import {
  createClientRoutes,
  createClientRoutesWithHMRRevalidationOptOut,
  shouldHydrateRouteLoader,
} from "./routes";
import {
  decodeViaTurboStream,
  getSingleFetchDataStrategy,
} from "./single-fetch";
import { RemixContext } from "./components";
import { RemixErrorBoundary } from "./errorBoundaries";

type SSRInfo = {
  context: NonNullable<(typeof window)["__remixContext"]>;
  routeModules: RouteModules;
  manifest: AssetsManifest;
  stateDecodingPromise:
    | (Promise<void> & {
        value?: unknown;
        error?: unknown;
      })
    | undefined;
  router: RemixRouter | undefined;
  routerInitialized: boolean;
};

let ssrInfo: SSRInfo | null = null;
let router: RemixRouter | null = null;

function initSsrInfo(): void {
  if (
    !ssrInfo &&
    window.__remixContext &&
    window.__remixManifest &&
    window.__remixRouteModules
  ) {
    ssrInfo = {
      context: window.__remixContext,
      manifest: window.__remixManifest,
      routeModules: window.__remixRouteModules,
      stateDecodingPromise: undefined,
      router: undefined,
      routerInitialized: false,
    };
  }
}

function createHydratedRouter(propRoutes?: DataRouteObject[]): RemixRouter {
  initSsrInfo();

  if (!ssrInfo) {
    throw new Error(
      "You must be using the SSR features of React Router in order to skip " +
        "passing a `router` prop to `<RouterProvider>`"
    );
  }

  // TODO: Do some testing to confirm it's OK to skip the hard reload check
  // now that all route.lazy stuff is wired up

  // We need to suspend until the initial state snapshot is decoded into
  // window.__remixContext.state

  let localSsrInfo = ssrInfo;
  // Note: `stateDecodingPromise` is not coupled to `router` - we'll reach this
  // code potentially many times waiting for our state to arrive, but we'll
  // then only get past here and create the `router` one time
  if (!ssrInfo.stateDecodingPromise) {
    let stream = ssrInfo.context.stream;
    invariant(stream, "No stream found for single fetch decoding");
    ssrInfo.context.stream = undefined;
    ssrInfo.stateDecodingPromise = decodeViaTurboStream(stream, window)
      .then((value) => {
        ssrInfo!.context.state =
          value.value as typeof localSsrInfo.context.state;
        localSsrInfo.stateDecodingPromise!.value = true;
      })
      .catch((e) => {
        localSsrInfo.stateDecodingPromise!.error = e;
      });
  }
  if (ssrInfo.stateDecodingPromise.error) {
    throw ssrInfo.stateDecodingPromise.error;
  }
  if (!ssrInfo.stateDecodingPromise.value) {
    throw ssrInfo.stateDecodingPromise;
  }

  let routes = createClientRoutes(
    ssrInfo.manifest.routes,
    ssrInfo.routeModules,
    ssrInfo.context.state,
    ssrInfo.context.future,
    ssrInfo.context.isSpaMode
  );

  // If the user provided their own data routes, add them to our manifest-created
  // routes here before creating the data router
  let propRoutesError: unknown;
  if (propRoutes && propRoutes.length > 0) {
    let rootRoute = routes[0];
    if (!rootRoute.children) {
      rootRoute.children = [];
    }

    try {
      validatePropRoutes(
        propRoutes,
        rootRoute.children,
        ssrInfo.context.isSpaMode === true
      );

      // If a route doesn't have a loader, add a dummy hydrating loader to stop
      // rendering at that level for hydration
      let hydratingLoader: LoaderFunction = () => null;
      hydratingLoader.hydrate = true;
      for (let route of propRoutes) {
        if (!route.loader) {
          route = { ...route, loader: hydratingLoader };
        }
        rootRoute.children.push(route);
      }
    } catch (e) {
      propRoutesError = e;
    }
  }

  let hydrationData: HydrationState | undefined = undefined;
  if (!ssrInfo.context.isSpaMode) {
    // Create a shallow clone of `loaderData` we can mutate for partial hydration.
    // When a route exports a `clientLoader` and a `HydrateFallback`, the SSR will
    // render the fallback so we need the client to do the same for hydration.
    // The server loader data has already been exposed to these route `clientLoader`'s
    // in `createClientRoutes` above, so we need to clear out the version we pass to
    // `createBrowserRouter` so it initializes and runs the client loaders.
    hydrationData = {
      ...ssrInfo.context.state,
      loaderData: { ...ssrInfo.context.state.loaderData },
    };
    let initialMatches = matchRoutes(routes, window.location);
    if (initialMatches) {
      for (let match of initialMatches) {
        let routeId = match.route.id;
        let route = ssrInfo.routeModules[routeId];
        let manifestRoute = ssrInfo.manifest.routes[routeId];
        // Clear out the loaderData to avoid rendering the route component when the
        // route opted into clientLoader hydration and either:
        // * gave us a HydrateFallback
        // * or doesn't have a server loader and we have no data to render
        if (
          route &&
          shouldHydrateRouteLoader(
            manifestRoute,
            route,
            ssrInfo.context.isSpaMode
          ) &&
          (route.HydrateFallback || !manifestRoute.hasLoader)
        ) {
          hydrationData.loaderData![routeId] = undefined;
        } else if (manifestRoute && !manifestRoute.hasLoader) {
          // Since every Remix route gets a `loader` on the client side to load
          // the route JS module, we need to add a `null` value to `loaderData`
          // for any routes that don't have server loaders so our partial
          // hydration logic doesn't kick off the route module loaders during
          // hydration
          hydrationData.loaderData![routeId] = null;
        }
      }
    }

    if (hydrationData && hydrationData.errors) {
      // TODO: De-dup this or remove entirely in v7 where single fetch is the
      // only approach and we have already serialized or deserialized on the server
      hydrationData.errors = deserializeErrors(hydrationData.errors);
    }
  }

  // We don't use createBrowserRouter here because we need fine-grained control
  // over initialization to support synchronous `clientLoader` flows.
  let router = createRouter({
    routes,
    history: createBrowserHistory(),
    basename: ssrInfo.context.basename,
    future: {
      v7_normalizeFormMethod: true,
      v7_fetcherPersist: ssrInfo.context.future.v3_fetcherPersist,
      v7_partialHydration: true,
      v7_prependBasename: true,
      v7_relativeSplatPath: ssrInfo.context.future.v3_relativeSplatPath,
      // Single fetch enables this underlying behavior
      unstable_skipActionErrorRevalidation: true,
    },
    hydrationData,
    mapRouteProperties,
    unstable_dataStrategy: getSingleFetchDataStrategy(
      ssrInfo.manifest,
      ssrInfo.routeModules
    ),
  });
  ssrInfo.router = router;

  // Do this after creating the router so ID's have been added to the routes
  // that we can use as keys in the manifest. `router.routes` will contain the
  // route IDs, `props.routes` may not.
  if (propRoutes && ssrInfo) {
    if (propRoutesError) {
      console.warn(propRoutesError);
    } else {
      let rootDataRoute = router.routes[0];
      for (let route of rootDataRoute.children || []) {
        addPropRoutesToRemix(
          ssrInfo,
          route as DataRouteObject,
          rootDataRoute.id
        );
      }
    }
  }

  // We can call initialize() immediately if the router doesn't have any
  // loaders to run on hydration
  if (router.state.initialized) {
    ssrInfo.routerInitialized = true;
    router.initialize();
  }

  // @ts-ignore
  router.createRoutesForHMR = createClientRoutesWithHMRRevalidationOptOut;
  window.__remixRouter = router;

  return router;
}

function addPropRoutesToRemix(
  ssrInfo: SSRInfo,
  route: DataRouteObject,
  parentId: string
) {
  if (!ssrInfo.manifest.routes[route.id]) {
    ssrInfo.manifest.routes[route.id] = {
      index: route.index,
      caseSensitive: route.caseSensitive,
      id: route.id,
      path: route.path,
      parentId,
      hasAction: false,
      hasLoader: false,
      hasClientAction: route.action != null,
      hasClientLoader: route.loader != null,
      hasErrorBoundary: route.hasErrorBoundary === true,
      imports: [],
      css: [],
      module: undefined,
    };
    ssrInfo.routeModules[route.id] = {
      ...route,
      clientAction: route.action as ClientActionFunction,
      clientLoader: route.loader as ClientLoaderFunction,
      default: route.Component || (() => null),
      HydrateFallback: route.HydrateFallback || undefined,
      ErrorBoundary: route.ErrorBoundary || undefined,
    };
  }
  if (route.children) {
    for (let child of route.children) {
      addPropRoutesToRemix(ssrInfo, child, route.id);
    }
  }
}

function validatePropRoutes(
  propRoutes: DataRouteObject[],
  rootChildren: DataRouteObject[],
  isSpaMode: boolean
) {
  if (!isSpaMode) {
    throw new Error(
      `The <HydratedRouter routes> prop is only usable in SPA Mode.`
    );
  }

  let existingRootChildren = new Set();
  for (let child of rootChildren) {
    if (child.index) {
      existingRootChildren.add("_index");
    } else if (child.path) {
      existingRootChildren.add(child.path);
    }
  }

  for (let route of propRoutes) {
    if (route.index && existingRootChildren.has("_index")) {
      throw new Error(
        `Cannot add a duplicate child index route to the root route via ` +
          `the \`HydratedRouter\` \`routes\` prop.  The \`routes\` prop ` +
          `will be ignored.`
      );
    }

    if (route.path && existingRootChildren.has(route.path.replace(/^\//, ""))) {
      throw new Error(
        `Cannot add a duplicate child route with path \`${route.path}\` to ` +
          `the root route via the \`HydratedRouter\` \`routes\` prop.  The ` +
          `\`routes\` prop will be ignored.`
      );
    }
  }
}

export interface HydratedRouterProps {
  /**
   *  Optional prop that can be used with "SPA Mode" when using the Vite plugin
   * if you have not yet moved your routes to use the file-based routing
   * convention or the `routes` config in the Vite plugin. The routes passed via
   * this prop will be appended as additional children of your root route.
   *
   * Routes defined this way are strictly client-side, so your `loader`/`action`
   * will be internally converted to Remix `clientLoader`/`clientAction`'s.
   *
   * ⚠️ This is not intended to be used as a primary method of defining routes,
   * and is intended to be used as a migration path from a React Router
   * `RouterProvider` application.
   *
   * ⚠️ If any collisions are detected from routes on the file system then a
   * warning will be logged and the `routes` prop will be ignored.
   */
  routes?: DataRouteObject[];
}

/**
 * Top-level component of your React Router application when using the Vite plugin.
 * Renders from the root component down for the matched routes.
 *
 * @category Router Components
 */
export function HydratedRouter(props: HydratedRouterProps): React.ReactElement {
  if (!router) {
    router = createHydratedRouter(props.routes);
  }

  // Critical CSS can become stale after code changes, e.g. styles might be
  // removed from a component, but the styles will still be present in the
  // server HTML. This allows our HMR logic to clear the critical CSS state.
  let [criticalCss, setCriticalCss] = React.useState(
    process.env.NODE_ENV === "development"
      ? ssrInfo?.context.criticalCss
      : undefined
  );
  if (process.env.NODE_ENV === "development") {
    if (ssrInfo) {
      window.__remixClearCriticalCss = () => setCriticalCss(undefined);
    }
  }

  let [location, setLocation] = React.useState(router.state.location);

  React.useLayoutEffect(() => {
    // If we had to run clientLoaders on hydration, we delay initialization until
    // after we've hydrated to avoid hydration issues from synchronous client loaders
    if (ssrInfo && ssrInfo.router && !ssrInfo.routerInitialized) {
      ssrInfo.routerInitialized = true;
      ssrInfo.router.initialize();
    }
  }, []);

  React.useLayoutEffect(() => {
    if (ssrInfo && ssrInfo.router) {
      return ssrInfo.router.subscribe((newState) => {
        if (newState.location !== location) {
          setLocation(newState.location);
        }
      });
    }
  }, [location]);

  invariant(ssrInfo, "ssrInfo unavailable for HydratedRouter");

  // We need to include a wrapper RemixErrorBoundary here in case the root error
  // boundary also throws and we need to bubble up outside of the router entirely.
  // Then we need a stateful location here so the user can back-button navigate
  // out of there
  return (
    // This fragment is important to ensure we match the <RemixServer> JSX
    // structure so that useId values hydrate correctly
    <>
      <RemixContext.Provider
        value={{
          manifest: ssrInfo.manifest,
          routeModules: ssrInfo.routeModules,
          future: ssrInfo.context.future,
          criticalCss,
          isSpaMode: ssrInfo.context.isSpaMode,
        }}
      >
        <RemixErrorBoundary location={location}>
          <RouterProvider
            router={router}
            fallbackElement={null}
            future={{ v7_startTransition: true }}
          />
        </RemixErrorBoundary>
      </RemixContext.Provider>
      {/*
          This fragment is important to ensure we match the <RemixServer> JSX
          structure so that useId values hydrate correctly
        */}
      <></>
    </>
  );
}
