import type { AuthoredListing } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

type LauncherModPortal = NonNullable<AuthoredListing["mod_portals"]>[number] & {
  site: "community_site";
};

export const observedLauncherModPortalPrefix = "obs-gh-";

export function launcherModPortalId(portal: { name: string }, repositoryId: number) {
  const provider = portal.name === "Thunderstore" ? "thunderstore" : "gamebanana";
  return observedLauncherModPortalPrefix + provider + "-" + repositoryId;
}

export function validLauncherModPortal(portal: unknown): portal is LauncherModPortal {
  if (
    !isRecord(portal) ||
    Object.keys(portal).length !== 5 ||
    portal.site !== "community_site" ||
    typeof portal.url !== "string" ||
    portal.instructions !==
      "The upstream project lists this community. Follow its setup instructions."
  )
    return false;
  if (portal.id === "upstream-thunderstore")
    return (
      portal.name === "Thunderstore" &&
      portal.url.length <= 155 &&
      /^https:\/\/thunderstore\.io\/c\/[a-z0-9]+(?:[-_][a-z0-9]+)*\/$/u.test(portal.url)
    );
  const game = /^https:\/\/gamebanana\.com\/games\/([1-9]\d*)$/u.exec(portal.url);
  return (
    portal.id === "upstream-gamebanana" &&
    portal.name === "GameBanana" &&
    !!game &&
    Number.isSafeInteger(Number(game[1]))
  );
}

export function isBoundLauncherModPortal(
  portal: unknown,
  repositoryId?: number,
): portal is LauncherModPortal {
  if (!isRecord(portal) || typeof portal.id !== "string") return false;
  const match = /^obs-gh-(thunderstore|gamebanana)-([1-9]\d*)$/u.exec(portal.id);
  return Boolean(
    match &&
    Number.isSafeInteger(Number(match[2])) &&
    (repositoryId === undefined || repositoryId === Number(match[2])) &&
    validLauncherModPortal({ ...portal, id: "upstream-" + match[1] }),
  );
}
