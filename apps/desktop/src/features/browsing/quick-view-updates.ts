/** Available and staged updates share the Library Updates view; membership is a union. */
export const quickViewUpdates = ["available", "staged"] as const;

export function isQuickViewUpdateSelection(updates: readonly string[] | undefined = []) {
  return (
    new Set(updates).size === quickViewUpdates.length &&
    quickViewUpdates.every((value) => updates.includes(value))
  );
}
