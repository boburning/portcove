import { useEffect, useId, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { desktopApi, type PortableSaveChoices } from "../api";
import { pickPortableSavesExportPath, pickPortableSavesImportPath } from "../file-picker";
import type {
  PortableSaveExportPreview,
  PortableSaveExportResult,
  PortableSaveImportPreview,
  PortableSaveImportResult,
} from "../types";
import { failurePresentation, formatBytes } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Icon } from "./ui";

type Blocker = PortableSaveExportPreview["blockers"][number];
type Role = PortableSaveExportPreview["stays_local"][number]["role"];
type Effect = PortableSaveImportPreview["changes"][number]["effect"];

const ROLE_LABEL: Record<Role, string> = {
  "portable-progress": "save progress",
  "device-configuration": "this device's settings",
  mods: "mods",
  "generated-content": "made by the game",
  "original-derived": "made from your own game files",
  "local-player-data": "player data that does not move",
  "portcove-metadata": "Portcove's record",
  unknown: "not recognized",
};

const BLOCKER_TEXT: Record<Blocker, string> = {
  unqualified: "Moving saves is not available for this game.",
  "not-installed": "Install the game with Portcove first.",
  "unsupported-version": "Moving saves is not available for this game version.",
  "unsupported-platform": "Moving saves is not available on this kind of device.",
  "version-mismatch":
    "These saves come from a different game version. Use the same version on both devices.",
  "different-game": "These saves belong to a different game.",
  busy: "Close the game and wait for other Portcove tasks for it to finish.",
  "no-portable-progress": "There are no saves to export yet.",
  "conflict-needs-choice":
    "Portcove can't confirm these saves continue from this device's saves. Choose whether to replace them.",
  "already-current": "This device already has these saves.",
};

const EFFECT_TEXT: Record<Effect, string> = {
  add: "added",
  replace: "replaced",
  unchanged: "unchanged",
  remove: "removed",
  "keep-local": "kept (not in the file)",
};

const PLATFORM_NAME: Record<string, string> = {
  "windows-x86-64": "Windows",
  "linux-x86-64": "Linux",
  "macos-x86-64": "macOS",
  "macos-aarch64": "macOS",
};

export interface PortableSavesApi {
  previewExport: (portId: string, generation: number) => Promise<PortableSaveExportPreview>;
  exportSaves: (
    portId: string,
    path: string,
    expectedContent: string,
    generation: number,
  ) => Promise<PortableSaveExportResult>;
  previewImport: (
    portId: string,
    path: string,
    choices: PortableSaveChoices,
    generation: number,
  ) => Promise<PortableSaveImportPreview>;
  importSaves: (
    portId: string,
    path: string,
    choices: PortableSaveChoices,
    expectedPreview: string,
    generation: number,
  ) => Promise<PortableSaveImportResult | null>;
  pickExportPath: (defaultName: string) => Promise<string | null>;
  pickImportPath: () => Promise<string | string[] | null>;
}

const defaultApi: PortableSavesApi = {
  previewExport: desktopApi.previewPortableSaveExport,
  exportSaves: desktopApi.exportPortableSaves,
  previewImport: desktopApi.previewPortableSaveImport,
  importSaves: desktopApi.importPortableSaves,
  pickExportPath: pickPortableSavesExportPath,
  pickImportPath: pickPortableSavesImportPath,
};

