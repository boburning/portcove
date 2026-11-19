import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickDatPath } from "../file-picker";
import type { DatReferenceStatus } from "../types";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { ActionRow, Notice, SettingsRow } from "./ui/patterns";

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
  const [activity, setActivity] = useState<"picking" | "adding" | "removing">();
  // Each completed change asks Core again; only the latest read is shown.
  const [revision, setRevision] = useState(0);
  const [lastRead, setLastRead] = useState<{ revision: number; problem?: string }>();
  const request = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const reading = lastRead?.revision !== revision;
  const busy = reading || Boolean(activity);
  useEffect(() => {
    const current = ++request.current;
    load().then(
      (loaded) => {
        if (request.current !== current) return;
        const focused = document.activeElement;
        const focusedId =
          focused instanceof HTMLButtonElement && list.current?.contains(focused)
            ? focused.dataset.datId
            : undefined;
        if (
          focused === refreshButton.current ||
          (focusedId && !loaded.some(({ id }) => id === focusedId))
        ) {
          addButton.current?.focus();
        }
        setReferences(loaded);
        setLastRead({ revision });
      },
      (value) => {
        if (request.current === current)
          setLastRead({
            revision,
            problem: problemText(value, "Portcove couldn’t read your saved DAT files."),
          });
      },
    );
    return () => {
      request.current += 1;
    };
  }, [load, revision]);
  const refresh = () => setRevision((value) => value + 1);
  const change = async (
    kind: "adding" | "removing",
    operation: () => Promise<unknown>,
    failure: string,
  ) => {
    setActivity(kind);
    setProblem(undefined);
    try {
      await operation();
    } catch (value) {
      setProblem(problemText(value, failure));
    } finally {
      refresh();
      setActivity(undefined);
    }
  };
  const addFile = async () => {
    // Hold the controls while the file picker is open so a second request can't start.
    setActivity("picking");
    setProblem(undefined);
    let path: string | null;
    try {
      path = await pick();
    } catch (value) {
      setProblem(problemText(value, "Portcove couldn’t open the file picker."));
      setActivity(undefined);
      return;
    }
    if (!path) {
      setActivity(undefined);
      return;
    }
    await change("adding", () => add(path), "Portcove couldn’t add this DAT file.");
  };
  const removeFile = (id: string, trigger: HTMLButtonElement) =>
    change(
      "removing",
      async () => {
        await remove(id);
        if (document.activeElement === trigger) addButton.current?.focus();
        setReferences((current) => current?.filter((reference) => reference.id !== id));
      },
      "Portcove couldn’t remove this DAT file.",
    );
  const status = activity
    ? {
        picking: "Opening the DAT file picker…",
        adding: "Adding the DAT file…",
        removing: "Removing the DAT file…",
      }[activity]
    : reading
      ? "Reading saved DAT files…"
      : undefined;
  return (
    <SettingsRow data-focus-group aria-label="DAT files" className="min-w-0">
      <div className="grid min-w-0 gap-2 [overflow-wrap:anywhere]">
        <h3 className="text-base font-semibold">DAT files</h3>
        <p className="text-sm text-pc-muted-foreground">
          Add No-Intro or Redump DAT files you already have. When Portcove checks original game
          files, it names the matching dump. DAT files don’t change which files a game accepts. They
          stay where they are and aren’t uploaded.
        </p>
        <p role="status" className={status ? "text-sm text-pc-muted-foreground" : "sr-only"}>
          {status}
        </p>
        {references && references.length === 0 && !busy && !lastRead?.problem && (
          <p className="text-sm text-pc-muted-foreground">No DAT files added.</p>
        )}
        {references && references.length > 0 && (
          <ul
            ref={list}
            className="m-0 grid min-w-0 list-none gap-2 p-0"
            aria-label="Saved DAT files"
          >
            {references.map((reference) => {
              const label = `${reference.name}${reference.version ? ` (${reference.version})` : ""}`;
              return (
                <li
                  key={reference.id}
                  aria-label={`${label}: ${stateLabels[reference.state]}`}
                  className="flex items-start justify-between gap-3 rounded-pc-md bg-[var(--color-bg-inset)] p-2"
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="text-sm">
                      <bdi>{label}</bdi>
                    </strong>
                    <small>
                      {stateLabels[reference.state]} · {reference.entry_count.toLocaleString()}{" "}
                      {reference.entry_count === 1 ? "entry" : "entries"}
                    </small>
                    {reference.state !== "ready" && <small dir="auto">{reference.message}</small>}
                    <code dir="ltr" className="text-xs whitespace-normal">
                      {reference.path}
                    </code>
                  </span>
                  <Button
                    data-focusable
                    data-dat-id={reference.id}
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    focusableWhenDisabled={busy}
                    aria-label={`Remove DAT file ${label}`}
                    onClick={({ currentTarget }) => void removeFile(reference.id, currentTarget)}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {problem && (
          <Notice role="alert" dir="auto">
            {problem}
          </Notice>
        )}
        {lastRead?.problem && (
          <Notice role="alert" dir="auto">
            {lastRead.problem}
          </Notice>
        )}
        <ActionRow>
          {lastRead?.problem && (
            <Button
              ref={refreshButton}
              data-focusable
              variant="outline"
              disabled={busy}
              focusableWhenDisabled={busy}
              onClick={refresh}
            >
              Refresh DAT files
            </Button>
          )}
          <Button
            ref={addButton}
            data-focusable
            variant="outline"
            disabled={busy}
            focusableWhenDisabled={busy}
            onClick={() => void addFile()}
          >
            Add DAT file
          </Button>
        </ActionRow>
      </div>
    </SettingsRow>
  );
}
