import fs from "node:fs";
import * as Path from "pathe";
import * as Pathe from "pathe/utils";

function hasPackageJSON(root: string) {
  const path = Path.join(root, "package.json");
  return fs.existsSync(path);
}

/**
 * Search up for the nearest `package.json`
 */
export function searchForPackageRoot(current: string, root = current): string {
  if (hasPackageJSON(current)) return current;

  const dir = Path.dirname(current);
  // reach the fs root
  if (!dir || dir === current) return root;

  return searchForPackageRoot(dir, root);
}

export function getTypesDir(rootDirectory: string) {
  return Path.join(rootDirectory, ".react-router/types");
}

export function getTypesPath(packageDirectory: string, routeFile: string) {
  const typesDir = getTypesDir(packageDirectory);
  const relative = Path.relative(packageDirectory, Path.dirname(routeFile));
  const filename = Pathe.filename(routeFile);
  return Path.join(typesDir, relative, "+types/" + filename + ".ts");
}
