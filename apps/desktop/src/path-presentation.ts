/**
 * A Windows path as the player knows it, without the `\\?\` verbatim prefix.
 *
 * Presentation only: Core's canonical value stays the identity for every API
 * argument and comparison.
 */
export function withoutVerbatimPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
