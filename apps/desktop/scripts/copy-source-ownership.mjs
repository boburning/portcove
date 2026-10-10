import path from "node:path";

export function isProductionCopyPath(filename) {
  return (
    filename.startsWith("apps/desktop/src/") &&
    /\.(?:ts|tsx)$/u.test(filename) &&
    !/\.(?:test|d)\.tsx?$/u.test(filename) &&
    path.basename(filename) !== "test-fixtures.ts"
  );
}
