import type { CSSProperties } from "react";
import palette from "./platform-palette.json";

// v58 identity decoration is independent of readiness and semantic status colors.
const identities: Record<string, { label: string; color: string }> = palette;
const aliases: Record<string, string> = {
  "windows-x86-64": "windows",
  "linux-x86-64": "linux",
  "macos-x86-64": "macos",
  "macos-aarch64": "macos",
  snes: "super-nintendo",
  "super-famicom": "super-nintendo",
  "snes-super-famicom": "super-nintendo",
  genesis: "mega-drive-genesis",
  "mega-drive": "mega-drive-genesis",
  "genesis-mega-drive": "mega-drive-genesis",
  "mega-cd": "sega-cd",
  "sega-cd-mega-cd": "sega-cd",
  ps1: "playstation",
  "playstation-ps1": "playstation",
  psp: "playstation-portable",
  "playstation-portable-psp": "playstation-portable",
};
export const canonicalIdentityId = (id: string): string => aliases[id] ?? id;
export function identityLabel(id: string): string {
  id = canonicalIdentityId(id);
  if (id === "not-specified") return "Not specified";
  if (id === "pc") return "PC";
  if (id === "mobile") return "Mobile";
  if (id === "nintendo-64dd") return "Nintendo 64DD";
  return identities[id]?.label ?? id.replaceAll("-", " ");
}
export function identityStyle(id: string, channel = false): CSSProperties | undefined {
  if (!channel) id = canonicalIdentityId(id);
  const color = channel
    ? ({ stable: "#22C55E", beta: "#F59E0B", rolling: "#3B82F6" } as Record<string, string>)[id]
    : identities[id]?.color;
  return color ? ({ "--identity-base": color } as CSSProperties) : undefined;
}
