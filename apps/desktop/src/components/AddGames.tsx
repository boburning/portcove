import { useState } from "react";
import type { PortDefinition, PortStatus, SourceProfile, SourceRecord } from "../types";
import { gameIdentityLabel, gameTitle, gameProjectLabel } from "../port-identity";
import { useSetupReviewSelection } from "../features/game-file-discovery/setup-review-selection";
import { GameFileLibraries } from "./GameFileLibraries";
import { RegisteredSourceSetup } from "./RegisteredSourceSetup";
import type { Perform } from "../features/operations/use-operation-state";
import { Button } from "./ui/button";
import { SearchChoice } from "./ui/combobox";
import { ArrowLeft, ArrowRight, FolderInput, FolderSearch, Gamepad2 } from "lucide-react";
import { Icon } from "./ui";
import { ArtworkImage } from "./Artwork";

export function AddGames({
  active,
  generation,
  ports,
  profiles,
  statuses,
  sources,
  refreshFailed,
  perform,
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
  perform: Perform;
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
      <Button variant="ghost" size="sm" className="add-games-back" onClick={close}>
        <Icon glyph={ArrowLeft} size="sm" />
        Back to library
      </Button>
      <p className="add-games-intro">
        Start with a game, a folder of original files, or an installation you already have. Portcove
        checks what is supported before you confirm any changes.
      </p>
      <RegisteredSourceSetup
        sources={sources}
        profiles={profiles}
        statuses={statuses}
        generation={generation}
        current={active && !refreshFailed}
        perform={perform}
        onChanged={onAdded}
        onOpenPort={onOpenPort}
      />
      <div
        className="add-route-choices"
        data-route-selected={mode !== "choose"}
        role="group"
        aria-label="Ways to add games"
      >
        <Button
          variant={mode === "files" ? "selected" : "outline"}
          className="add-route-choice"
          aria-label="Choose a game or port"
          aria-describedby="add-game-description"
          aria-pressed={mode === "files"}
          onClick={() => setMode("files")}
        >
          <Icon glyph={Gamepad2} />
          <span>
            <strong className="block">Choose a game or port</strong>
            <span id="add-game-description" className="add-route-description">
              Find its requirements and choose your original files.
            </span>
          </span>
          <Icon glyph={ArrowRight} size="sm" className="add-route-arrow" />
        </Button>
        <Button
          variant={mode === "folders" ? "selected" : "outline"}
          className="add-route-choice"
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
            <span id="add-folder-description" className="add-route-description">
              Check folders you choose for supported original files.
            </span>
          </span>
          <Icon glyph={ArrowRight} size="sm" className="add-route-arrow" />
        </Button>
        <Button
          variant={mode === "existing" ? "selected" : "outline"}
          aria-pressed={mode === "existing"}
          className="add-route-choice"
          aria-label="Use an existing installation"
          aria-describedby="add-existing-description"
          onClick={() => setMode("existing")}
        >
          <Icon glyph={FolderInput} />
          <span>
            <strong className="block">Use an existing installation</strong>
            <span id="add-existing-description" className="add-route-description">
              Copy a supported installation or keep using its current folder.
            </span>
          </span>
          <Icon glyph={ArrowRight} size="sm" className="add-route-arrow" />
        </Button>
      </div>
      <section
        hidden={mode !== "existing"}
        className="add-route-panel add-existing-options"
        aria-label="Existing installation options"
      >
        <div className="add-existing-choice">
          <div>
            <h2 className="text-lg">Copy an existing installation</h2>
            <p className="max-w-[65ch] text-pc-muted-foreground">
              Review the detected port, destination and supported saved data before copying. The
              original folder stays in place.
            </p>
          </div>
          <Button variant="primary" onClick={onCopyInstallation}>
            Copy an existing installation
            <Icon glyph={ArrowRight} size="sm" />
          </Button>
        </div>
        <div className="add-existing-choice">
          <div>
            <h3 className="text-base">Keep a folder you maintain</h3>
            <p className="max-w-[65ch] text-pc-muted-foreground">
              Using a folder in place is supported only by some ports. Choose its game and port to
              check the available route; other ports require a managed installation.
            </p>
          </div>
          <Button variant="outline" onClick={() => setMode("files")}>
            Choose its game and port
            <Icon glyph={ArrowRight} size="sm" />
          </Button>
        </div>
      </section>
      <section
        hidden={mode !== "files"}
        className="add-route-panel"
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
        <SearchChoice
          label="Game and port"
          id={active && mode === "files" ? "port-search" : undefined}
          options={ports.map((candidate) => ({
            id: candidate.id,
            label: gameIdentityLabel(candidate),
            description: `Port project: ${candidate.name} · ${candidate.id}`,
          }))}
          query={query}
          onQueryChange={setQuery}
          value={selected}
          onChange={setSelected}
          disabled={ports.length === 0}
        />
        {candidates.length === 0 && (
          <p role="status">
            No game or port matches this search. Change the search or browse Find games.
          </p>
        )}
        {port && (
          <>
            <div className="add-selected-game">
              <ArtworkImage port={port} quietFallback className="add-selected-artwork" />
              <div>
                <strong>{gameTitle(port)}</strong>
                <span>{gameProjectLabel(port)}</span>
              </div>
            </div>
            {!candidates.includes(port) && (
              <p className="text-sm text-pc-muted-foreground">
                Selected game retained outside this search.
              </p>
            )}
            {profile ? (
              <Button
                id="add-games-check-files"
                variant="primary"
                disabled={refreshFailed}
                onClick={() => onCheckFiles(port.id, profile.id)}
              >
                Choose files to check…
                <Icon glyph={ArrowRight} size="sm" />
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
              <Icon glyph={ArrowRight} size="sm" />
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
      <p className="add-games-retained-note">
        You can leave this workspace and keep browsing. Your choices stay here; running tasks remain
        in Activity.
      </p>
    </section>
  );
}
