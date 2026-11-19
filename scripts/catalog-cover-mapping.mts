import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import { isRecord } from "./runtime-values.mts";

export const slugPattern = /^[a-z0-9-]{1,255}$/;
export const imagePattern = /^[a-z0-9]{1,128}$/;
export const hashPattern = /^[a-f0-9]{64}$/;
export const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const matchesString = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.test(value);

export interface IgdbRegionalCover {
  game_id: number;
  slug: string;
  name: string;
  platform_id: number;
  localization_id: number;
  region_id: number;
  cover_id: number;
  image_id: string;
}

export function validIgdbRegionalCover(value: unknown): value is IgdbRegionalCover {
  return (
    isRecord(value) &&
    Object.keys(value).length === 8 &&
    positiveId(value.game_id) &&
    matchesString(slugPattern, value.slug) &&
    typeof value.name === "string" &&
    Boolean(value.name.trim()) &&
    value.name.length <= 255 &&
    positiveId(value.platform_id) &&
    positiveId(value.localization_id) &&
    positiveId(value.region_id) &&
    positiveId(value.cover_id) &&
    matchesString(imagePattern, value.image_id)
  );
}

export function matchesIgdbRegionalCover(value: unknown, selection: IgdbRegionalCover) {
  return (
    validArtworkMapping(value) &&
    value.match_kind === "underlying-game" &&
    value.game_id === selection.game_id &&
    value.game_slug === selection.slug &&
    value.cover_id === selection.cover_id &&
    value.image_id === selection.image_id
  );
}

export function validArtworkMapping(value: unknown): value is IgdbArtwork {
  return (
    isRecord(value) &&
    positiveId(value.game_id) &&
    positiveId(value.cover_id) &&
    matchesString(imagePattern, value.image_id) &&
    matchesString(hashPattern, value.image_sha256) &&
    matchesString(slugPattern, value.game_slug) &&
    (value.match_kind === "port" || value.match_kind === "underlying-game")
  );
}

export function validArtworkCollection(value: unknown): value is IgdbArtwork[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 4 &&
    value.every(validArtworkMapping) &&
    (["game_id", "cover_id", "image_id", "image_sha256"] as const).every(
      (key) => new Set(value.map((cover) => cover[key])).size === value.length,
    )
  );
}
