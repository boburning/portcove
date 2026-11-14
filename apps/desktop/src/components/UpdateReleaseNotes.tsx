import { useId } from "react";
import type { GameUpdatePlan } from "../types";
import { ExternalLink } from "./ExternalLink";

type ReleaseNotes = NonNullable<GameUpdatePlan["release_notes"]>;

/**
 * Upstream release notes from Core's update review. Notes are untrusted project
 * text rendered as escaped plain text. The only link is the project's release list,
 * which Core includes only when Portcove may open it.
 */
export function UpdateReleaseNotes({
  notes,
  currentVersion,
}: {
  notes: ReleaseNotes;
  currentVersion?: string | undefined;
}) {
  const headingId = useId();
  const offered = notes.entries[0]?.version;
  const heading =
    notes.coverage === "installed_newer" && offered ? (
      <>
        Release notes for <bdi>{offered}</bdi>
      </>
    ) : currentVersion ? (
      <>
        What’s new since <bdi>{currentVersion}</bdi>
      </>
    ) : (
      "What’s new"
    );
  const releasesLink = notes.releases_url && (
    <ExternalLink href={notes.releases_url} className="mt-1">
      All release notes
    </ExternalLink>
  );
  if (notes.entries.length === 0)
    return (
      <section data-update-release-notes className="col-span-full" aria-labelledby={headingId}>
        <h3 id={headingId} className="mb-1 text-[length:var(--text-sm)] font-semibold">
          {heading}
        </h3>
        <p className="mb-1 text-[length:var(--text-sm)]">
          Portcove doesn’t have the release notes for this update.
          {notes.releases_url && " Check them on the project’s release page before updating."}
        </p>
        {releasesLink}
      </section>
    );
  const coverage = coverageText(notes.coverage, notes.entries.length, Boolean(notes.releases_url));
  return (
    <section data-update-release-notes className="col-span-full" aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-1 text-[length:var(--text-sm)] font-semibold">
        {heading}
      </h3>
      <p className="mb-2 text-[length:var(--text-sm)] text-pc-muted-foreground">
        Written by the project. Shown as plain text, so some formatting may appear as symbols.
      </p>
      <div
        data-update-release-notes-list
        role="group"
        aria-labelledby={headingId}
        // Focusable so keyboard and controller navigation can scroll long notes.
        tabIndex={scrollableTabIndex}
        data-focusable
        className="max-h-[16rem] overflow-y-auto overscroll-contain rounded-pc-md border border-pc-border p-3 [overflow-wrap:anywhere]"
      >
        <ol className="m-0 grid list-none gap-4 p-0">
          {notes.entries.map((entry) => {
            const published = publishedDate(entry.published_at);
            return (
              <li key={entry.version}>
                <p className="mb-1">
                  <strong>
                    <bdi>{entry.version}</bdi>
                  </strong>
                  {entry.title && (
                    <>
                      {" · "}
                      <bdi>{entry.title}</bdi>
                    </>
                  )}
                  {published && (
                    <span className="text-pc-muted-foreground"> · Published {published}</span>
                  )}
                </p>
                {entry.notes ? (
                  <p className="mb-1 text-[length:var(--text-sm)] whitespace-pre-wrap">
                    {entry.notes}
                  </p>
                ) : (
                  <p className="mb-1 text-[length:var(--text-sm)] text-pc-muted-foreground">
                    No notes were published for this release.
                  </p>
                )}
                {entry.notes_truncated && (
                  <p className="mb-1 text-[length:var(--text-sm)]">
                    {notes.releases_url
                      ? "These notes are shortened. The full notes are on the project’s release page."
                      : "These notes are shortened."}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {coverage && <p className="mt-2 mb-1 text-[length:var(--text-sm)]">{coverage}</p>}
      {releasesLink}
    </section>
  );
}

const scrollableTabIndex = 0;

function coverageText(coverage: ReleaseNotes["coverage"], count: number, hasReleasePage: boolean) {
  switch (coverage) {
    case "shortened":
      return hasReleasePage
        ? `Only the newest ${count} releases are shown. Earlier changes since your version are on the project’s release page.`
        : `Only the newest ${count} releases are shown. Earlier changes since your version aren’t listed here.`;
    case "installed_not_listed":
      return "Portcove couldn’t find your version in the project’s release list, so this list may not include every change since your version.";
    case "installed_newer":
      return "The version you’re using is newer than this update, so only this release’s notes are shown.";
    case "rolling_release":
      return "This release is updated in place, so only its current notes are shown.";
    default:
      return undefined;
  }
}

function publishedDate(value: string | null | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString();
}
