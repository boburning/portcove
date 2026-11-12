import { useState } from "react";
import type { PortDefinition, PortStatus, SourceProfile, SourceRecord } from "../types";
import { GameFileLibraries } from "./GameFileLibraries";
import { RegisteredSourceSetup } from "./RegisteredSourceSetup";
import type { Perform } from "../features/operations/use-operation-state";
import { Button } from "./ui/button";
import { ArrowRight, FolderInput, FolderSearch, Gamepad2 } from "lucide-react";
import { Icon } from "./ui";

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
  onBrowseCatalog,
  onCopyInstallation,
  setupSource,
  setSetupSource,
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
  onBrowseCatalog: () => void;
  onCopyInstallation: () => void;
  setupSource?: SourceRecord | undefined;
  setSetupSource: (source?: SourceRecord) => void;
}) {
  // Choosing a game always happens in Discover, where artwork and details help.
  const [mode, setMode] = useState<"choose" | "folders" | "existing">("choose");
  const [foldersVisited, setFoldersVisited] = useState(false);
  return (
    <section
      hidden={!active}
      aria-label="Add games workspace"
      className="add-games max-w-[66rem] min-w-0 wrap-anywhere"
    >
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
          variant="outline"
          className="add-route-choice"
          aria-label="Browse games"
          aria-describedby="add-game-description"
          onClick={onBrowseCatalog}
        >
          <Icon glyph={Gamepad2} />
          <span>
            <strong className="block">Browse games</strong>
            <span id="add-game-description" className="add-route-description">
              Pick a game in Discover, then see what you need to play it.
            </span>
          </span>
          <Icon glyph={ArrowRight} size="sm" className="add-route-arrow" />
        </Button>
        <Button
          variant={mode === "folders" ? "selected" : "outline"}
          className="add-route-choice"
          aria-label="Scan a folder"
          aria-describedby="add-folder-description"
          aria-pressed={mode === "folders"}
          onClick={() => {
            setFoldersVisited(true);
            setMode("folders");
          }}
        >
          <Icon glyph={FolderSearch} />
          <span>
            <strong className="block">Scan a folder</strong>
            <span id="add-folder-description" className="add-route-description">
              Choose a folder of your game files; Portcove finds the supported ones.
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
            <h3 className="text-base">Use the game where it is</h3>
            <p className="max-w-[65ch] text-pc-muted-foreground">
              Some ports can use an installation where it is. Choose the game to check its setup
              options. For this option, you’ll handle updates and backups.
            </p>
          </div>
          <Button variant="outline" onClick={onBrowseCatalog}>
            Browse games
            <Icon glyph={ArrowRight} size="sm" />
          </Button>
        </div>
      </section>
      {foldersVisited && (
        <div hidden={mode !== "folders"} className="add-route-panel">
          <GameFileLibraries
            scanAfterAdd
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
    </section>
  );
}
