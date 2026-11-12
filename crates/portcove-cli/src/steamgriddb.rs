//! Thin SteamGridDB adapter. Core owns the player's key, the fixed-origin
//! client, result validation and failure outcomes; this module only parses,
//! reads a key without placing it in argv, and renders.
use crate::*;
use portcove_core::{
    SteamGridDbCandidate, SteamGridDbGame, SteamGridDbKeyStatus, clear_steamgriddb_key,
    search_steamgriddb_games, set_steamgriddb_key, steamgriddb_candidates, steamgriddb_key_status,
};

/// Core's client blocks on network and secure-store calls, so it runs off the
/// async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| PortcoveError::state(error.to_string()))?
}

pub(crate) async fn execute(
    command: SteamGridDbCommand,
    service: &PortcoveService,
    mode: OutputMode,
    non_interactive: bool,
) -> Result<()> {
    let name = command.name();
    match command {
        SteamGridDbCommand::Status => render_read_success(
            mode,
            name,
            blocking(steamgriddb_key_status).await?,
            key_status,
        ),
        SteamGridDbCommand::SetKey { stdin } => {
            let key = read_key(stdin, non_interactive)?;
            render_read_success(
                mode,
                name,
                blocking(move || set_steamgriddb_key(&key)).await?,
                key_status,
            )
        }
        SteamGridDbCommand::ClearKey => render_read_success(
            mode,
            name,
            blocking(clear_steamgriddb_key).await?,
            key_status,
        ),
        SteamGridDbCommand::Search { term } => render_read_success(
            mode,
            name,
            blocking(move || search_steamgriddb_games(&term)).await?,
            |games| search_results(games),
        ),
        SteamGridDbCommand::Choose {
            port_id,
            slot,
            game,
            candidate,
            expected_revision,
        } => {
            let slot = slot.into();
            let revision = match expected_revision {
                Some(value) => value,
                None => service.artwork(&port_id, slot)?.choice.revision,
            };
            // The service is borrowed, so the blocking fetch and ingestion run in
            // place on this worker thread rather than on a detached task.
            let state = tokio::task::block_in_place(|| {
                service.choose_steamgriddb_artwork(&port_id, slot, game, candidate, revision)
            })?;
            render_read_success(mode, name, state, |state| {
                human_adapters::artwork_state(state, service.catalog())
            })
        }
        SteamGridDbCommand::Candidates { game_id, role } => render_read_success(
            mode,
            name,
            blocking(move || steamgriddb_candidates(game_id, role.into())).await?,
            |candidates| candidate_results(candidates),
        ),
    }
}

fn read_key(stdin: bool, non_interactive: bool) -> Result<String> {
    let key = if stdin {
        let mut key = String::new();
        io::stdin().read_to_string(&mut key)?;
        key
    } else if non_interactive {
        return Err(PortcoveError::usage(
            "artwork steamgriddb set-key requires --stdin under --non-interactive",
        ));
    } else {
        rpassword::prompt_password("SteamGridDB API key: ")
            .map_err(|error| PortcoveError::state(error.to_string()))?
    };
    // Core validates the trimmed key and never echoes it.
    Ok(key)
}

pub(crate) fn key_status(status: &SteamGridDbKeyStatus) -> String {
    if status.configured {
        "SteamGridDB: your API key is saved on this device.\nNext step: Search with `portcove artwork steamgriddb search <game name>`.".into()
    } else {
        "SteamGridDB: no API key is saved.\nNext step: Create a key at steamgriddb.com/profile/preferences/api, then run `portcove artwork steamgriddb set-key`.".into()
    }
}

