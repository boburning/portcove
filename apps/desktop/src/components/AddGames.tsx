import { useState } from "react";
import type { PortDefinition, PortStatus, SourceProfile, SourceRecord } from "../types";
import { gameIdentityLabel } from "../port-identity";
import { useSetupReviewSelection } from "../features/game-file-discovery/setup-review-selection";
import { GameFileLibraries } from "./GameFileLibraries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { FolderInput, FolderSearch, Gamepad2 } from "lucide-react";
import { Icon } from "./ui";

export function AddGames({
  active,
  generation,
  ports,
  profiles,
  statuses,
  sources,
  refreshFailed,
  onAdded,
  onOpenPort,
  onCheckFiles,
  onBrowseCatalog,
  onCopyInstallation,
  setupSource,
  setSetupSource,
  close,
}: {
  active: boolean;
  generation: number;
  ports: PortDefinition[];
  profiles: SourceProfile[];
  statuses: ReadonlyMap<string, PortStatus>;
  sources: SourceRecord[];
  refreshFailed: boolean;
  onAdded: () => Promise<unknown>;
  onOpenPort: (id: string, origin: string) => void;
  onCheckFiles: (id: string, profileId: string) => void;
  onBrowseCatalog: () => void;
  onCopyInstallation: () => void;
  setupSource?: SourceRecord | undefined;
  setSetupSource: (source?: SourceRecord) => void;
  close: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "files" | "folders" | "existing">("choose");
  const [foldersVisited, setFoldersVisited] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const { requestReview } = useSetupReviewSelection();
  const port = ports.find((candidate) => candidate.id === selected);
  const status = port ? statuses.get(port.id) : undefined;
  const candidates = ports.filter((candidate) =>
    gameIdentityLabel(candidate).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const profile = profiles.find((candidate) => candidate.id === port?.source_profile);
  return (
    <section
      hidden={!active}
      aria-label="Add games workspace"
      className="add-games max-w-[66rem] min-w-0 wrap-anywhere"
    >
      <Button variant="outline" size="sm" onClick={close}>
        Back to library
      </Button>
      <p className="mt-4 max-w-[65ch] text-pc-muted-foreground">
        Start with a game, a folder of original files, or an installation you already have. Portcove
        checks what is supported before you confirm any changes.
      </p>
      <div
        className="my-6 grid gap-3 min-[75rem]:grid-cols-3"
        role="group"
        aria-label="Ways to add games"
      >
        <Button
          variant={mode === "files" ? "selected" : "outline"}
          className="h-auto min-h-24 justify-start gap-3 p-4 text-start whitespace-normal"
          aria-label="Choose a game or port"
          aria-describedby="add-game-description"
          aria-pressed={mode === "files"}
          onClick={() => setMode("files")}
        >
          <Icon glyph={Gamepad2} />
          <span>
            <strong className="block">Choose a game or port</strong>
            <span id="add-game-description" className="mt-1 block text-xs font-normal">
              Find its requirements and choose your original files.
            </span>
          </span>
        </Button>
        <Button
          variant={mode === "folders" ? "selected" : "outline"}
          className="h-auto min-h-24 justify-start gap-3 p-4 text-start whitespace-normal"
          aria-label="Find games in a folder"
          aria-describedby="add-folder-description"
          aria-pressed={mode === "folders"}
          onClick={() => {
            setFoldersVisited(true);
            setMode("folders");
          }}
        >
          <Icon glyph={FolderSearch} />
          <span>
            <strong className="block">Find games in a folder</strong>
            <span id="add-folder-description" className="mt-1 block text-xs font-normal">
              Check folders you choose for supported original files.
            </span>
          </span>
        </Button>
        <Button
          variant={mode === "existing" ? "selected" : "outline"}
          aria-pressed={mode === "existing"}
          className="h-auto min-h-24 justify-start gap-3 p-4 text-start whitespace-normal"
          aria-label="Use an existing installation"
          aria-describedby="add-existing-description"
          onClick={() => setMode("existing")}
        >
          <Icon glyph={FolderInput} />
          <span>
            <strong className="block">Use an existing installation</strong>
            <span id="add-existing-description" className="mt-1 block text-xs font-normal">
              Review a supported copy or the port's external-folder route.
            </span>
          </span>
        </Button>
      </div>
      <section
        hidden={mode !== "existing"}
        className="grid gap-3 rounded-pc-lg border border-pc-border bg-pc-surface p-5"
        aria-label="Existing installation options"
      >
        <h2 className="text-lg">Bring an installation into Portcove</h2>
        <p className="max-w-[65ch] text-pc-muted-foreground">
          Review the detected port, destination and supported saved data before copying. The
          original folder stays in place.
        </p>
        <Button variant="primary" onClick={onCopyInstallation}>
          Copy an existing installation
        </Button>
        <h3 className="mt-6 text-base">Keep a folder you maintain</h3>
        <p className="max-w-[65ch] text-pc-muted-foreground">
          Using a folder in place is supported only by some ports. Choose its game and port to check
          the available route; other ports require a managed installation.
        </p>
        <Button variant="outline" onClick={() => setMode("files")}>
          Choose its game and port
        </Button>
      </section>
      <section
        hidden={mode !== "files"}
        className="grid max-w-[48rem] gap-3 rounded-pc-lg border border-pc-border bg-pc-surface p-5"
        aria-label="Selected game-file check"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg">Choose the game and port</h2>
          <Button variant="link" onClick={onBrowseCatalog}>
            Browse Find games
          </Button>
        </div>
        <p>
          File checks use the chosen port’s requirements. Folder search can recognize multiple
          games; an unknown file or an ambiguous match stays unconfirmed.
        </p>
        <label htmlFor={active && mode === "files" ? "port-search" : undefined}>
          Find a game or port
        </label>
        <Input
          id={active && mode === "files" ? "port-search" : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="mt-3 block" htmlFor="add-games-port">
          Game and port
        </label>
        <select
          id="add-games-port"
          className="my-2 min-h-10 w-full max-w-full rounded-pc-md border border-pc-border bg-pc-surface p-2 text-pc-foreground"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose a port</option>
          {port && !candidates.includes(port) && (
            <option value={port.id}>{gameIdentityLabel(port)} (selected; outside search)</option>
          )}
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {gameIdentityLabel(candidate)}
            </option>
          ))}
        </select>
        {candidates.length === 0 && (
          <p role="status">
            No game or port matches this search. Change the search or browse Find games.
          </p>
        )}
        {port && (
          <>
            <p className="font-semibold">{gameIdentityLabel(port)}</p>
            {profile ? (
              <Button
                id="add-games-check-files"
                variant="primary"
                disabled={refreshFailed}
                onClick={() => onCheckFiles(port.id, profile.id)}
              >
                Choose files to check…
              </Button>
            ) : (
              <p>
                This port has no original-game-file requirement in the current catalog. Review its
                available setup route.
              </p>
            )}
            <p>
              Review this port's requirements and current setup action. Before anything runs, the
              review explains which files are used and what will change.
            </p>
            <Button
              variant="outline"
              data-detail-origin="add-games:selected-setup"
              onClick={() => {
                if (
                  !refreshFailed &&
                  status?.channel &&
                  status.port_actions?.some(
                    (action) => action.action === "install" && action.availability === "allowed",
                  )
                )
                  requestReview(port.id, status.channel);
                onOpenPort(port.id, "add-games:selected-setup");
              }}
            >
              Review setup for {gameIdentityLabel(port)}
            </Button>
          </>
        )}
      </section>
      {foldersVisited && (
        <div hidden={mode !== "folders"}>
          <GameFileLibraries
            instanceId="add-games-folders"
            generation={generation}
            ports={ports}
            profiles={profiles}
            registeredSources={sources}
            statuses={statuses}
            workspaceRefreshFailed={refreshFailed}
            onAdded={onAdded}
            onOpenPort={onOpenPort}
            setupSource={setupSource}
            setSetupSource={setSetupSource}
          />
        </div>
      )}
      <p className="mt-4 text-xs text-pc-muted-foreground">
        You can leave this workspace and keep browsing. Your choices stay here; running tasks remain
        in Activity.
      </p>
    </section>
  );
}
