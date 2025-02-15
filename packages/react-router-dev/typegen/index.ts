import fs from "node:fs";

import ts from "dedent";
import * as Path from "pathe";
import pc from "picocolors";
import type vite from "vite";

import { createConfigLoader } from "../config/config";
import * as Babel from "../vite/babel";

import { generate } from "./generate";
import type { Context } from "./context";
import { getTypesDir, getTypesPath, searchForPackageRoot } from "./paths";
import * as Params from "./params";
import * as Route from "./route";
import type { RouteManifest } from "../config/routes";

export async function run(rootDirectory: string) {
  const ctx = await createContext({ rootDirectory, watch: false });
  await writeAll(ctx);
}

export type Watcher = {
  close: () => Promise<void>;
};

export async function watch(
  rootDirectory: string,
  { logger }: { logger?: vite.Logger } = {}
): Promise<Watcher> {
  const ctx = await createContext({ rootDirectory, watch: true });
  await writeAll(ctx);
  logger?.info(pc.green("generated types"), { timestamp: true, clear: true });

  ctx.configLoader.onChange(async ({ result, routeConfigChanged }) => {
    if (!result.ok) {
      logger?.error(pc.red(result.error), { timestamp: true, clear: true });
      return;
    }

    ctx.config = result.value;
    if (routeConfigChanged) {
      await writeAll(ctx);
      logger?.info(pc.green("regenerated types"), {
        timestamp: true,
        clear: true,
      });
    }
  });

  return {
    close: async () => await ctx.configLoader.close(),
  };
}

async function createContext({
  rootDirectory,
  watch,
}: {
  rootDirectory: string;
  watch: boolean;
}): Promise<Context> {
  const configLoader = await createConfigLoader({ rootDirectory, watch });
  const configResult = await configLoader.getConfig();

  if (!configResult.ok) {
    throw new Error(configResult.error);
  }

  const config = configResult.value;

  return {
    configLoader,
    rootDirectory,
    config,
  };
}

async function writeAll(ctx: Context): Promise<void> {
  const typegenDirs: Record<string, RouteManifest> = {};

  Object.entries(ctx.config.routes).forEach(([id, route]) => {
    // Given a route file, find its nearest package.json
    const routeFile = Path.join(ctx.config.appDirectory, route.file);
    const packageDirectory = searchForPackageRoot(routeFile);
    const typegenDir = getTypesDir(packageDirectory);

    // Delete the package's existing types directory
    if (!typegenDirs[typegenDir]) {
      fs.rmSync(typegenDir, { recursive: true, force: true });
      typegenDirs[typegenDir] = {};

      console.log("Generated types in ", typegenDir);
    }

    const typesPath = getTypesPath(packageDirectory, routeFile);
    const content = generate(ctx, route, typesPath);
    fs.mkdirSync(Path.dirname(typesPath), { recursive: true });
    fs.writeFileSync(typesPath, content);

    // Store the package's routes for generating the +register.ts file
    typegenDirs[typegenDir][id] = route;
  });

  // Generate the +register.ts file for each package
  Object.entries(typegenDirs).forEach(([typegenDir, routes]) => {
    console.log("Generating +register.ts for", typegenDir);
    const registerPath = Path.join(typegenDir, "+register.ts");
    fs.writeFileSync(registerPath, register(routes));
  });
}

function register(routes: RouteManifest) {
  const { t } = Babel;

  const typeParams = t.tsInterfaceDeclaration(
    t.identifier("RouteParams"),
    null,
    [],
    t.tsInterfaceBody(
      Object.values(routes)
        .map((route) => {
          // filter out pathless (layout) routes
          if (route.id !== "root" && !route.path) return undefined;

          const lineage = Route.lineage(routes, route);
          const fullpath = Route.fullpath(lineage);
          const params = Params.parse(fullpath);
          return t.tsPropertySignature(
            t.stringLiteral(fullpath),
            t.tsTypeAnnotation(
              t.tsTypeLiteral(
                Object.entries(params).map(([param, isRequired]) => {
                  const property = t.tsPropertySignature(
                    t.stringLiteral(param),
                    t.tsTypeAnnotation(t.tsStringKeyword())
                  );
                  property.optional = !isRequired;
                  return property;
                })
              )
            )
          );
        })
        .filter((x): x is Babel.Babel.TSPropertySignature => x !== undefined)
    )
  );

  const routeParams = Babel.generate(typeParams).code;
  return ts`
  import "react-router";

  declare module "react-router" {
    interface Register {
      params: RouteParams;
    }
      
    ${routeParams}
  }
  `;
}