function StaysLocal({ entries }: { entries: PortableSaveExportPreview["stays_local"] }) {
  if (!entries.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer py-1">
        Stays on this device ({entries.length} {entries.length === 1 ? "item" : "items"})
      </summary>
      <ul className="m-0 grid gap-1 pl-5">
        {entries.map((entry) => (
          <li key={entry.path} className="[overflow-wrap:anywhere]">
            <code>
              {entry.path}
              {entry.directory ? "/" : ""}
            </code>{" "}
            <span className="text-pc-muted-foreground">— {ROLE_LABEL[entry.role]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Explicit export and import of a game's qualified save progress. Core decides
 * what moves, reviews every import against current data and backs up current
 * saves before applying; this surface only shows that review and asks.
 */
export function PortableSaves({
  portId,
  gameName,
  generation,
  busy,
  onChanged,
  api = defaultApi,
}: {
  portId: string;
  gameName: string;
  generation: number;
  busy?: string | undefined;
  onChanged?: () => void;
  api?: PortableSavesApi;
}) {
  const [exportPreview, setExportPreview] = useState<PortableSaveExportPreview>();
  const [review, setReview] = useState<{ path: string; preview: PortableSaveImportPreview }>();
  const [choices, setChoices] = useState<PortableSaveChoices>({
    removeLocalOnlySaves: false,
    replaceDivergedProgress: false,
  });
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const headingId = useId();
  const replaceId = useId();
  const removeId = useId();

  useEffect(() => {
    const current = ++request.current;
    api.previewExport(portId, generation).then(
      (preview) => {
        if (request.current === current) setExportPreview(preview);
      },
      () => {
        if (request.current === current) setExportPreview(undefined);
      },
    );
    return () => {
      request.current += 1;
    };
  }, [api, portId, generation, attempt]);

  if (!exportPreview || exportPreview.blockers.includes("unqualified")) return null;

  const fail = (value: unknown, fallback: string) =>
    setProblem(failurePresentation(value)?.summary ?? fallback);
  const disabled = Boolean(busy) || working;
  const exportBlocker = exportPreview.blockers[0];

  const runExport = async () => {
    setMessage(undefined);
    setProblem(undefined);
    const content = exportPreview.content_sha256;
    if (!content) return;
    const path = await api.pickExportPath(`${gameName} saves.json`);
    if (!path) return;
    setWorking(true);
    try {
      const result = await api.exportSaves(portId, path, content, generation);
      setMessage(
        `Exported ${result.files.length} save ${result.files.length === 1 ? "file" : "files"} to ${result.path}. Keep this file private; it contains your progress.`,
      );
    } catch (value) {
      fail(value, "The saves could not be exported.");
      setAttempt((count) => count + 1);
    } finally {
      setWorking(false);
    }
  };

  const reviewImport = async (path: string, next: PortableSaveChoices) => {
    setWorking(true);
    setProblem(undefined);
    try {
      const preview = await api.previewImport(portId, path, next, generation);
      setReview({ path, preview });
    } catch (value) {
      setReview(undefined);
      fail(value, "The saves file could not be reviewed.");
    } finally {
      setWorking(false);
    }
  };

  const chooseImport = async () => {
    setMessage(undefined);
    const selected = await api.pickImportPath();
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    const initial = { removeLocalOnlySaves: false, replaceDivergedProgress: false };
    setChoices(initial);
    await reviewImport(path, initial);
  };

  const changeChoice = async (next: PortableSaveChoices) => {
    setChoices(next);
    if (review) await reviewImport(review.path, next);
  };

  const applyImport = async () => {
    if (!review) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const result = await api.importSaves(
        portId,
        review.path,
        choices,
        review.preview.preview_sha256,
        generation,
      );
      if (result) {
        setReview(undefined);
        setMessage(
          result.safety_backup
            ? "Saves imported. This device's previous saves and settings are in a backup you can restore below."
            : "Saves imported.",
        );
        onChanged?.();
        setAttempt((count) => count + 1);
      }
    } catch (value) {
      fail(value, "The saves could not be imported. Nothing was changed unless a backup says so.");
    } finally {
      setWorking(false);
    }
  };

  const preview = review?.preview;
  const relation = preview
    ? {
        "no-local-progress": "This device has no saves for this game yet.",
        "already-current": "This device already has these saves.",
        continues: "These saves continue from this device's saves.",
        diverged: "Portcove can't confirm these saves continue from this device's saves.",
      }[preview.relation]
    : undefined;
  const showReplace =
    preview &&
    (preview.blockers.includes("conflict-needs-choice") || choices.replaceDivergedProgress);
  const showRemove =
    preview &&
    (preview.changes.some((change) => change.effect === "keep-local") ||
      choices.removeLocalOnlySaves);

  return (
    <section aria-labelledby={headingId} className="grid gap-2 text-sm" data-focus-group>
      <h3 id={headingId} className="m-0 text-base font-semibold">
        Move saves to another device
      </h3>
      <p className="m-0 text-pc-muted-foreground">
        Export this game&rsquo;s saves to a file and import it with Portcove on another device with
        the same game version. Settings, mods and other files stay on each device.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          data-focusable
          variant="outline"
          disabled={disabled || Boolean(exportBlocker)}
          onClick={() => void runExport()}
        >
          <Icon glyph={Upload} />
          Export saves…
        </Button>
        <Button
          data-focusable
          variant="outline"
          disabled={disabled}
          onClick={() => void chooseImport()}
        >
          <Icon glyph={Download} />
          Import saves…
        </Button>
      </div>
      {exportBlocker && (
        <p className="m-0 text-pc-muted-foreground">{BLOCKER_TEXT[exportBlocker]}</p>
      )}
      {exportPreview.files.length > 0 && (
        <p className="m-0 text-pc-muted-foreground">
          Exports {exportPreview.files.map((file) => file.path).join(", ")}.
        </p>
      )}
      {!preview && <StaysLocal entries={exportPreview.stays_local} />}
      {preview && (
        <div
          className="grid gap-2 rounded-pc-md border border-pc-border p-3"
          role="region"
          aria-label="Save import review"
        >
          <strong>
            Saves from {PLATFORM_NAME[preview.source.platform] ?? preview.source.platform}, game
            version {preview.source.version}
          </strong>
          <p className="m-0">{relation}</p>
          <ul className="m-0 grid gap-1 pl-5">
            {preview.changes.map((change) => (
              <li key={change.path} className="[overflow-wrap:anywhere]">
                <code>{change.path}</code> — {EFFECT_TEXT[change.effect]}
                {change.incoming ? ` (${formatBytes(change.incoming.size)})` : ""}
              </li>
            ))}
          </ul>
          <StaysLocal entries={preview.stays_local} />
          {showReplace && (
            <label htmlFor={replaceId} className="flex items-center gap-2">
              <Checkbox
                id={replaceId}
                checked={choices.replaceDivergedProgress}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  void changeChoice({ ...choices, replaceDivergedProgress: checked === true })
                }
              />
              Replace this device&rsquo;s saves with these (they stay in a backup)
            </label>
          )}
          {showRemove && (
            <label htmlFor={removeId} className="flex items-center gap-2">
              <Checkbox
                id={removeId}
                checked={choices.removeLocalOnlySaves}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  void changeChoice({ ...choices, removeLocalOnlySaves: checked === true })
                }
              />
              Also remove save slots that are only on this device
            </label>
          )}
          {preview.blockers
            .filter((blocker) => blocker !== "conflict-needs-choice")
            .map((blocker) => (
              <p key={blocker} className="m-0 text-pc-muted-foreground">
                {BLOCKER_TEXT[blocker]}
              </p>
            ))}
          <p className="m-0 text-pc-muted-foreground">
            {preview.safety_backup_will_be_created
              ? "Portcove backs up this device's current saves and settings before importing."
              : "There are no current saves or settings on this device to back up."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              data-focusable
              disabled={disabled || preview.blockers.length > 0}
              onClick={() => void applyImport()}
            >
              Import saves
            </Button>
            <Button
              data-focusable
              variant="ghost"
              disabled={working}
              onClick={() => setReview(undefined)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="m-0 [overflow-wrap:anywhere]">
          {message}
        </p>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[var(--color-warning-foreground,inherit)]">
          {problem}
        </p>
      )}
    </section>
  );
}