pub(crate) fn search_results(games: &[SteamGridDbGame]) -> String {
    if games.is_empty() {
        return "No SteamGridDB games matched.\nNext step: Try a shorter or differently spelled name.".into();
    }
    let lines = games
        .iter()
        .map(|game| {
            format!(
                "{}  {}{}",
                game.id,
                human::clean(&game.name),
                if game.verified { " (verified)" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "SteamGridDB matches: {}\n\n{lines}\n\nMatches are suggestions; confirm the game before choosing artwork.\nNext step: List images with `portcove artwork steamgriddb candidates <id> --role portrait-cover`.",
        games.len()
    )
}

pub(crate) fn candidate_results(candidates: &[SteamGridDbCandidate]) -> String {
    if candidates.is_empty() {
        return "No suitable static PNG or JPEG images were found for this role.\nNext step: Try another role, or search again for a different match of the game.".into();
    }
    let lines = candidates
        .iter()
        .map(|candidate| {
            format!(
                "{}  {}x{} {}  by {}\n    {}",
                candidate.id,
                candidate.width,
                candidate.height,
                human::clean(&candidate.style),
                human::clean(&candidate.author.name),
                human::clean(&candidate.url)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "SteamGridDB images: {}\n\n{lines}\n\nImages are suggestions from SteamGridDB artists; nothing has been chosen or downloaded.\nNext step: Choose one with `portcove artwork steamgriddb choose <port-id> --game <game-id> --candidate <id>`.",
        candidates.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcove_core::{DestinationArtworkRole, SteamGridDbAuthor};

    #[test]
    fn commands_parse_with_names_and_startup_modes() {
        for (arguments, expected, mode) in [
            (
                "artwork steamgriddb status",
                "artwork.steamgriddb.status",
                crate::startup::StartupMode::ReadOnly,
            ),
            (
                "artwork steamgriddb set-key --stdin",
                "artwork.steamgriddb.set-key",
                crate::startup::StartupMode::Recovering,
            ),
            (
                "artwork steamgriddb clear-key",
                "artwork.steamgriddb.clear-key",
                crate::startup::StartupMode::Recovering,
            ),
            (
                "artwork steamgriddb search zelda",
                "artwork.steamgriddb.search",
                crate::startup::StartupMode::ReadOnly,
            ),
            (
                "artwork steamgriddb choose shipwright --slot detail --game 42 --candidate 7 --expected-revision 3",
                "artwork.steamgriddb.choose",
                crate::startup::StartupMode::Recovering,
            ),
            (
                "artwork steamgriddb candidates 42 --role hero-banner",
                "artwork.steamgriddb.candidates",
                crate::startup::StartupMode::ReadOnly,
            ),
        ] {
            let parsed = Cli::try_parse_from(
                std::iter::once("portcove").chain(arguments.split_whitespace()),
            )
            .unwrap_or_else(|error| panic!("{arguments}: {error}"));
            assert_eq!(crate::command_name(&parsed.command), expected);
            assert_eq!(crate::startup::startup_mode(&parsed.command), mode);
        }
        // The key is never accepted as an argument.
        assert!(
            Cli::try_parse_from(["portcove", "artwork", "steamgriddb", "set-key", "abc"]).is_err()
        );
        assert!(
            Cli::try_parse_from(["portcove", "artwork", "steamgriddb", "candidates", "42"])
                .is_err()
        );
        // A choice names the provider image, never a URL or file.
        assert!(
            Cli::try_parse_from([
                "portcove",
                "artwork",
                "steamgriddb",
                "choose",
                "shipwright",
                "--game",
                "42"
            ])
            .is_err()
        );
    }

    #[test]
    fn non_interactive_key_entry_requires_stdin() {
        let error = read_key(false, true).unwrap_err();
        assert_eq!(error.code, portcove_core::ErrorCode::Usage);
        assert!(error.message.contains("--stdin"));
    }

    #[test]
    fn human_output_states_suggestions_and_never_a_key() {
        assert!(key_status(&SteamGridDbKeyStatus { configured: true }).contains("saved"));
        assert!(key_status(&SteamGridDbKeyStatus { configured: false }).contains("set-key"));
        assert!(search_results(&[]).contains("No SteamGridDB games"));
        let games = search_results(&[SteamGridDbGame {
            id: 7,
            name: "Example\u{1b}[31m Game".into(),
            verified: true,
        }]);
        assert!(games.contains("7  Example") && games.contains("(verified)"));
        assert!(!games.contains('\u{1b}'));
        let images = candidate_results(&[SteamGridDbCandidate {
            id: 9,
            role: DestinationArtworkRole::HeroBanner,
            url: "https://cdn2.steamgriddb.com/hero/9.png".into(),
            thumb: "https://cdn2.steamgriddb.com/thumb/9.png".into(),
            mime: "image/png".into(),
            width: 1920,
            height: 620,
            style: "alternate".into(),
            score: 1,
            author: SteamGridDbAuthor {
                name: "Artist".into(),
                steam64: None,
            },
        }]);
        assert!(images.contains("1920x620") && images.contains("by Artist"));
        assert!(images.contains("nothing has been chosen or downloaded"));
    }
}
