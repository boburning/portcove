use std::{
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
    ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind, InstallRecord,
    PortStatus, PortcoveError, ReleaseChannel, Result, SourceRecord, StorageSummary, UpdateCheck,
    UpdatePolicy, UpdateSnapshot, database,
};

#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
}

#[derive(Debug)]
pub struct PortOperationGuard {
    file: File,
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
        let library = Self { root: root.into() };
        library.create_layout()?;
        library.migrate()?;
        Ok(library)
    }

    pub fn open_default() -> Result<Self> {
        let project = ProjectDirs::from("io.github", "Portcove", "Portcove").ok_or_else(|| {
            PortcoveError::state("could not determine the default Portcove data directory")
        })?;
        Self::open(project.data_local_dir().join("library"))
    }

    pub fn root(&self) -> &Path {
        &self.root
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
        let key = hex::encode(Sha256::digest(port_id.as_bytes()));
        let path = self.locks_dir().join(format!("{key}.lock"));
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        if let Err(error) = file.try_lock_exclusive() {
            if error.kind() == fs2::lock_contended_error().kind() {
                return Err(PortcoveError::conflict(format!(
                    "{port_id} is busy in another Portcove process"
                ))
                .detail("port_id", port_id)
                .detail("operation", operation));
            }
            return Err(error.into());
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

    fn connection(&self) -> Result<Connection> {
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
        let activity = ActivityRecord {
            id: uuid::Uuid::new_v4().to_string(),
            operation,
            target_kind,
            target_id: target_id.map(str::to_owned),
            status: ActivityStatus::Running,
            message: None,
            started_at: Self::now(),
            finished_at: None,
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
        if status == ActivityStatus::Running {
            return Err(PortcoveError::usage(
                "an activity cannot be finished with running status",
            ));
        }
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE activity_history
             SET status=?2, message=?3, finished_at=?4
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

    pub fn activities(&self, limit: usize) -> Result<Vec<ActivityRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, operation, target_kind, target_id, status, message, started_at, finished_at
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
            ))
        })?;
        rows.map(|row| {
            let (id, operation, target_kind, target_id, status, message, started_at, finished_at) =
                row?;
            Ok(ActivityRecord {
                id,
                operation: operation.parse()?,
                target_kind: target_kind.parse()?,
                target_id,
                status: status.parse()?,
                message,
                started_at,
                finished_at,
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

    pub fn register_source(&self, source: &SourceRecord) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO sources(profile_id, path, sha256, size, storage_sha256, storage_size, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(profile_id) DO UPDATE SET path=excluded.path, sha256=excluded.sha256,
               size=excluded.size, storage_sha256=excluded.storage_sha256,
               storage_size=excluded.storage_size, updated_at=excluded.updated_at",
            params![
                source.profile_id,
                source.path.to_string_lossy(),
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

    pub fn remove_source(&self, profile_id: &str) -> Result<bool> {
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

    pub fn set_update_policy(&self, port_id: &str, policy: UpdatePolicy) -> Result<()> {
        self.ensure_settings(port_id, ReleaseChannel::Stable)?;
        self.connection()?.execute(
            "UPDATE port_settings SET update_policy=?2 WHERE port_id=?1",
            params![port_id, policy.to_string()],
        )?;
        Ok(())
    }

    pub fn register_install(&self, install: &InstallRecord, activate: bool) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO installs(id, port_id, version, path, channel, installed_at, verified, staged)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               port_id=excluded.port_id,
               version=excluded.version,
               path=excluded.path,
               channel=excluded.channel,
               installed_at=excluded.installed_at,
               verified=excluded.verified,
               staged=excluded.staged",
            params![
                install.id, install.port_id, install.version, install.path.to_string_lossy(),
                install.channel.to_string(), install.installed_at, install.verified as i64,
                (!activate) as i64,
            ],
        )?;
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

    pub fn status(&self, port_id: &str, default_channel: ReleaseChannel) -> Result<PortStatus> {
        self.ensure_settings(port_id, default_channel)?;
        let connection = self.connection()?;
        let (channel_value, policy_value, active_id, previous_id): (
            String,
            String,
            Option<String>,
            Option<String>,
        ) = connection.query_row(
            "SELECT channel, update_policy, active_install_id, previous_install_id
             FROM port_settings WHERE port_id=?1",
            [port_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let staged_id: Option<String> = connection.query_row(
            "SELECT id FROM installs WHERE port_id=?1 AND staged=1 ORDER BY installed_at DESC LIMIT 1",
            [port_id], |row| row.get(0),
        ).optional()?;
        let launch_history: Option<(i64, i64)> = connection
            .query_row(
                "SELECT last_launched_at, successful_launches FROM launch_history WHERE port_id=?1",
                [port_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(PortStatus {
            port_id: port_id.to_owned(),
            user_data_root: Some(self.user_dir(port_id)),
            channel: channel_value.parse()?,
            update_policy: policy_value.parse()?,
            active: Self::install_by_id(&connection, active_id.as_deref())?,
            previous: Self::install_by_id(&connection, previous_id.as_deref())?,
            staged: Self::install_by_id(&connection, staged_id.as_deref())?,
            last_launched_at: launch_history.map(|value| value.0),
            successful_launches: launch_history.map_or(0, |value| value.1.max(0) as u64),
            readiness: None,
            last_update_check: None,
        })
    }

    fn install_by_id(connection: &Connection, id: Option<&str>) -> Result<Option<InstallRecord>> {
        let Some(id) = id else { return Ok(None) };
        let raw = connection.query_row(
            "SELECT id, port_id, version, path, channel, installed_at, verified, staged FROM installs WHERE id=?1",
            [id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?, row.get::<_, i64>(7)?,
            )),
        ).optional()?;
        raw.map(
            |(id, port_id, version, path, channel, installed_at, verified, staged)| {
                Ok(InstallRecord {
                    id,
                    port_id,
                    version,
                    path: PathBuf::from(path),
                    channel: channel.parse()?,
                    installed_at,
                    verified: verified != 0,
                    staged: staged != 0,
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

    pub(crate) fn all_installs(&self) -> Result<Vec<InstallRecord>> {
        let connection = self.connection()?;
        let ids = {
            let mut statement = connection.prepare("SELECT id FROM installs ORDER BY rowid")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        ids.iter()
            .map(|id| {
                Self::install_by_id(&connection, Some(id))?.ok_or_else(|| {
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
