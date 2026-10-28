/** Narrow external objects without trusting JSON, subprocess errors, or thrown values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === "string" ? value.code : undefined;
}

export function errorMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === "string" ? value.message : String(value);
}

export function recordField(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}
