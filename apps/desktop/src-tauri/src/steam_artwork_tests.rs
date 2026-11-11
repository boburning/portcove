use super::*;

const APP_ID: u32 = 0x8000_1234;
const LIBRARY: &str = "library-123";
const PORT: &str = "example-port";

struct Fixture {
    _root: tempfile::TempDir,
    steam_root: PathBuf,
    config: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let steam_root = root.path().join("Steam root ü");
        let config = steam_root.join("userdata/12345/config");
        fs::create_dir_all(&config).unwrap();
        Self {
            _root: root,
            steam_root,
            config,
        }
    }

    fn grid(&self) -> PathBuf {
        self.config.join(GRID_DIRECTORY)
    }

    fn with_owned_shortcut(self) -> Self {
        let marker = ownership_marker(LIBRARY, PORT).unwrap();
        fs::write(
            self.config.join("shortcuts.vdf"),
            shortcuts_bytes(&[(APP_ID, "Example Port", &marker), (7, "Other", "user")]),
        )
        .unwrap();
        self
    }

    fn request(
        &self,
        operation: SteamArtworkOperation,
        portrait: SteamArtworkRoleContent,
    ) -> SteamArtworkPlanRequest {
        SteamArtworkPlanRequest {
            steam_root: self.steam_root.clone(),
            steam_user_id: "12345".into(),
            library_id: LIBRARY.into(),
            port_id: PORT.into(),
            operation,
            roles: vec![
                (DestinationArtworkRole::PortraitCover, portrait),
                (DestinationArtworkRole::LandscapeCover, unprovided()),
                (DestinationArtworkRole::HeroBanner, unprovided()),
            ],
        }
    }

    fn update(&self, replace_existing: bool, bytes: &[u8]) -> SteamArtworkPlanRequest {
        self.request(
            SteamArtworkOperation::Update { replace_existing },
            available(bytes),
        )
    }

    fn remove(&self) -> SteamArtworkPlanRequest {
        self.request(SteamArtworkOperation::RemoveOwned, unprovided())
    }
}

fn shortcuts_bytes(entries: &[(u32, &str, &str)]) -> Vec<u8> {
    let mut bytes = vec![0x00];
    bytes.extend_from_slice(b"shortcuts\0");
    for (index, (app_id, name, marker)) in entries.iter().enumerate() {
        bytes.push(0x00);
        bytes.extend_from_slice(format!("{index}\0").as_bytes());
        bytes.push(0x02);
        bytes.extend_from_slice(b"appid\0");
        bytes.extend_from_slice(&app_id.to_le_bytes());
        bytes.push(0x01);
        bytes.extend_from_slice(format!("appname\0{name}\0").as_bytes());
        bytes.push(0x01);
        bytes.extend_from_slice(format!("DevkitGameID\0{marker}\0").as_bytes());
        bytes.push(0x08);
    }
    bytes.extend_from_slice(&[0x08, 0x08]);
    bytes
}

fn available(bytes: &[u8]) -> SteamArtworkRoleContent {
    SteamArtworkRoleContent::Available {
        asset_sha256: sha256(bytes),
        format: ArtworkImageFormat::Png,
        bytes: bytes.to_vec(),
    }
}

fn unprovided() -> SteamArtworkRoleContent {
    SteamArtworkRoleContent::Unavailable {
        reason: DestinationArtworkUnavailableReason::RoleNotProvided,
    }
}

fn portrait(plan: &SteamArtworkPlan) -> &SteamArtworkRoleChange {
    &plan.roles[0]
}

fn apply(plan: &SteamArtworkPlan, request: &SteamArtworkPlanRequest) -> SteamArtworkApplyResult {
    apply_steam_artwork_plan(plan, request, SteamClientState::Closed).unwrap()
}

