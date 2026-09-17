import { FolderInput, FolderOpen, ShieldCheck, X } from "lucide-react";
import { formatBytes } from "../view-model";
import { useDialogFocus } from "../dialog";
import { Icon, NavigationHints } from "./ui";
import type { AdoptionPreview, PortDefinition } from "../types";

export function AdoptionModal({
  path,
  setPath,
  preview,
  busy,
  applying = false,
  copyFailed,
  close,
  review,
  adopt,
  pickFolder,
  ports = [],
}: {
  path: string;
  setPath: (path: string) => void;
  preview?: AdoptionPreview;
  busy?: string;
  applying?: boolean;
  copyFailed?: boolean;
  close: () => void;
  review: () => void;
  adopt: () => void;
  pickFolder?: () => void;
  ports?: readonly PortDefinition[];
}) {
  const dismiss = () => {
    if (!applying) close();
  };
  const dialog = useDialogFocus(dismiss);
  const portIdentity = preview ? adoptionPortIdentity(preview, ports) : undefined;
  return (
    <div className="scrim">
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="adopt-title"
        aria-describedby="adopt-description"
      >
        <button
          data-focusable
          className="close icon-button"
          aria-label="Close copy installation dialog"
          onClick={dismiss}
          disabled={applying}
        >
          <Icon glyph={X} />
        </button>
        <span className="modal-icon">
          <Icon glyph={FolderInput} size="lg" />
        </span>
        <p className="eyebrow">COPY EXISTING INSTALLATION</p>
        <h2 id="adopt-title">Add an existing installation to Portcove</h2>
        <p className="modal-description" id="adopt-description">
          Portcove checks the folder, identifies the port, and copies supported application files
          into your library without changing the original.
        </p>
        <p className="inline-assurance">
          <Icon glyph={ShieldCheck} /> Review first, then confirm before copying.
        </p>
        <NavigationHints />
        <label htmlFor="adopt-path">Existing installation folder</label>
        <div className="path-entry">
          <input
            data-autofocus
            data-focusable
            id="adopt-path"
            value={path}
            disabled={Boolean(busy) || applying}
            onChange={(event) => setPath(event.target.value)}
            placeholder="Choose or paste the full folder path"
          />
          {pickFolder && (
            <button
              data-focusable
              className="button-with-icon"
              type="button"
              disabled={Boolean(busy) || applying}
              onClick={pickFolder}
            >
              <Icon glyph={FolderOpen} />
              Browse
            </button>
          )}
        </div>
        {preview && (
          <section
            className="adoption-plan adoption-review"
            aria-label="Existing installation copy plan"
          >
            <p>
              <strong>
                {portIdentity?.kind === "selected"
                  ? (portIdentity.ports[0]?.name ?? "Unknown catalog port")
                  : portIdentity?.kind === "ambiguous"
                    ? "Multiple supported ports detected"
                    : "No supported port detected"}
              </strong>
              {portIdentity?.kind === "selected" && portIdentity.ports[0]?.id && (
                <>
                  <br />
                  <small>
                    Catalog ID: <code>{portIdentity.ports[0].id}</code>
                  </small>
                </>
              )}
            </p>
            {portIdentity?.kind === "ambiguous" && (
              <>
                <p>Choose the matching port in Portcove before reviewing this folder again.</p>
                <ul aria-label="Detected ports">
                  {portIdentity.ports.map((port) => (
                    <li key={port.id}>
                      {port.name ?? "Unknown catalog port"} — Catalog ID: <code>{port.id}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>
              {preview.copy_plan.files.length.toLocaleString()}{" "}
              {preview.copy_plan.files.length === 1 ? "file" : "files"} ·{" "}
              {formatBytes(preview.copy_plan.total_bytes)} will be copied into the managed library.
            </p>
            {preview.copy_plan.skipped_entries.length > 0 && (
              <details>
                <summary>
                  {preview.copy_plan.skipped_entries.length} unsupported{" "}
                  {preview.copy_plan.skipped_entries.length === 1 ? "item" : "items"} will remain
                  only in the original folder
                </summary>
                <ul>
                  {preview.copy_plan.skipped_entries.map((entry) => (
                    <li key={entry.relative_path}>
                      <code>{entry.relative_path}</code> — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p>
              <strong>Original folder:</strong> {preview.source}
            </p>
            {preview.destination && <AdoptionConsequences destination={preview.destination} />}
            <p>
              The original folder, registered sources, existing backups and other games remain
              unchanged.
            </p>
            <p>
              There is no single undo action. Removing the managed copy later does not restore
              overwritten saved files. Create a backup first if you need those files.
            </p>
            <p>
              Stop the game before copying. Once copying starts, this dialog cannot cancel it. If
              interrupted, recovery may finish a verified copy; check the library and saved data
              before retrying.
            </p>
          </section>
        )}
        {copyFailed && (
          <p role="alert">
            The copy could not be confirmed. Check the library and activity history before retrying,
            then review the current copy plan.
          </p>
        )}
        <div className="actions">
          <button data-focusable onClick={dismiss} disabled={applying}>
            Keep original setup
          </button>
          {preview ? (
            <button
              data-focusable
              className="primary button-with-icon"
              disabled={
                Boolean(busy) || applying || !preview.selected_port_id || !preview.destination
              }
              onClick={adopt}
            >
              <Icon glyph={FolderInput} />
              {applying ? "Copying…" : "Continue to copy confirmation"}
            </button>
          ) : (
            <button
              data-focusable
              className="primary button-with-icon"
              disabled={!path.trim() || Boolean(busy) || applying}
              onClick={review}
            >
              <Icon glyph={FolderInput} />
              {applying
                ? "Copying…"
                : busy === "preview adoption"
                  ? "Reviewing…"
                  : "Review copy plan"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function adoptionPortIdentity(preview: AdoptionPreview, ports: readonly PortDefinition[]) {
  const presentation = (id: string) => ({
    id,
    name: ports.find((port) => port.id === id)?.name,
  });
  if (preview.selected_port_id)
    return { kind: "selected" as const, ports: [presentation(preview.selected_port_id)] };
  if (preview.detected_port_ids.length > 0)
    return { kind: "ambiguous" as const, ports: preview.detected_port_ids.map(presentation) };
  return { kind: "none" as const, ports: [] };
}

function AdoptionConsequences({
  destination,
}: {
  destination: NonNullable<AdoptionPreview["destination"]>;
}) {
  return (
    <>
      <p>
        <strong>Application destination:</strong>{" "}
        {destination.output_location.effective_output_directory}
        <br />A new version folder is created here and becomes active. Existing versions remain.
      </p>
      {destination.active_install && (
        <p>
          <strong>Current active version:</strong> {destination.active_install.version}
          <br />
          {destination.active_install.path}
        </p>
      )}
      <p>
        <strong>Saved-data destination:</strong> {destination.output_location.user_data_root}
        <br />
        {destination.current_user_data_files} existing{" "}
        {destination.current_user_data_files === 1 ? "file" : "files"}.
      </p>
      {destination.imported_user_data_paths.length > 0 ? (
        <>
          <p>
            These saved-data paths are merged from the original folder. Matching saved files are
            replaced; other saved files remain. No automatic safety backup is created.
          </p>
          <ul>
            {destination.imported_user_data_paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>No catalog-selected saved-data paths will be imported from this folder.</p>
      )}
    </>
  );
}
