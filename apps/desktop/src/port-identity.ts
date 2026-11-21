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
  const title = gameTitle(port).trim();
  const prefix = `${title} — `;
  let project = port.name;
  while (project.trim().startsWith(prefix)) {
    project = project.trim().slice(prefix.length);
  }
  if (title === project.trim() || project.trim() === `${title} —`) return variant || undefined;
  return variant ? `${project} · ${variant}` : project;
}

export function gameIdentityLabel(port: PortIdentity): string {
  const project = gameProjectLabel(port);
  return project ? `${gameTitle(port)} · ${project}` : gameTitle(port);
}