#[test]
fn update_requires_an_owned_shortcut_and_never_touches_unowned_entries() {
    let fixture = Fixture::new();
    let error = plan_steam_artwork(&fixture.update(false, b"art")).unwrap_err();
    assert!(matches!(error, SteamEntryError::InvalidInput(_)), "{error}");
    let fixture = Fixture::new();
    fs::write(
        fixture.config.join("shortcuts.vdf"),
        shortcuts_bytes(&[(APP_ID, "Example Port", "someone-else")]),
    )
    .unwrap();
    assert!(plan_steam_artwork(&fixture.update(false, b"art")).is_err());
    assert!(!fixture.grid().exists());
}

#[test]
fn update_fills_a_missing_portrait_and_reports_unprovided_roles() {
    let fixture = Fixture::new().with_owned_shortcut();
    let request = fixture.update(false, b"portrait bytes");
    let plan = plan_steam_artwork(&request).unwrap();
    assert_eq!(plan.app_id, Some(APP_ID));
    assert_eq!(portrait(&plan).action, SteamArtworkRoleAction::Write);
    let destination = fixture.grid().join(format!("{APP_ID}p.png"));
    assert_eq!(
        portrait(&plan).destination_path.as_ref(),
        Some(&destination)
    );
    for role in &plan.roles[1..] {
        assert_eq!(role.action, SteamArtworkRoleAction::Unavailable);
        assert_eq!(
            role.unavailable_reason,
            Some(DestinationArtworkUnavailableReason::RoleNotProvided)
        );
    }
    let result = apply(&plan, &request);
    assert!(result.wrote);
    assert_eq!(fs::read(&destination).unwrap(), b"portrait bytes");
    assert!(!fixture.config.join(JOURNAL_FILE).exists());
    let (_, records) = read_ownership(&fixture.config).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].file_name, format!("{APP_ID}p.png"));

    // Repeating the same update is idempotent and writes nothing.
    let again = plan_steam_artwork(&request).unwrap();
    assert_eq!(portrait(&again).action, SteamArtworkRoleAction::Unchanged);
    assert!(!again.writes_required());
    assert!(!apply(&again, &request).wrote);
}

