//! Read-only projection of successful-launch history for operating-system
//! shortcuts such as the Windows taskbar jump list. Core's `launch_history`
//! remains the only authority; a shortcut only names a port to open.
use super::PortcoveService;
use crate::Result;
use schemars::JsonSchema;
use serde::Serialize;

/// The most entries any caller may request; history reads stay small.
pub const RECENTLY_PLAYED_LIMIT: usize = 10;

/// A game whose latest successful launch is recent and which can still be
/// opened from this library. Readiness is not assessed: starting it still goes
/// through the ordinary launch checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct RecentlyPlayedGame {
    pub port_id: String,
    pub name: String,
    pub original_game_title: Option<String>,
    pub variant_label: Option<String>,
    /// Unix seconds of the latest successful launch.
    pub last_launched_at: i64,
}

impl PortcoveService {
    /// Newest-first successful launches, at most `limit` (capped at
    /// [`RECENTLY_PLAYED_LIMIT`]), for ports in the current catalog that still
    /// have an active installation or registered external runtime.
    pub fn recently_played(&self, limit: usize) -> Result<Vec<RecentlyPlayedGame>> {
        let limit = limit.min(RECENTLY_PLAYED_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }
        // Read a bounded surplus so ports missing from the catalog do not
        // shorten the list when enough other history exists.
        let history = self
            .library
            .recently_played_installed_ports(limit.saturating_mul(4))?;
        Ok(history
            .into_iter()
            .filter_map(|(port_id, last_launched_at)| {
                let port = self.catalog.port(&port_id).ok()?;
                let presentation = port.presentation.as_ref();
                Some(RecentlyPlayedGame {
                    name: port.name.clone(),
                    original_game_title: presentation
                        .and_then(|value| value.original_game_title.clone()),
                    variant_label: presentation.and_then(|value| value.variant_label.clone()),
                    port_id,
                    last_launched_at,
                })
            })
            .take(limit)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Library;
    use rusqlite::params;

    fn activate(service: &PortcoveService, port_id: &str) {
        let connection = service.library.connection().unwrap();
        let install_id = format!("install-{port_id}");
        connection
            .execute(
                "INSERT INTO installs(id, port_id, version, path, channel, installed_at, verified)
                 VALUES (?1, ?2, '1.0.0', ?3, 'stable', 1, 1)",
                params![install_id, port_id, format!("installs/{port_id}")],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO port_settings(port_id, channel, update_policy, active_install_id)
                 VALUES (?1, 'stable', 'manual', ?2)",
                params![port_id, install_id],
            )
            .unwrap();
    }

    fn played(service: &PortcoveService, port_id: &str, at: i64) {
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO launch_history(port_id, last_launched_at, successful_launches)
                 VALUES (?1, ?2, 1)",
                params![port_id, at],
            )
            .unwrap();
    }

    #[test]
    fn recent_play_is_newest_first_and_limited_to_installed_catalog_ports() {
        let temporary = tempfile::tempdir().unwrap();
        let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
        let ids = service
            .catalog
            .ports()
            .iter()
            .take(4)
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 4, "the embedded catalog provides several ports");
        let (older, newer, removed, never_installed) = (&ids[0], &ids[1], &ids[2], &ids[3]);
        activate(&service, older);
        activate(&service, newer);
        activate(&service, "retired-port-not-in-catalog");
        played(&service, older, 100);
        played(&service, newer, 300);
        played(&service, never_installed, 400);
        played(&service, "retired-port-not-in-catalog", 500);
        // A removed installation keeps its history row but has no active slot.
        played(&service, removed, 200);

        let recent = service.recently_played(RECENTLY_PLAYED_LIMIT).unwrap();
        assert_eq!(
            recent
                .iter()
                .map(|game| (game.port_id.as_str(), game.last_launched_at))
                .collect::<Vec<_>>(),
            [(newer.as_str(), 300), (older.as_str(), 100)]
        );
        assert_eq!(recent[0].name, service.catalog.port(newer).unwrap().name);
        assert_eq!(service.recently_played(1).unwrap().len(), 1);
        assert!(service.recently_played(0).unwrap().is_empty());
    }

    #[test]
    fn recent_play_never_exceeds_the_documented_bound() {
        let temporary = tempfile::tempdir().unwrap();
        let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
        let ids = service
            .catalog
            .ports()
            .iter()
            .take(RECENTLY_PLAYED_LIMIT + 2)
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        for (index, id) in ids.iter().enumerate() {
            activate(&service, id);
            played(&service, id, i64::try_from(index).unwrap());
        }
        let recent = service.recently_played(usize::MAX).unwrap();
        assert_eq!(recent.len(), RECENTLY_PLAYED_LIMIT.min(ids.len()));
        assert_eq!(recent[0].port_id, *ids.last().unwrap());
    }
}
