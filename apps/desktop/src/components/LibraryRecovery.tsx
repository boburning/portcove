import { useEffect, useRef, useState } from "react";
import type { LibraryMetadataFile, PortDefinition, PortStatus } from "../types";
import { gameIdentityLabel } from "../port-identity";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { LibraryImportButton } from "./LibraryImport";
import { LibraryMoveButton } from "./LibraryMove";
import { SettingsRow } from "./ui/patterns";

export function LibraryRecovery({
  libraryRoot,
  busy,
  ports,
  statuses,
  exportMetadata,
  onOpenActivity,
  onReviewSaves,
}: {
  libraryRoot: string;
  busy?: string | undefined;
  ports: PortDefinition[];
  statuses: ReadonlyMap<string, PortStatus>;
  exportMetadata?: (() => Promise<LibraryMetadataFile | undefined>) | undefined;
  onOpenActivity?: (() => void) | undefined;
  onReviewSaves?: ((portId: string, origin: string) => void) | undefined;
}) {
  const [preparing, setPreparing] = useState(false);
  const [exported, setExported] = useState<LibraryMetadataFile>();
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  // The owner keys this guide to the workspace generation. No result from an
  // outgoing library may become a receipt for a replacement library.
  const installed = ports.filter((port) => statuses.get(port.id)?.active);
  return (
    <SettingsRow className="library-recovery min-w-0 wrap-anywhere" data-focus-group>
      <h2>Library recovery</h2>
      <p>Prepare a recovery copy, restore a checked copy, or move the active library.</p>
      <details>
        <summary className="cursor-pointer py-2 font-semibold">Prepare a recovery copy</summary>
        <p>
          This is a guided manual copy. Portcove exports metadata; it does not copy your library or
          certify a backup here.
        </p>
        <h3>1. Review work and game saves</h3>
        <p>
          Review unfinished tasks in Activity. Finish or resolve them, close every game, and stop
          other clients using this library before making the copy. Activity cannot prove that
          another process is idle.
        </p>
        <Button variant="outline" size="sm" disabled={!onOpenActivity} onClick={onOpenActivity}>
          Review tasks &amp; history
        </Button>
        <p>
          Create applicable save backups from each game’s Saves and storage page before exporting.
          That page checks whether Portcove owns the saves and can back them up. External game saves
          may need a separate copy using that game’s instructions.
        </p>
        <ul className="grid gap-2 ps-5">
          {installed.map((port) => (
            <li key={port.id}>
              <Button
                variant="link"
                size="sm"
                className="h-auto max-w-full text-start whitespace-normal"
                disabled={!onReviewSaves}
                data-detail-origin={`settings:recovery:saves:${port.id}`}
                onClick={() => onReviewSaves?.(port.id, `settings:recovery:saves:${port.id}`)}
              >
                Review saves for {gameIdentityLabel(port)}
              </Button>
            </li>
          ))}
        </ul>
        {installed.length === 0 && <p>No managed installations are in the current snapshot.</p>}
        <h3>2. Export metadata</h3>
        <p>
          Keep the export with the content copy from this same library state. Metadata records
          installed versions, saved file locations and settings. It contains no game content, saves,
          backups or credentials.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || preparing || !exportMetadata}
          onClick={() => {
            if (pending.current || !exportMetadata) return;
            pending.current = true;
            setPreparing(true);
            setError(undefined);
            void exportMetadata()
              .then((result) => {
                if (current.current && result) setExported(result);
              })
              .catch((value: unknown) => {
                if (current.current) setError(errorText(value));
              })
              .finally(() => {
                pending.current = false;
                if (current.current) setPreparing(false);
              });
          }}
        >
          {preparing ? "Exporting metadata…" : "Export metadata"}
        </Button>
        {exported && (
          <p role="status">
            Metadata exported to{" "}
            <code dir="ltr" className="[unicode-bidi:isolate]">
              {exported.path}
            </code>
            . Content has not been copied or verified.
          </p>
        )}
        {error && <p role="alert">Metadata export did not finish: {error}</p>}
        <h3>3. Close Portcove and copy the content</h3>
        <aside
          aria-label="Host-local sign-in files"
          className="my-3 rounded-pc-md border border-pc-border p-3"
        >
          <strong>Review version-local sign-in files before copying.</strong>
          <p>
            Some installed versions keep protected RetroAchievements sign-in files inside their
            version folder. Do not put <code>retroachievements.credentials</code> or its numeric
            temporary files in a recovery copy. Checked restore and Move refuse these files; they do
            not silently filter an entire library copy.
          </p>
          <p>
            Open the affected version, sign out and close it. Temporary files may remain. If a
            refusal names a remaining file, privately preserve it on this host outside all Portcove
            installation, save, backup, staging and recovery folders before manually removing it
            from the listed transfer tree. Keep your original data intact. Do not upload these files
            or include their contents in diagnostics. Review again after any change and prepare a
            fresh matching export and content copy. Sign in again in the destination; copying these
            files does not transfer sign-in authority.
          </p>
        </aside>
        <p>
          After the export, close Portcove and all other clients and keep games closed. In your file
          manager, copy the following folders that exist under this library into one recovery
          folder, preserving their names and contents:
        </p>
        <code dir="ltr" className="block [unicode-bidi:isolate]">
          {libraryRoot || "Library location unavailable"}
        </code>
        <ul className="ps-5">
          <li>
            <code>versions</code> — installed, previous and staged application versions
          </li>
          <li>
            <code>user</code> — Portcove-managed game saves and settings
          </li>
          <li>
            <code>source-inbox</code> — game files imported into this library
          </li>
          <li>
            <code>backups</code> — existing owned-save backup snapshots
          </li>
          <li>
            <code>toolchains</code> — retained preparation tools
          </li>
          <li>
            <code>artwork</code> — local artwork
          </li>
        </ul>
        <p>
          Keep the metadata export beside those folders. Original game files and BIOS files outside
          the library, external installations and their saves are excluded. Preserve those
          separately. Do not resume work between exporting and copying; if the library changes,
          prepare a fresh matching export and copy.
        </p>
        <p>
          A manual copy is unverified. Keep the source intact and test a restore into a different
          new or empty library before relying on it. Retained catalog definitions can require this
          host’s secure-storage admission; a copy does not establish trust on another device.
        </p>
      </details>
      <h3>Restore a recovery copy</h3>
      <p>
        Choose a new or empty destination library first. Review the metadata and copied content
        together. Restore checks the bound plan and copied files before publishing the destination.
        Disconnected originals remain saved locations and need current checks or relinking.
        Interrupted restore offers its existing resume or retaining abort; keep the input copy.
      </p>
      <LibraryImportButton
        disabled={Boolean(busy) || preparing || !libraryRoot}
        libraryRoot={libraryRoot}
      />
      <h3>Move the active library</h3>
      <p>
        Move copies and verifies the current library, then switches library authority. It keeps the
        old folder and is separate from preparing a recovery copy.
      </p>
      <LibraryMoveButton disabled={Boolean(busy) || preparing} />
    </SettingsRow>
  );
}
