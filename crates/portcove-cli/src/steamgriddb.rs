//! Thin SteamGridDB adapter. Core owns the player's key, the fixed-origin
//! client, result validation and failure outcomes; this module only parses,
//! reads a key without placing it in argv, and renders.
use crate::*;
use portcove_core::{
    SteamGridDbCandidate, SteamGridDbCheckStop, SteamGridDbGame, SteamGridDbImageCheck,
    SteamGridDbKeyStatus, SteamGridDbListingReport, SteamGridDbListingStatus,
    SteamGridDbSourceStatus, SteamGridDbUnknownReason, clear_steamgriddb_key,
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
        SteamGridDbCommand::CheckListings => {
            // Report only; the borrowed service runs the bounded network check in place.
            let report = tokio::task::block_in_place(|| service.check_steamgriddb_listings())?;
            render_read_success(mode, name, report, listing_report)
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

fn role_name(role: portcove_core::DestinationArtworkRole) -> &'static str {
    match role {
        portcove_core::DestinationArtworkRole::PortraitCover => "cover",
        portcove_core::DestinationArtworkRole::HeroBanner => "detail image",
        portcove_core::DestinationArtworkRole::LandscapeCover => "landscape image",
    }
}

fn image_finding(image: &SteamGridDbImageCheck) -> String {
    use SteamGridDbListingStatus as Listing;
    use SteamGridDbSourceStatus as Source;
    let found = match (image.listing, image.source) {
        (Listing::Listed, _) => "still listed".to_owned(),
        (Listing::NotListed, Source::Gone) => {
            "no longer listed, and SteamGridDB no longer serves the file".to_owned()
        }
        (Listing::NotListed, Source::Served) => {
            "no longer listed, but SteamGridDB still serves the file".to_owned()
        }
        (Listing::NotListed, _) => "no longer listed".to_owned(),
        (Listing::Unknown, _) => {
            let reason = match image.unknown_reason {
                Some(SteamGridDbUnknownReason::GameNotFound) => "SteamGridDB did not find the game",
                Some(SteamGridDbUnknownReason::TooManyImages) => {
                    "the game has more images than one check reads"
                }
                Some(SteamGridDbUnknownReason::RequestLimit) => {
                    "this check reached its request limit"
                }
                Some(SteamGridDbUnknownReason::CheckStopped) => "the check stopped first",
                Some(SteamGridDbUnknownReason::Unavailable) => "SteamGridDB could not be reached",
                Some(SteamGridDbUnknownReason::IncompleteListing)
                | Some(SteamGridDbUnknownReason::InvalidResponse)
                | None => "SteamGridDB did not return a complete listing",
            };
            format!("not confirmed ({reason})")
        }
    };
    format!(
        "{}  {} by {} (game {}): {found}",
        image.attribution.asset_id,
        role_name(image.attribution.role),
        human::clean(&image.attribution.author_name),
        image.attribution.game_id
    )
}

pub(crate) fn listing_report(report: &SteamGridDbListingReport) -> String {
    if report.images.is_empty() {
        return "Your library has no SteamGridDB images to check. Nothing was changed.".into();
    }
    let lines = report
        .images
        .iter()
        .map(image_finding)
        .collect::<Vec<_>>()
        .join("\n");
    let stopped = match &report.stopped {
        Some(SteamGridDbCheckStop::RateLimited {
            retry_after_seconds: Some(seconds),
        }) => format!(
            "\n\nSteamGridDB asked Portcove to slow down, so the check stopped early.\nNext step: Run the check again in {}.",
            wait_text(*seconds)
        ),
        Some(SteamGridDbCheckStop::RateLimited { .. }) => "\n\nSteamGridDB asked Portcove to slow down, so the check stopped early.\nNext step: Run the check again later.".into(),
        Some(SteamGridDbCheckStop::KeyRejected) => "\n\nSteamGridDB rejected your saved API key, so the check stopped early.\nNext step: Replace it with `portcove artwork steamgriddb set-key`.".into(),
        Some(SteamGridDbCheckStop::Unavailable) => "\n\nSteamGridDB could not be reached, so the check stopped early.\nNext step: Run the check again later.".into(),
        None => String::new(),
    };
    let count = report.images.len();
    format!(
        "SteamGridDB listing check: {count} {}\n\n{lines}\n\nThis check only reports. Every image, credit and choice was kept, and nothing changed in Steam.{stopped}",
        if count == 1 { "image" } else { "images" }
    )
}

/// A Retry-After wait in the largest whole unit a player would read.
fn wait_text(seconds: u64) -> String {
    let (amount, unit) = match seconds {
        0..=119 => (seconds.max(1), "second"),
        120..=7199 => (seconds.div_ceil(60), "minute"),
        _ => (seconds.div_ceil(3600), "hour"),
    };
    format!("{amount} {unit}{}", if amount == 1 { "" } else { "s" })
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
            (
                "artwork steamgriddb check-listings",
                "artwork.steamgriddb.check-listings",
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

    #[test]
    fn listing_report_explains_each_outcome_and_that_nothing_changed() {
        use portcove_core::{ArtworkAttribution, ArtworkProvider};
        assert!(
            listing_report(&SteamGridDbListingReport {
                checked_at: 0,
                images: Vec::new(),
                stopped: None,
            })
            .contains("no SteamGridDB images")
        );
        let image = |asset_id, listing, unknown_reason, source| SteamGridDbImageCheck {
            asset_sha256: "a".repeat(64),
            attribution: ArtworkAttribution {
                provider: ArtworkProvider::Steamgriddb,
                asset_id,
                game_id: 7,
                role: DestinationArtworkRole::PortraitCover,
                author_name: "Art\u{1b}[31mist".into(),
                author_steam64: None,
                source_url: "https://cdn2.steamgriddb.com/grid/1.png".into(),
                fetched_at: 0,
            },
            listing,
            unknown_reason,
            source,
        };
        let text = listing_report(&SteamGridDbListingReport {
            checked_at: 0,
            images: vec![
                image(
                    1,
                    SteamGridDbListingStatus::Listed,
                    None,
                    SteamGridDbSourceStatus::NotChecked,
                ),
                image(
                    2,
                    SteamGridDbListingStatus::NotListed,
                    None,
                    SteamGridDbSourceStatus::Gone,
                ),
                image(
                    3,
                    SteamGridDbListingStatus::NotListed,
                    None,
                    SteamGridDbSourceStatus::Served,
                ),
                image(
                    4,
                    SteamGridDbListingStatus::Unknown,
                    Some(SteamGridDbUnknownReason::GameNotFound),
                    SteamGridDbSourceStatus::Served,
                ),
            ],
            stopped: Some(SteamGridDbCheckStop::RateLimited {
                retry_after_seconds: Some(30),
            }),
        });
        assert!(text.contains("1  cover by Art"));
        assert!(!text.contains('\u{1b}'));
        assert!(text.contains("still listed"));
        assert!(text.contains("no longer listed, and SteamGridDB no longer serves the file"));
        assert!(text.contains("no longer listed, but SteamGridDB still serves the file"));
        assert!(text.contains("not confirmed (SteamGridDB did not find the game)"));
        assert!(text.contains("Every image, credit and choice was kept"));
        assert!(text.contains("again in 30 seconds"));
        assert!(text.starts_with("SteamGridDB listing check: 4 images"));
        let one = |stopped| {
            listing_report(&SteamGridDbListingReport {
                checked_at: 0,
                images: vec![image(
                    5,
                    SteamGridDbListingStatus::Unknown,
                    Some(SteamGridDbUnknownReason::CheckStopped),
                    SteamGridDbSourceStatus::NotChecked,
                )],
                stopped,
            })
        };
        assert!(one(None).starts_with("SteamGridDB listing check: 1 image\n"));
        assert!(one(Some(SteamGridDbCheckStop::KeyRejected)).contains("set-key"));
        assert!(one(Some(SteamGridDbCheckStop::Unavailable)).contains("could not be reached"));
        assert!(
            one(Some(SteamGridDbCheckStop::RateLimited {
                retry_after_seconds: None
            }))
            .contains("again later")
        );
        assert!(one(None).contains("not confirmed (the check stopped first)"));
        for (seconds, text) in [
            (0, "1 second"),
            (1, "1 second"),
            (90, "90 seconds"),
            (120, "2 minutes"),
            (3600, "60 minutes"),
            (7200, "2 hours"),
            (86_400, "24 hours"),
        ] {
            assert_eq!(wait_text(seconds), text);
        }
    }
}
