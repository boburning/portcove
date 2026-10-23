import type { PortDefinition } from "./types";

export interface PortIdentity {
  name: string;
  presentation?: Partial<NonNullable<PortDefinition["presentation"]>> | null;
}

/** Display metadata never changes the stable port identity or groups projects. */
export function gameTitle(port: PortIdentity): string {
  return port.presentation?.original_game_title?.trim() || port.name;
}

export function gameProjectLabel(port: PortIdentity): string | undefined {
  const variant = port.presentation?.variant_label?.trim();
  if (!port.presentation?.original_game_title?.trim() && !variant) return undefined;
  return variant ? `${port.name} · ${variant}` : port.name;
}

export function gameIdentityLabel(port: PortIdentity): string {
  const project = gameProjectLabel(port);
  return project ? `${gameTitle(port)} · ${project}` : gameTitle(port);
}
