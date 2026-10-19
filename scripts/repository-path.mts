/** Normalize the local validation input spelling; changed-path admission is stricter. */
export function normalizeRepositoryPath(value: string) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../"))
    throw new Error(`unsafe repository path: ${value}`);
  return normalized;
}
