const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/**
 * A cheap, stable token for one object reference. Workspace reads structurally
 * share unchanged values, so an unchanged value keeps its token while any
 * accepted change yields a new one. Primitive values are encoded directly.
 */
export function referenceIdentity(value: unknown): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return value === undefined ? "undefined" : JSON.stringify(value);
  let identity = identities.get(value);
  if (identity === undefined) {
    identity = ++nextIdentity;
    identities.set(value, identity);
  }
  return `#${identity}`;
}
