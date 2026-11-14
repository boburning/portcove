import { useId } from "react";
import type { GameUpdatePlan } from "../types";
import { ExternalLink } from "./ExternalLink";

type ReleaseNotes = NonNullable<GameUpdatePlan["release_notes"]>;

/**
 * Upstream release notes from Core's update review. Notes are untrusted project
 * text rendered as escaped plain text; the only links are Core-built release pages.
 */
export function UpdateReleaseNotes({
  notes,
  currentVersion,
}: {
  notes: ReleaseNotes;
  currentVersion?: string | undefined;
}) {
  const headingId = useId();
  const heading = currentVersion ? `What’s new since ${currentVersion}` : "What’s new";
  if (notes.entries.length === 0)
    return (
      <section data-update-release-notes className="col-span-full" aria-labelledby={headingId}>
        <h3 id={headingId} className="mb-1 text-[length:var(--text-sm)] font-semibold">
          {heading}
        </h3>
        <p className="mb-1 text-[length:var(--text-sm)]">
          Portcove doesn’t have the release notes for this update. Check them on the project’s
          release page before updating.
        </p>
        <ExternalLink href={notes.releases_url}>Release notes</ExternalLink>
      </section>
    );
  return (
    <section data-update-release-notes className="col-span-full" aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-1 text-[length:var(--text-sm)] font-semibold">
        {heading}
      </h3>
      <p className="mb-2 text-[length:var(--text-sm)] text-pc-muted-foreground">
        Written by the project. Shown as plain text, so some formatting may appear as symbols.
      </p>
      <div
        role="region"
        aria-labelledby={headingId}
        className="max-h-[16rem] overflow-y-auto overscroll-contain rounded-pc-md border border-pc-border p-3 [overflow-wrap:anywhere]"
      >
        <ol className="m-0 grid list-none gap-4 p-0">
          {notes.entries.map((entry) => (
            <li key={entry.version}>
              <p className="mb-1">
                <strong>{entry.version}</strong>
                {entry.title && <> · {entry.title}</>}
                {entry.published_at && (
                  <span className="text-pc-muted-foreground">
                    {" "}
                    · {publishedDate(entry.published_at)}
                  </span>
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
                <p className="mb-1 text-[length:var(--text-sm)]">These notes are shortened.</p>
              )}
              <ExternalLink href={entry.url}>
                {entry.notes_truncated
                  ? `Full notes for ${entry.version}`
                  : `${entry.version} release page`}
              </ExternalLink>
            </li>
          ))}
        </ol>
      </div>
      {!notes.complete && (
        <p className="mt-2 mb-1 text-[length:var(--text-sm)]">
          This list may not include every release since your version. Check the project’s release
          page for earlier changes.
        </p>
      )}
      <ExternalLink href={notes.releases_url} className="mt-1">
        All release notes
      </ExternalLink>
    </section>
  );
}

function publishedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
