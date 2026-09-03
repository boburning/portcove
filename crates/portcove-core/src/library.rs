use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use directories::ProjectDirs;
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::{
    ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind, ArtifactIdentity,
    InstallRecord, LaunchSessionPhase, LaunchSessionRecord, PortStatus, PortcoveError,
    ReleaseChannel, Result, SourceRecord, StorageSummary, UpdateCheck, UpdatePolicy,
    UpdateSnapshot,
    authorization::{AuthorizationStore, DestructiveAuthorization},
    database,
};

#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
    authorizations: AuthorizationStore,
    _lease: std::sync::Arc<crate::library_access::LibraryLease>,
}

#[derive(Debug)]
pub struct PortOperationGuard {
    file: File,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StatusReadMetrics {
    pub sqlite_query_count: usize,
}

impl StatusReadMetrics {
    fn record_query(&mut self) {
        self.sqlite_query_count += 1;
    }
}

impl Drop for PortOperationGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HttpCacheEntry {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub body: String,
}

impl Library {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let mut root = root.into();
        for _ in 0..8 {
            crate::path::unicode(&root, "library root")?;
            let lease = std::sync::Arc::new(crate::library_access::LibraryLease::acquire(&root)?);
            if let Some(destination) = crate::library_authority::open_target(&root)? {
                root = destination;
            } else {
                return Self::initialize(root, lease);
            }
        }
        Err(PortcoveError::state(
            "library relocation chain is cyclic or too long",
        ))
    }

    pub(crate) fn open_exclusive(root: &Path) -> Result<Self> {
        crate::path::unicode(root, "library root")?;
        let lease = std::sync::Arc::new(crate::library_access::LibraryLease::with_access(
            root,
            crate::library_access::LibraryAccess::Exclusive,
        )?);
        Self::initialize(root.to_path_buf(), lease)
    }

    pub(crate) fn initialize(
        root: PathBuf,
        lease: std::sync::Arc<crate::library_access::LibraryLease>,
    ) -> Result<Self> {
        let root = std::path::absolute(root)?;
        let library = Self {
            root,
            authorizations: AuthorizationStore::default(),
            _lease: lease,
        };
        library.create_layout()?;
        library.migrate()?;
        Ok(library)
    }

    pub fn open_default() -> Result<Self> {
        Self::open(Self::default_root()?)
    }

