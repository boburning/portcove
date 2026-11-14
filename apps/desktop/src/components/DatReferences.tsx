import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickDatPath } from "../file-picker";
import type { DatReferenceStatus } from "../types";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { SettingsRow } from "./ui/patterns";

const stateLabels: Record<DatReferenceStatus["state"], string> = {
  ready: "Ready",
  missing: "Not found",
  changed: "Changed",
  unreadable: "Can’t be read",
};

function problemText(value: unknown, fallback: string) {
  const failure = failurePresentation(value);
  if (!failure) return fallback;
  return failure.technical_message && failure.technical_message !== failure.summary
    ? `${failure.summary} ${failure.technical_message}`
    : failure.summary;
}

/**
 * Player-supplied No-Intro or Redump DAT files. Core owns parsing, the saved
 * references and identification; DAT files only name selected game files.
 */
export function DatReferenceSettings({
  load = desktopApi.datReferences,
  add = desktopApi.addDatReference,
  remove = desktopApi.removeDatReference,
  pick = pickDatPath,
}: {
  load?: () => Promise<DatReferenceStatus[]>;
  add?: (path: string) => Promise<DatReferenceStatus>;
  remove?: (datId: string) => Promise<void>;
  pick?: () => Promise<string | null>;
}) {
  const [references, setReferences] = useState<DatReferenceStatus[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Each completed change asks Core again; only the latest read is shown.
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    load().then(
      (loaded) => {
        if (request.current === current) setReferences(loaded);
      },
      (value) => {
        if (request.current === current)
          setProblem(problemText(value, "Portcove couldn’t read your saved DAT files."));
      },
    );
    return () => {
      request.current += 1;
    };
  }, [load, revision]);
  const change = async (operation: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await operation();
    } catch (value) {
      setProblem(problemText(value, failure));
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  };
  const addFile = async () => {
    // Hold the controls while the file picker is open so a second request can't start.
    setBusy(true);
    let path: string | null;
    try {
      path = await pick();
    } catch (value) {
      setProblem(problemText(value, "Portcove couldn’t open the file picker."));
      setBusy(false);
      return;
    }
    if (!path) {
      setBusy(false);
      return;
    }
    await change(() => add(path), "Portcove couldn’t add this DAT file.");
  };
  return (
    <SettingsRow data-focus-group aria-label="DAT files">
      <div className="grid gap-2">
        <h3 className="text-base font-semibold">DAT files</h3>
        <p className="text-sm text-pc-muted-foreground">
          Add No-Intro or Redump DAT files you already have. When Portcove checks original game
          files, it names the matching dump. DAT files don’t change which files a game accepts. They
          stay where they are and aren’t uploaded.
        </p>
        {references && references.length === 0 && (
          <p className="text-sm text-pc-muted-foreground">No DAT files added.</p>
        )}
        {references && references.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="Saved DAT files">
            {references.map((reference) => {
              const label = `${reference.name}${reference.version ? ` (${reference.version})` : ""}`;
              return (
                <li
                  key={reference.id}
                  aria-label={`${label}: ${stateLabels[reference.state]}`}
                  className="flex items-start justify-between gap-3 rounded-pc-md bg-[var(--color-bg-inset)] p-2"
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong>{label}</strong>
                    <small>
                      {stateLabels[reference.state]} · {reference.entry_count.toLocaleString()}{" "}
                      {reference.entry_count === 1 ? "entry" : "entries"}
                    </small>
                    {reference.state !== "ready" && <small>{reference.message}</small>}
                    <code className="text-xs [overflow-wrap:anywhere] whitespace-normal">
                      {reference.path}
                    </code>
                  </span>
                  <Button
                    data-focusable
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove DAT file ${label}`}
                    onClick={() =>
                      void change(
                        () => remove(reference.id),
                        "Portcove couldn’t remove this DAT file.",
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {problem && <p role="alert">{problem}</p>}
        <div>
          <Button data-focusable variant="outline" disabled={busy} onClick={() => void addFile()}>
            Add DAT file
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
