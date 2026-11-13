/** Case- and accent-insensitive text used by every game and command search. */
export function normalizeGameSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
