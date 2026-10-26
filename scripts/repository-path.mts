/** Normalize the local validation input spelling; changed-path admission is stricter. */
export function normalizeRepositoryPath(value: string) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../"))
    throw new Error(`unsafe repository path: ${value}`);
  return normalized;
}

/** Strict Git/plan path admission; do not normalize untrusted changed paths. */
export function validateChangedPath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`unsafe changed path: ${JSON.stringify(value)}`);
  }
  return value;
}