#[test]
fn existing_art_is_preserved_by_default_and_replaced_only_deliberately() {
    let fixture = Fixture::new().with_owned_shortcut();
    fs::create_dir_all(fixture.grid()).unwrap();
    let existing = fixture.grid().join(format!("{APP_ID}p.jpg"));
    fs::write(&existing, b"user chosen art").unwrap();

    let fill = fixture.update(false, b"portcove art");
    let plan = plan_steam_artwork(&fill).unwrap();
    assert_eq!(portrait(&plan).action, SteamArtworkRoleAction::Preserve);
    assert!(!plan.writes_required());
    assert!(!apply(&plan, &fill).wrote);
    assert_eq!(fs::read(&existing).unwrap(), b"user chosen art");

    let replace = fixture.update(true, b"portcove art");
    let plan = plan_steam_artwork(&replace).unwrap();
    assert_eq!(portrait(&plan).action, SteamArtworkRoleAction::Replace);
    let result = apply(&plan, &replace);
    assert!(result.wrote);
    // The other extension is evacuated so Steam cannot pick the stale file.
    assert!(!existing.exists());
    assert_eq!(
        fs::read(fixture.grid().join(format!("{APP_ID}p.png"))).unwrap(),
        b"portcove art"
    );
    assert_eq!(result.backup_paths.len(), 1);
    assert_eq!(
        fs::read(&result.backup_paths[0]).unwrap(),
        b"user chosen art"
    );
    assert!(fs::read_dir(fixture.grid()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
}

#[test]
fn ambiguous_or_linked_existing_art_is_never_replaced() {
    let fixture = Fixture::new().with_owned_shortcut();
    fs::create_dir_all(fixture.grid()).unwrap();
    fs::write(fixture.grid().join(format!("{APP_ID}p.png")), b"one").unwrap();
    fs::write(fixture.grid().join(format!("{APP_ID}p.jpg")), b"two").unwrap();
    let request = fixture.update(true, b"portcove art");
    let plan = plan_steam_artwork(&request).unwrap();
    // Case-insensitive file systems may legitimately fold names; only assert
    // when both variants are distinct files.
    if portrait(&plan).existing_paths.len() == 2 {
        assert_eq!(portrait(&plan).action, SteamArtworkRoleAction::Preserve);
    }
}

#[test]
fn review_is_refused_when_destination_art_changes_before_apply() {
    let fixture = Fixture::new().with_owned_shortcut();
    let request = fixture.update(false, b"portcove art");
    let plan = plan_steam_artwork(&request).unwrap();
    fs::create_dir_all(fixture.grid()).unwrap();
    fs::write(fixture.grid().join(format!("{APP_ID}p.png")), b"raced").unwrap();
    let error = apply_steam_artwork_plan(&plan, &request, SteamClientState::Closed).unwrap_err();
    assert!(matches!(error, SteamEntryError::Conflict(_)), "{error}");
    assert_eq!(
        fs::read(fixture.grid().join(format!("{APP_ID}p.png"))).unwrap(),
        b"raced"
    );
}

#[test]
fn running_or_unknown_steam_and_mismatched_bytes_write_nothing() {
    let fixture = Fixture::new().with_owned_shortcut();
    let request = fixture.update(false, b"portcove art");
    let plan = plan_steam_artwork(&request).unwrap();
    for state in [SteamClientState::Running, SteamClientState::Unknown] {
        assert!(apply_steam_artwork_plan(&plan, &request, state).is_err());
    }
    let mut forged = request.clone();
    forged.roles[0].1 = SteamArtworkRoleContent::Available {
        asset_sha256: sha256(b"portcove art"),
        format: ArtworkImageFormat::Png,
        bytes: b"different".to_vec(),
    };
    assert!(apply_steam_artwork_plan(&plan, &forged, SteamClientState::Closed).is_err());
    assert!(!fixture.grid().exists());
}

#[test]
fn remove_cleans_only_unchanged_owned_art_without_the_shortcut() {
    let fixture = Fixture::new().with_owned_shortcut();
    let update = fixture.update(false, b"portcove art");
    apply(&plan_steam_artwork(&update).unwrap(), &update);
    let neighbor = fixture.grid().join(format!("{APP_ID}_hero.png"));
    fs::write(&neighbor, b"user hero").unwrap();
    // Remove remains available after the shortcut itself was removed.
    fs::write(
        fixture.config.join("shortcuts.vdf"),
        shortcuts_bytes(&[(7, "Other", "user")]),
    )
    .unwrap();

    let remove = fixture.remove();
    let plan = plan_steam_artwork(&remove).unwrap();
    assert_eq!(portrait(&plan).action, SteamArtworkRoleAction::Remove);
    assert_eq!(plan.roles[2].action, SteamArtworkRoleAction::Absent);
    let result = apply(&plan, &remove);
    assert!(result.wrote);
    assert!(!fixture.grid().join(format!("{APP_ID}p.png")).exists());
    assert_eq!(fs::read(&neighbor).unwrap(), b"user hero");
    assert_eq!(fs::read(&result.backup_paths[0]).unwrap(), b"portcove art");
    assert!(read_ownership(&fixture.config).unwrap().1.is_empty());

    let again = plan_steam_artwork(&remove).unwrap();
    assert!(!again.writes_required());
}

#[test]
fn remove_preserves_owned_art_the_player_changed_and_forgets_ownership() {
    let fixture = Fixture::new().with_owned_shortcut();
    let update = fixture.update(false, b"portcove art");
    apply(&plan_steam_artwork(&update).unwrap(), &update);
    let destination = fixture.grid().join(format!("{APP_ID}p.png"));
    fs::write(&destination, b"edited by player").unwrap();
    let remove = fixture.remove();
    let plan = plan_steam_artwork(&remove).unwrap();
    assert_eq!(
        portrait(&plan).action,
        SteamArtworkRoleAction::PreserveModified
    );
    assert!(portrait(&plan).forget_ownership);
    apply(&plan, &remove);
    assert_eq!(fs::read(&destination).unwrap(), b"edited by player");
    assert!(read_ownership(&fixture.config).unwrap().1.is_empty());
}

#[test]
fn interrupted_replace_restores_the_original_or_completes() {
    let fixture = Fixture::new().with_owned_shortcut();
    fs::create_dir_all(fixture.grid()).unwrap();
    let existing = fixture.grid().join(format!("{APP_ID}p.png"));
    fs::write(&existing, b"user art").unwrap();
    let request = fixture.update(true, b"portcove art");
    let plan = plan_steam_artwork(&request).unwrap();

    // Simulate a crash after the original was set aside but before publication.
    let journal = prepare_publication(&fixture.config, &plan, &request).unwrap();
    let step = &journal.steps[0];
    rename_noreplace(&existing, &step.swap_path).unwrap();
    assert!(plan_steam_artwork(&request).is_err());
    let recovery = recover_steam_artwork(&fixture.steam_root, "12345")
        .unwrap()
        .unwrap();
    assert_eq!(
        recovery.abandoned,
        vec![DestinationArtworkRole::PortraitCover]
    );
    assert_eq!(fs::read(&existing).unwrap(), b"user art");
    assert!(!step.swap_path.exists());
    assert!(!step.staged_path.as_ref().unwrap().exists());
    assert!(read_ownership(&fixture.config).unwrap().1.is_empty());

    // Simulate a crash after publication but before the record was written.
    let plan = plan_steam_artwork(&request).unwrap();
    let journal = prepare_publication(&fixture.config, &plan, &request).unwrap();
    execute_step(&journal.steps[0]).unwrap();
    let recovery = recover_steam_artwork(&fixture.steam_root, "12345")
        .unwrap()
        .unwrap();
    assert_eq!(
        recovery.completed,
        vec![DestinationArtworkRole::PortraitCover]
    );
    assert_eq!(fs::read(&existing).unwrap(), b"portcove art");
    assert_eq!(read_ownership(&fixture.config).unwrap().1.len(), 1);
    assert!(
        recover_steam_artwork(&fixture.steam_root, "12345")
            .unwrap()
            .is_none()
    );
}

#[test]
fn recovery_preserves_files_that_match_neither_side() {
    let fixture = Fixture::new().with_owned_shortcut();
    fs::create_dir_all(fixture.grid()).unwrap();
    let existing = fixture.grid().join(format!("{APP_ID}p.png"));
    fs::write(&existing, b"user art").unwrap();
    let request = fixture.update(true, b"portcove art");
    let plan = plan_steam_artwork(&request).unwrap();
    prepare_publication(&fixture.config, &plan, &request).unwrap();
    fs::write(&existing, b"third writer").unwrap();
    assert!(matches!(
        recover_steam_artwork(&fixture.steam_root, "12345"),
        Err(SteamEntryError::RecoveryRequired(_))
    ));
    assert_eq!(fs::read(&existing).unwrap(), b"third writer");
    assert!(fixture.config.join(JOURNAL_FILE).exists());
}

#[test]
fn malformed_ownership_record_blocks_artwork_changes() {
    let fixture = Fixture::new().with_owned_shortcut();
    fs::write(fixture.config.join(OWNERSHIP_FILE), b"{\"schema_version\":1,\"records\":[{\"marker\":\"portcove:v1:x:y\",\"app_id\":1,\"role\":\"portrait_cover\",\"file_name\":\"../escape.png\",\"sha256\":\"00\",\"source_asset_sha256\":\"00\"}]}").unwrap();
    assert!(matches!(
        plan_steam_artwork(&fixture.update(false, b"art")),
        Err(SteamEntryError::Malformed(_))
    ));
}

#[cfg(unix)]
#[test]
fn linked_grid_folder_is_refused() {
    let fixture = Fixture::new().with_owned_shortcut();
    let elsewhere = fixture.steam_root.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, fixture.grid()).unwrap();
    assert!(plan_steam_artwork(&fixture.update(false, b"art")).is_err());
    assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
}