    pub fn default_root() -> Result<PathBuf> {
        let project = ProjectDirs::from("io.github", "Portcove", "Portcove").ok_or_else(|| {
            PortcoveError::state("could not determine the default Portcove data directory")
        })?;
        Ok(project.data_local_dir().join("library"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn issue_authorization(
        &self,
        action: &str,
        target: &str,
        fingerprint: &str,
    ) -> Result<DestructiveAuthorization> {
        self.authorizations.issue(action, target, fingerprint)
    }
    pub(crate) fn consume_authorization(
        &self,
        token: &str,
        action: &str,
        target: &str,
        fingerprint: &str,
    ) -> Result<()> {
        self.authorizations
            .consume(token, action, target, fingerprint)
    }
    pub(crate) fn consume_authorization_with_state(
        &self,
        token: &str,
        action: &str,
        target: &str,
        current_fingerprint: impl FnOnce() -> Result<String>,
    ) -> Result<()> {
        self.authorizations
            .consume_with_state(token, action, target, current_fingerprint)
    }

    pub fn storage_summary(&self) -> Result<StorageSummary> {
        Ok(StorageSummary {
            library_root: self.root.clone(),
            volume_total_bytes: fs2::total_space(&self.root)?,
            volume_available_bytes: fs2::available_space(&self.root)?,
        })
    }
    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }
    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }
    pub fn downloads_dir(&self) -> PathBuf {
        self.root.join("downloads")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }
    pub fn toolchains_dir(&self) -> PathBuf {
        self.root.join("toolchains")
    }
    pub fn user_dir(&self, port_id: &str) -> PathBuf {
        self.root.join("user").join(port_id)
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub(crate) fn recovery_dir(&self) -> PathBuf {
        self.root.join("recovery")
    }
    fn locks_dir(&self) -> PathBuf {
        self.root.join("locks")
    }

    pub fn try_lock_port(&self, port_id: &str, operation: &str) -> Result<PortOperationGuard> {
        self.lock_port(port_id, operation, None)
    }

    pub(crate) fn try_lock_source(&self, profile_id: &str) -> Result<PortOperationGuard> {
        let key = format!(
            "source-{}",
            hex::encode(Sha256::digest(profile_id.as_bytes()))
        );
        let file = self.acquire_lock(&key, profile_id, "change-source-reference")?;
        Ok(PortOperationGuard { file })
    }

    pub(crate) fn try_lock_activity(&self, id: &str) -> Result<PortOperationGuard> {
        let key = format!("activity-{}", hex::encode(Sha256::digest(id.as_bytes())));
        Ok(PortOperationGuard {
            file: self.acquire_lock(&key, id, "activity-owner")?,
        })
    }

    pub(crate) fn try_lock_port_for_launch_recovery(
        &self,
        port_id: &str,
        session_id: &str,
    ) -> Result<PortOperationGuard> {
        self.lock_port(port_id, "launch-recovery", Some(session_id))
    }

    fn lock_port(
        &self,
        port_id: &str,
        operation: &str,
        allowed_session_id: Option<&str>,
    ) -> Result<PortOperationGuard> {
        let key = hex::encode(Sha256::digest(port_id.as_bytes()));
        let mut file = self
            .acquire_lock(&key, port_id, operation)
            .map_err(|error| error.detail("port_id", port_id))?;
        if let Some(session) = self.launch_session_for_port(port_id)?
            && Some(session.id.as_str()) != allowed_session_id
        {
            return Err(PortcoveError::conflict(format!(
                "{port_id} has an unfinished launch session"
            ))
            .detail("port_id", port_id)
            .detail("operation", operation)
            .detail("launch_session_id", session.id)
            .detail("launch_phase", session.phase.to_string()));
        }
        file.set_len(0)?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({
                "operation": operation,
                "pid": std::process::id(),
                "port_id": port_id,
                "started_at": Self::now(),
            }),
        )?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(PortOperationGuard { file })
    }

    fn acquire_lock(&self, key: &str, target: &str, operation: &str) -> Result<File> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.locks_dir().join(format!("{key}.lock")))?;
        if let Err(error) = file.try_lock_exclusive() {
            if error.kind() == fs2::lock_contended_error().kind() {
                return Err(PortcoveError::conflict(format!(
                    "{target} is busy in another Portcove process"
                ))
                .detail("resource_id", target)
                .detail("operation", operation));
            }
            return Err(error.into());
        }
        Ok(file)
    }

    fn create_layout(&self) -> Result<()> {
        for directory in [
            self.versions_dir(),
            self.staging_dir(),
            self.downloads_dir(),
            self.backups_dir(),
            self.toolchains_dir(),
            self.root.join("user"),
            self.logs_dir(),
            self.recovery_dir(),
            self.locks_dir(),
        ] {
            fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    pub(crate) fn connection(&self) -> Result<Connection> {
        database::connect(&self.root)
    }

    fn migrate(&self) -> Result<()> {
        database::migrate(&self.root)
    }

    pub(crate) fn begin_activity(
        &self,
        operation: ActivityOperation,
        target_kind: ActivityTargetKind,
        target_id: Option<&str>,
    ) -> Result<ActivityRecord> {
        self.begin_identified_activity(uuid::Uuid::new_v4(), operation, target_kind, target_id)
    }

    pub(crate) fn begin_identified_activity(
        &self,
        id: uuid::Uuid,
        operation: ActivityOperation,
        target_kind: ActivityTargetKind,
        target_id: Option<&str>,
    ) -> Result<ActivityRecord> {
        let activity = ActivityRecord {
            id: id.to_string(),
            operation,
            target_kind,
            target_id: target_id.map(str::to_owned),
            status: ActivityStatus::Running,
            message: None,
            started_at: Self::now(),
            finished_at: None,
            cancellation: None,
        };
        self.connection()?.execute(
            "INSERT INTO activity_history(
               id, operation, target_kind, target_id, status, message, started_at, finished_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL)",
            params![
                activity.id,
                activity.operation.to_string(),
                activity.target_kind.to_string(),
                activity.target_id,
                activity.status.to_string(),
                activity.started_at,
            ],
        )?;
        Ok(activity)
    }

    pub(crate) fn finish_activity(
        &self,
        id: &str,
        status: ActivityStatus,
        message: Option<&str>,
    ) -> Result<()> {
        Self::finish_activity_on(&self.connection()?, id, status, message)
    }

    pub(crate) fn finish_activity_on(
        connection: &Connection,
        id: &str,
        status: ActivityStatus,
        message: Option<&str>,
    ) -> Result<()> {
        if status == ActivityStatus::Running {
            return Err(PortcoveError::usage(
                "an activity cannot be finished with running status",
            ));
        }
        let changed = connection.execute(
            "UPDATE activity_history
             SET status=?2, message=?3, finished_at=?4, cancellation_phase=NULL, cancellation_owner=NULL
             WHERE id=?1 AND status='running'",
            params![id, status.to_string(), message, Self::now()],
        )?;
        if changed == 0 {
            return Err(PortcoveError::state(format!(
                "running activity {id} was not found"
            )));
        }
        connection.execute(
            "DELETE FROM activity_history
             WHERE status != 'running'
               AND id NOT IN (
                 SELECT id FROM activity_history
                 WHERE status != 'running'
                 ORDER BY started_at DESC, rowid DESC
                 LIMIT 1000
               )",
            [],
        )?;
        Ok(())
    }

    pub(crate) fn finish_activity_once(
        &self,
        id: &str,
        status: ActivityStatus,
        message: &str,
    ) -> Result<()> {
        let recorded: String = self.connection()?.query_row(
            "SELECT status FROM activity_history WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        if recorded == "running" {
            self.finish_activity(id, status, Some(message))?;
        } else if recorded != status.to_string() {
            return Err(PortcoveError::conflict(
                "activity has a conflicting terminal outcome",
            ));
        }
        Ok(())
    }

    pub fn activities(&self, limit: usize) -> Result<Vec<ActivityRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, operation, target_kind, target_id, status, message, started_at, finished_at, cancellation_phase, cancel_requested
             FROM activity_history
             ORDER BY started_at DESC, rowid DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.clamp(1, 200) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, bool>(9)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                operation,
                target_kind,
                target_id,
                status,
                message,
                started_at,
                finished_at,
                phase,
                requested,
            ) = row?;
            Ok(ActivityRecord {
                id,
                operation: operation.parse()?,
                target_kind: target_kind.parse()?,
                target_id,
                status: status.parse()?,
                message,
                started_at,
                finished_at,
                cancellation: crate::CancellationState::from_columns(phase, requested)?,
            })
        })
        .collect()
    }

    pub(crate) fn store_update_snapshot(&self, check: &UpdateCheck) -> Result<UpdateSnapshot> {
        let snapshot = UpdateSnapshot {
            checked_at: Self::now(),
            check: check.clone(),
        };
        self.connection()?.execute(
            "INSERT INTO update_snapshots(port_id, check_json, checked_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(port_id) DO UPDATE SET
               check_json=excluded.check_json,
               checked_at=excluded.checked_at",
            params![
                check.port_id,
                serde_json::to_string(check)?,
                snapshot.checked_at
            ],
        )?;
        Ok(snapshot)
    }

    pub fn update_snapshot(&self, port_id: &str) -> Result<Option<UpdateSnapshot>> {
        let connection = self.connection()?;
        let stored: Option<(String, i64)> = connection
            .query_row(
                "SELECT check_json, checked_at FROM update_snapshots WHERE port_id=?1",
                [port_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        stored
            .map(|(json, checked_at)| {
                Ok(UpdateSnapshot {
                    checked_at,
                    check: serde_json::from_str(&json)?,
                })
            })
            .transpose()
    }

    pub fn record_successful_launch(&self, port_id: &str) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO launch_history(port_id, last_launched_at, successful_launches)
             VALUES (?1, ?2, 1)
             ON CONFLICT(port_id) DO UPDATE SET
               last_launched_at=excluded.last_launched_at,
               successful_launches=launch_history.successful_launches + 1",
            params![port_id, Self::now()],
        )?;
        Ok(())
    }

    pub(crate) fn create_launch_session(&self, session: &LaunchSessionRecord) -> Result<()> {
        let install_root = crate::path::unicode(&session.install_root, "install")?;
        self.connection()?.execute(
            "INSERT INTO launch_sessions(
               id, port_id, install_id, install_root, supervisor_pid, child_pid, phase,
               started_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session.id,
                session.port_id,
                session.install_id,
                install_root,
                session.supervisor_pid,
                session.child_pid,
                session.phase.to_string(),
                session.started_at,
                session.updated_at,
            ],
        )?;
        Ok(())
    }

    pub(crate) fn update_launch_session(
        &self,
        id: &str,
        child_pid: Option<u32>,
        phase: LaunchSessionPhase,
    ) -> Result<()> {
        let changed = self.connection()?.execute(
            "UPDATE launch_sessions
             SET child_pid=COALESCE(?2, child_pid), phase=?3, updated_at=?4
             WHERE id=?1",
            params![id, child_pid, phase.to_string(), Self::now()],
        )?;
        if changed == 0 {
            return Err(PortcoveError::state(format!(
                "launch session {id} was not found"
            )));
        }
        Ok(())
    }

    pub(crate) fn remove_launch_session(&self, id: &str) -> Result<()> {
        self.connection()?
            .execute("DELETE FROM launch_sessions WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn launch_sessions(&self) -> Result<Vec<LaunchSessionRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, port_id, install_id, install_root, supervisor_pid, child_pid, phase,
                    started_at, updated_at
             FROM launch_sessions ORDER BY started_at, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, Option<u32>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                port_id,
                install_id,
                install_root,
                supervisor_pid,
                child_pid,
                phase,
                started_at,
                updated_at,
            ) = row?;
            Ok(LaunchSessionRecord {
                id,
                port_id,
                install_id,
                install_root: PathBuf::from(install_root),
                supervisor_pid,
                child_pid,
                phase: phase.parse()?,
                started_at,
                updated_at,
            })
        })
        .collect()
    }

    pub(crate) fn launch_session(&self, id: &str) -> Result<Option<LaunchSessionRecord>> {
        Ok(self
            .launch_sessions()?
            .into_iter()
            .find(|session| session.id == id))
    }

    fn launch_session_for_port(&self, port_id: &str) -> Result<Option<LaunchSessionRecord>> {
        Ok(self
            .launch_sessions()?
            .into_iter()
            .find(|session| session.port_id == port_id))
    }

    pub(crate) fn http_cache(&self, url: &str) -> Result<Option<HttpCacheEntry>> {
        self.connection()?
            .query_row(
                "SELECT etag, last_modified, body FROM github_http_cache WHERE url=?1",
                [url],
                |row| {
                    Ok(HttpCacheEntry {
                        etag: row.get(0)?,
                        last_modified: row.get(1)?,
                        body: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn store_http_cache(
        &self,
        url: &str,
        etag: Option<&str>,
        last_modified: Option<&str>,
        body: &str,
    ) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO github_http_cache(url, etag, last_modified, body, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch())
             ON CONFLICT(url) DO UPDATE SET
               etag=excluded.etag,
               last_modified=excluded.last_modified,
               body=excluded.body,
               updated_at=excluded.updated_at",
            params![url, etag, last_modified, body],
        )?;
        Ok(())
    }

    pub(crate) fn register_source(&self, source: &SourceRecord) -> Result<()> {
        Self::write_source(&self.connection()?, source)
    }

    pub(crate) fn write_source(connection: &Connection, source: &SourceRecord) -> Result<()> {
        let path = crate::path::unicode(&source.path, "source")?;
        connection.execute(
            "INSERT INTO sources(profile_id, path, sha256, size, storage_sha256, storage_size, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(profile_id) DO UPDATE SET path=excluded.path, sha256=excluded.sha256,
               size=excluded.size, storage_sha256=excluded.storage_sha256,
               storage_size=excluded.storage_size, updated_at=excluded.updated_at",
            params![
                source.profile_id,
                path,
                source.sha256,
                source.size,
                source.storage_sha256,
                source.storage_size,
                source.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn source(&self, profile_id: &str) -> Result<Option<SourceRecord>> {
        let connection = self.connection()?;
        connection.query_row(
            "SELECT profile_id, path, sha256, size, storage_sha256, storage_size, updated_at FROM sources WHERE profile_id=?1",
            [profile_id],
            |row| Ok(SourceRecord {
                profile_id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                sha256: row.get(2)?,
                size: row.get(3)?,
                storage_sha256: row.get(4)?,
                storage_size: row.get(5)?,
                updated_at: row.get(6)?,
            }),
        ).optional().map_err(Into::into)
    }

    pub fn sources(&self) -> Result<Vec<SourceRecord>> {
        let connection = self.connection()?;
        Self::sources_from(&connection)
    }

    pub(crate) fn sources_from(connection: &Connection) -> Result<Vec<SourceRecord>> {
        let mut statement = connection.prepare(
            "SELECT profile_id, path, sha256, size, storage_sha256, storage_size, updated_at FROM sources ORDER BY profile_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(SourceRecord {
                profile_id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                sha256: row.get(2)?,
                size: row.get(3)?,
                storage_sha256: row.get(4)?,
                storage_size: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn source_profile_ids(&self) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT profile_id FROM sources")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub(crate) fn remove_source(&self, profile_id: &str) -> Result<bool> {
        Ok(self
            .connection()?
            .execute("DELETE FROM sources WHERE profile_id=?1", [profile_id])?
            > 0)
    }

    pub fn ensure_settings(&self, port_id: &str, default_channel: ReleaseChannel) -> Result<()> {
        self.connection()?.execute(
            "INSERT OR IGNORE INTO port_settings(port_id, channel, update_policy)
             VALUES (?1, ?2, 'notify')",
            params![port_id, default_channel.to_string()],
        )?;
        Ok(())
    }

    pub fn set_channel(&self, port_id: &str, channel: ReleaseChannel) -> Result<()> {
        self.ensure_settings(port_id, channel)?;
        self.connection()?.execute(
            "UPDATE port_settings SET channel=?2 WHERE port_id=?1",
            params![port_id, channel.to_string()],
        )?;
        Ok(())
    }

    pub fn set_update_policy(
        &self,
        port_id: &str,
        policy: UpdatePolicy,
        default_channel: ReleaseChannel,
    ) -> Result<()> {
        self.ensure_settings(port_id, default_channel)?;
        self.connection()?.execute(
            "UPDATE port_settings SET update_policy=?2 WHERE port_id=?1",
            params![port_id, policy.to_string()],
        )?;
        Ok(())
    }

    pub(crate) fn write_install(
        connection: &Connection,
        install: &InstallRecord,
        staged: bool,
    ) -> Result<()> {
        let path = crate::path::unicode(&install.path, "install")?;
        let selected_executable =
            crate::path::unicode(&install.selected_executable, "selected executable")?;
        connection.execute(
            "INSERT INTO installs(
               id, port_id, version, path, channel, installed_at, verified, staged,
               artifact_name, artifact_sha256, artifact_size, manifest_sha256, selected_executable, runtime_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               port_id=excluded.port_id,
               version=excluded.version,
               path=excluded.path,
               channel=excluded.channel,
               installed_at=excluded.installed_at,
               verified=excluded.verified,
               staged=excluded.staged,
               artifact_name=excluded.artifact_name,
               artifact_sha256=excluded.artifact_sha256,
               artifact_size=excluded.artifact_size,
               manifest_sha256=excluded.manifest_sha256,
               selected_executable=excluded.selected_executable,
               runtime_json=excluded.runtime_json",
            params![
                install.id,
                install.port_id,
                install.version,
                path,
                install.channel.to_string(),
                install.installed_at,
                install.verified as i64,
                staged as i64,
                install.artifact.asset_name,
                install.artifact.sha256,
                install.artifact.size,
                install.manifest_sha256,
                selected_executable,
                install.runtime.as_ref().map(serde_json::to_string).transpose()?,
            ],
        )?;
        Ok(())
    }

    pub fn register_install(&self, install: &InstallRecord, activate: bool) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        Self::write_install(&transaction, install, !activate)?;
        transaction.execute(
            "INSERT OR IGNORE INTO port_settings(port_id, channel, update_policy) VALUES (?1, ?2, 'notify')",
            params![install.port_id, install.channel.to_string()],
        )?;
        if activate {
            transaction.execute(
                "UPDATE port_settings SET
                   previous_install_id = CASE WHEN active_install_id = ?2 THEN previous_install_id ELSE active_install_id END,
                   active_install_id = ?2,
                   channel = ?3
                 WHERE port_id = ?1",
                params![install.port_id, install.id, install.channel.to_string()],
            )?;
            transaction.execute(
                "UPDATE installs SET staged=0 WHERE port_id=?1",
                [install.port_id.as_str()],
            )?;
        } else {
            transaction.execute(
                "UPDATE installs SET staged = CASE WHEN id=?2 THEN 1 ELSE 0 END WHERE port_id=?1",
                params![install.port_id, install.id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn update_install_manifest(&self, install: &InstallRecord) -> Result<()> {
        let path = crate::path::unicode(&install.path, "install")?;
        let selected_executable =
            crate::path::unicode(&install.selected_executable, "selected executable")?;
        let changed = self.connection()?.execute(
            "UPDATE installs SET
               verified=?1, manifest_sha256=?2, selected_executable=?3, runtime_json=?4
             WHERE id=?5 AND port_id=?6 AND path=?7 AND artifact_sha256=?8",
            params![
                install.verified as i64,
                install.manifest_sha256,
                selected_executable,
                install
                    .runtime
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                install.id,
                install.port_id,
                path,
                install.artifact.sha256,
            ],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "install changed while its setup manifest was being committed",
            )
            .detail("install_id", &install.id));
        }
        Ok(())
    }

    pub fn status(&self, port_id: &str, default_channel: ReleaseChannel) -> Result<PortStatus> {
        self.statuses_with_metrics(&[(port_id.to_owned(), default_channel)])?
            .0
            .into_iter()
            .next()
            .ok_or_else(|| PortcoveError::state("status read model returned no row"))
    }

    pub(crate) fn statuses_with_metrics(
        &self,
        ports: &[(String, ReleaseChannel)],
    ) -> Result<(Vec<PortStatus>, StatusReadMetrics)> {
        let connection = self.connection()?;
        let mut metrics = StatusReadMetrics::default();

        metrics.record_query();
        let settings = {
            let mut statement = connection.prepare(
                "SELECT port_id, channel, update_policy, active_install_id, previous_install_id
                 FROM port_settings",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ),
                ))
            })?;
            rows.collect::<std::result::Result<HashMap<_, _>, _>>()?
        };

        metrics.record_query();
        let (installs, staged) = {
            let mut statement = connection.prepare(
                "SELECT id, port_id, version, path, channel, installed_at, verified, staged,
                        artifact_name, artifact_sha256, artifact_size, manifest_sha256,
                        selected_executable, runtime_json
                 FROM installs
                 ORDER BY installed_at DESC, rowid DESC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, u64>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, Option<String>>(13)?,
                ))
            })?;
            let mut installs = HashMap::new();
            let mut staged = HashMap::new();
            for row in rows {
                let (
                    id,
                    port_id,
                    version,
                    path,
                    channel,
                    installed_at,
                    verified,
                    is_staged,
                    artifact_name,
                    artifact_sha256,
                    artifact_size,
                    manifest_sha256,
                    selected_executable,
                    runtime_json,
                ) = row?;
                let install = InstallRecord {
                    id: id.clone(),
                    port_id: port_id.clone(),
                    version,
                    path: PathBuf::from(path),
                    channel: channel.parse()?,
                    installed_at,
                    verified: verified != 0,
                    staged: is_staged != 0,
                    artifact: ArtifactIdentity {
                        asset_name: artifact_name,
                        sha256: artifact_sha256,
                        size: artifact_size,
                    },
                    manifest_sha256,
                    selected_executable: PathBuf::from(selected_executable),
                    runtime: runtime_json
                        .as_deref()
                        .map(serde_json::from_str)
                        .transpose()?,
                };
                if install.staged {
                    staged.entry(port_id).or_insert_with(|| id.clone());
                }
                installs.insert(id, install);
            }
            (installs, staged)
        };

        metrics.record_query();
        let launch_history = {
            let mut statement = connection.prepare(
                "SELECT port_id, last_launched_at, successful_launches FROM launch_history",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
                ))
            })?;
            rows.collect::<std::result::Result<HashMap<_, _>, _>>()?
        };

        metrics.record_query();
        let update_snapshots = {
            let mut statement = connection
                .prepare("SELECT port_id, check_json, checked_at FROM update_snapshots")?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            let mut snapshots = HashMap::new();
            for row in rows {
                let (port_id, json, checked_at) = row?;
                snapshots.insert(
                    port_id,
                    UpdateSnapshot {
                        checked_at,
                        check: serde_json::from_str(&json)?,
                    },
                );
            }
            snapshots
        };

        let statuses = ports
            .iter()
            .map(|(port_id, default_channel)| {
                let stored = settings.get(port_id);
                let channel = stored
                    .map(|value| value.0.parse())
                    .transpose()?
                    .unwrap_or(*default_channel);
                let update_policy = stored
                    .map(|value| value.1.parse())
                    .transpose()?
                    .unwrap_or(UpdatePolicy::Notify);
                let active = stored
                    .and_then(|value| value.2.as_ref())
                    .and_then(|id| installs.get(id))
                    .cloned();
                let previous = stored
                    .and_then(|value| value.3.as_ref())
                    .and_then(|id| installs.get(id))
                    .cloned();
                let staged = staged.get(port_id).and_then(|id| installs.get(id)).cloned();
                let history = launch_history.get(port_id).copied();
                Ok(PortStatus {
                    port_id: port_id.clone(),
                    user_data_root: Some(self.user_dir(port_id)),
                    channel,
                    update_policy,
                    active,
                    previous,
                    staged,
                    last_launched_at: history.map(|value| value.0),
                    successful_launches: history.map_or(0, |value| value.1.max(0) as u64),
                    readiness: None,
                    last_update_check: update_snapshots.get(port_id).cloned(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((statuses, metrics))
    }

    fn install_by_id(connection: &Connection, id: Option<&str>) -> Result<Option<InstallRecord>> {
        let Some(id) = id else { return Ok(None) };
        let raw = connection
            .query_row(
                "SELECT id, port_id, version, path, channel, installed_at, verified, staged,
                    artifact_name, artifact_sha256, artifact_size, manifest_sha256,
                    selected_executable, runtime_json
             FROM installs WHERE id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, u64>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                },
            )
            .optional()?;
        raw.map(
            |(
                id,
                port_id,
                version,
                path,
                channel,
                installed_at,
                verified,
                staged,
                artifact_name,
                artifact_sha256,
                artifact_size,
                manifest_sha256,
                selected_executable,
                runtime_json,
            )| {
                Ok(InstallRecord {
                    id,
                    port_id,
                    version,
                    path: PathBuf::from(path),
                    channel: channel.parse()?,
                    installed_at,
                    verified: verified != 0,
                    staged: staged != 0,
                    artifact: ArtifactIdentity {
                        asset_name: artifact_name,
                        sha256: artifact_sha256,
                        size: artifact_size,
                    },
                    manifest_sha256,
                    selected_executable: PathBuf::from(selected_executable),
                    runtime: runtime_json
                        .as_deref()
                        .map(serde_json::from_str)
                        .transpose()?,
                })
            },
        )
        .transpose()
    }

    pub fn install_by_version(
        &self,
        port_id: &str,
        version: &str,
    ) -> Result<Option<InstallRecord>> {
        let connection = self.connection()?;
        let id: Option<String> = connection
            .query_row(
                "SELECT id FROM installs
                 WHERE port_id=?1 AND version=?2
                 ORDER BY installed_at DESC LIMIT 1",
                params![port_id, version],
                |row| row.get(0),
            )
            .optional()?;
        Self::install_by_id(&connection, id.as_deref())
    }

    pub fn install_by_artifact(
        &self,
        port_id: &str,
        artifact_sha256: &str,
        runtime: Option<&crate::RuntimeIdentity>,
    ) -> Result<Option<InstallRecord>> {
        let connection = self.connection()?;
        let id: Option<String> = connection
            .query_row(
                "SELECT id FROM installs
                 WHERE port_id=?1 AND lower(artifact_sha256)=lower(?2) AND runtime_json IS ?3
                 ORDER BY installed_at DESC LIMIT 1",
                params![
                    port_id,
                    artifact_sha256,
                    runtime.map(serde_json::to_string).transpose()?
                ],
                |row| row.get(0),
            )
            .optional()?;
        Self::install_by_id(&connection, id.as_deref())
    }

    pub(crate) fn all_installs(&self) -> Result<Vec<InstallRecord>> {
        let connection = self.connection()?;
        Self::installs_from(&connection)
    }

    pub(crate) fn installs_from(connection: &Connection) -> Result<Vec<InstallRecord>> {
        let ids = {
            let mut statement = connection.prepare("SELECT id FROM installs ORDER BY rowid")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        ids.iter()
            .map(|id| {
                Self::install_by_id(connection, Some(id))?.ok_or_else(|| {
                    PortcoveError::state(format!("install {id} disappeared while reading"))
                })
            })
            .collect()
    }

    pub(crate) fn port_install_paths(&self, port_id: &str) -> Result<Vec<PathBuf>> {
        Ok(self
            .all_installs()?
            .into_iter()
            .filter(|install| install.port_id == port_id)
            .map(|install| install.path)
            .collect())
    }

    pub fn rollback(&self, port_id: &str) -> Result<InstallRecord> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let (active_id, previous_id): (Option<String>, Option<String>) = transaction
            .query_row(
                "SELECT active_install_id, previous_install_id FROM port_settings WHERE port_id=?1",
                [port_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} is not installed")))?;
        let previous_id = previous_id.ok_or_else(|| {
            PortcoveError::not_found(format!("{port_id} has no rollback version"))
        })?;
        transaction.execute(
            "UPDATE port_settings SET active_install_id=?2, previous_install_id=?3 WHERE port_id=?1",
            params![port_id, previous_id, active_id],
        )?;
        transaction.commit()?;
        Self::install_by_id(&connection, Some(&previous_id))?
            .ok_or_else(|| PortcoveError::state("rollback target disappeared"))
    }

    pub fn activate_staged(&self, port_id: &str) -> Result<InstallRecord> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let staged_id: String = transaction
            .query_row(
                "SELECT id FROM installs WHERE port_id=?1 AND staged=1 ORDER BY installed_at DESC LIMIT 1",
                [port_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} has no staged version")))?;
        transaction.execute(
            "UPDATE port_settings SET
               previous_install_id = CASE WHEN active_install_id=?2 THEN previous_install_id ELSE active_install_id END,
               active_install_id=?2
             WHERE port_id=?1",
            params![port_id, staged_id],
        )?;
        transaction.execute("UPDATE installs SET staged=0 WHERE port_id=?1", [port_id])?;
        transaction.commit()?;
        Self::install_by_id(&connection, Some(&staged_id))?
            .ok_or_else(|| PortcoveError::state("staged version disappeared during activation"))
    }

    pub fn remove_port(&self, port_id: &str) -> Result<Vec<PathBuf>> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let paths = {
            let mut statement =
                transaction.prepare("SELECT path FROM installs WHERE port_id=?1")?;
            let rows = statement
                .query_map([port_id], |row| Ok(PathBuf::from(row.get::<_, String>(0)?)))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        transaction.execute("DELETE FROM port_settings WHERE port_id=?1", [port_id])?;
        transaction.execute("DELETE FROM installs WHERE port_id=?1", [port_id])?;
        transaction.commit()?;
        Ok(paths)
    }

    pub fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn relative_library_roots_store_absolute_managed_paths() {
        let temporary = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let relative = temporary.path().file_name().unwrap();
        let library = Library::open(relative).unwrap();

        assert_eq!(library.root(), temporary.path());
        assert!(library.versions_dir().is_absolute());
        assert!(library.user_dir("lighthouse").is_absolute());
        assert!(
            library
                .storage_summary()
                .unwrap()
                .library_root
                .is_absolute()
        );
        let reopened = Library::open(temporary.path()).unwrap();
        assert_eq!(reopened.root(), library.root());
    }

    #[cfg(unix)]
    #[test]
    fn opening_a_non_unicode_library_root_is_rejected_without_side_effects() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let temporary = tempdir().unwrap();
        let root = temporary.path().join(OsString::from_vec(vec![b'l', 0xff]));

        let error = Library::open(&root).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(!root.exists());
    }

    #[test]
    fn storage_summary_reports_the_library_volume_capacity() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();

        let summary = library.storage_summary().unwrap();

        assert_eq!(summary.library_root, library.root());
        assert!(summary.volume_total_bytes > 0);
        assert!(summary.volume_available_bytes <= summary.volume_total_bytes);
    }

    #[test]
    fn activation_and_rollback_are_transactional() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        for (id, version) in [("first", "1.0.0"), ("second", "2.0.0")] {
            library
                .register_install(
                    &InstallRecord {
                        id: id.into(),
                        port_id: "lighthouse".into(),
                        version: version.into(),
                        path: temporary.path().join(version),
                        channel: ReleaseChannel::Stable,
                        installed_at: Library::now(),
                        verified: true,
                        staged: false,
                        artifact: ArtifactIdentity::default(),
                        manifest_sha256: String::new(),
                        selected_executable: PathBuf::new(),
                        runtime: None,
                    },
                    true,
                )
                .unwrap();
        }
        let status = library
            .status("lighthouse", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.active.unwrap().version, "2.0.0");
        assert_eq!(library.rollback("lighthouse").unwrap().version, "1.0.0");
    }

    #[test]
    fn staged_activation_is_transactional_and_becomes_rollback_target() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        for (id, version, activate) in [("first", "1.0.0", true), ("second", "2.0.0", false)] {
            library
                .register_install(
                    &InstallRecord {
                        id: id.into(),
                        port_id: "lighthouse".into(),
                        version: version.into(),
                        path: temporary.path().join(version),
                        channel: ReleaseChannel::Stable,
                        installed_at: Library::now(),
                        verified: true,
                        staged: !activate,
                        artifact: ArtifactIdentity::default(),
                        manifest_sha256: String::new(),
                        selected_executable: PathBuf::new(),
                        runtime: None,
                    },
                    activate,
                )
                .unwrap();
        }

        let activated = library.activate_staged("lighthouse").unwrap();
        let status = library
            .status("lighthouse", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(activated.id, "second");
        assert_eq!(status.active.unwrap().id, "second");
        assert_eq!(status.previous.unwrap().id, "first");
        assert!(status.staged.is_none());
    }

    #[test]
    fn manifest_refresh_preserves_active_previous_and_staged_pointers() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let make_install = |id: &str, version: &str| InstallRecord {
            id: id.into(),
            port_id: "lighthouse".into(),
            version: version.into(),
            path: temporary.path().join(version),
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: false,
            artifact: ArtifactIdentity::default(),
            manifest_sha256: String::new(),
            selected_executable: PathBuf::new(),
            runtime: None,
        };
        let previous = make_install("previous", "1.0.0");
        let mut active = make_install("active", "2.0.0");
        let staged = make_install("staged", "3.0.0");
        library.register_install(&previous, true).unwrap();
        library.register_install(&active, true).unwrap();
        library.register_install(&staged, false).unwrap();
        active.manifest_sha256 = "a".repeat(64);
        active.selected_executable = PathBuf::from("Lighthouse.exe");

        library.update_install_manifest(&active).unwrap();

        let status = library
            .status("lighthouse", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.active.as_ref().unwrap().id, "active");
        assert_eq!(status.active.unwrap().manifest_sha256, "a".repeat(64));
        assert_eq!(status.previous.unwrap().id, "previous");
        assert_eq!(status.staged.unwrap().id, "staged");
    }

    #[test]
    fn bulk_status_read_query_count_is_constant_at_scale() {
        for record_count in [250, 500, 1_000] {
            let temporary = tempdir().unwrap();
            let library = Library::open(temporary.path()).unwrap();
            let mut connection = library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            for index in 0..record_count {
                let port_id = format!("port-{index:04}");
                transaction
                    .execute(
                        "INSERT INTO port_settings(port_id, channel, update_policy)
                         VALUES (?1, 'stable', 'notify')",
                        [&port_id],
                    )
                    .unwrap();
                transaction
                    .execute(
                        "INSERT INTO launch_history(port_id, last_launched_at, successful_launches)
                         VALUES (?1, ?2, ?3)",
                        params![port_id, index as i64, index as i64],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
            let ports = (0..record_count)
                .map(|index| (format!("port-{index:04}"), ReleaseChannel::Stable))
                .collect::<Vec<_>>();

            let (statuses, metrics) = library.statuses_with_metrics(&ports).unwrap();

            assert_eq!(statuses.len(), record_count);
            assert_eq!(metrics.sqlite_query_count, 4);
            assert_eq!(statuses.first().unwrap().port_id, "port-0000");
            assert_eq!(
                statuses.last().unwrap().successful_launches,
                (record_count - 1) as u64
            );
        }
    }

    #[test]
    fn connections_wait_for_short_lived_cross_process_contention() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let connection = library.connection().unwrap();
        let timeout_ms: u64 = connection
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();

        assert_eq!(timeout_ms, 10_000);
    }

    #[test]
    fn successful_launch_history_is_monotonic_and_visible_in_status() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();

        library.record_successful_launch("lighthouse").unwrap();
        library.record_successful_launch("lighthouse").unwrap();

        let status = library
            .status("lighthouse", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.successful_launches, 2);
        assert!(status.last_launched_at.is_some());
    }

    #[test]
    fn activity_history_persists_typed_successes_and_failures_newest_first() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let installed = library
            .begin_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Port,
                Some("lighthouse"),
            )
            .unwrap();
        library
            .finish_activity(&installed.id, ActivityStatus::Succeeded, None)
            .unwrap();
        let verified = library
            .begin_activity(
                ActivityOperation::VerifySource,
                ActivityTargetKind::Source,
                Some("star-fox-64"),
            )
            .unwrap();
        library
            .finish_activity(&verified.id, ActivityStatus::Failed, Some("source changed"))
            .unwrap();

        let activities = library.activities(50).unwrap();
        assert_eq!(activities.len(), 2);
        assert_eq!(activities[0].id, verified.id);
        assert_eq!(activities[0].status, ActivityStatus::Failed);
        assert_eq!(activities[0].message.as_deref(), Some("source changed"));
        assert!(activities[0].finished_at.is_some());
        assert_eq!(activities[1].operation, ActivityOperation::Install);
        assert_eq!(activities[1].target_kind, ActivityTargetKind::Port);
        assert_eq!(activities[1].target_id.as_deref(), Some("lighthouse"));
    }

    #[test]
    fn port_locks_isolate_ports_and_release_on_drop() {
        let temporary = tempdir().unwrap();
        let first = Library::open(temporary.path()).unwrap();
        let second = Library::open(temporary.path()).unwrap();
        let lighthouse = first.try_lock_port("lighthouse", "launch").unwrap();

        let conflict = second.try_lock_port("lighthouse", "update").unwrap_err();
        assert_eq!(conflict.code, crate::ErrorCode::Conflict);
        assert_eq!(conflict.details["port_id"], "lighthouse");
        assert_eq!(conflict.details["operation"], "update");
        let other = second.try_lock_port("starship", "update").unwrap();

        drop(other);
        drop(lighthouse);
        second.try_lock_port("lighthouse", "update").unwrap();
    }
}
