import { isRecord } from "./runtime-values.mts";

/** Resolve only the selected workspace's default catalog; installed metadata is not a pin. */
export function workspacePackageDeclaration(
  workspace: unknown,
  name: string,
  declaration: unknown,
) {
  const catalog = isRecord(workspace) && isRecord(workspace.catalog) ? workspace.catalog : {};
  const value = declaration === "catalog:" ? catalog[name] : declaration;
  if (typeof value !== "string") throw new Error("Package metadata requires a text version");
  return value;
}
