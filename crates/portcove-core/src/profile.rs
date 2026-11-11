//! Stable local setups ("profiles") and their immutable resolved revisions.
//!
//! A profile keeps *requested intent* (update policy, requested packages) apart
//! from *resolved revisions*: each revision binds the exact retained build, the
//! admitted original inputs, loader contract, package closure, typed ordering,
//! consequential settings and save group at one moment. Revisions are append-only.
//! The retained-build reference (keyed by the profile ID) supplies runtime byte
//! retention, so superseded revisions stay recoverable until deliberately retired.
//!
//! Profile identity is an opaque UUID: never a display name, source-profile ID,
//! installation path or active selection. Nothing here launches, downloads or
//! executes content; it records reviewed state that other Core paths consume.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    Library, PortcoveError, PortcoveService, Result, RetainedBuildAvailability,
    RetainedBuildIdentity, SourceRecord,
};

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;

const MAX_PROFILES_PER_PORT: usize = 64;
const MAX_PACKAGES: usize = 512;
const MAX_SETTINGS: usize = 64;
const MAX_LIMITS: usize = 64;
const MAX_TEXT: usize = 1024;
const MAX_PROFILE_BYTES: usize = 64 * 1024;
const MAX_REVISION_BYTES: usize = 256 * 1024;

/// How a profile follows newer eligible releases. Stored as intent; unattended
/// application is owned by the provider/standing-policy work, not this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileUpdatePolicy {
    KeepCurrent,
    ReviewUpdates,
    AutomaticEligible,
}

/// A provider's own coordinates. Provider IDs never double as native loader IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderPackageRef {
    pub provider: String,
    pub project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestedPackage {
    pub native_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderPackageRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_constraint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileIntent {
    pub update_policy: ProfileUpdatePolicy,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requested_packages: Vec<RequestedPackage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub port_id: String,
    pub display_name: String,
    pub is_default: bool,
    pub intent: ProfileIntent,
    pub current_revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One required original, bound by observed content and storage identity rather
/// than by path, so relocation and rescans cannot silently change which original
/// a profile means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OriginalBinding {
    /// The catalog source requirement this original satisfies.
    pub requirement_id: String,
    pub sha256: String,
    pub size: u64,
    pub storage_sha256: String,
    pub storage_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_identity_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LoaderContractRef {
    pub id: String,
    pub version: String,
}

/// Exact package bytes plus its separate identities. A local import carries no
/// provider coordinates but still has its own native ID and digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedPackage {
    pub native_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderPackageRef>,
    pub sha256: String,
    pub size: u64,
    pub enabled: bool,
    /// Native IDs this package requires, from native metadata (not provider claims).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

/// One precedence domain. A loader may need several; no universal number exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TypedOrdering {
    pub domain: String,
    pub native_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileRevision {
    pub profile_id: String,
    pub revision: u64,
    pub parent_revision: Option<u64>,
    pub build: RetainedBuildIdentity,
    pub originals: Vec<OriginalBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loader: Option<LoaderContractRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packages: Vec<ResolvedPackage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orderings: Vec<TypedOrdering>,
    /// Consequential native settings only; ordinary preferences stay mutable state.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub settings: BTreeMap<String, String>,
    /// Revisions sharing a group share progress; a copy gets its own group.
    pub save_group: String,
    /// Explicit uncaptured or external inputs this revision cannot reproduce.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limits: Vec<String>,
    pub created_at: i64,
    /// SHA-256 of this revision's canonical content (with this field empty).
    pub digest: String,
}

/// The inputs a caller supplies for a successor revision. Omitted collections
/// carry forward from the current revision.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileRevisionRequest {
    /// Revision the caller reviewed; a newer revision makes the request stale.
    pub expected_revision: u64,
    pub install_id: Option<String>,
    pub loader: Option<LoaderContractRef>,
    pub packages: Option<Vec<ResolvedPackage>>,
    pub orderings: Option<Vec<TypedOrdering>>,
    pub settings: Option<BTreeMap<String, String>>,
    pub limits: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OriginalAvailability {
    Verified,
    /// No registered original currently satisfies the requirement.
    Missing,
    /// A registered original differs from the bound identity.
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OriginalStatus {
    pub binding: OriginalBinding,
    pub availability: OriginalAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileView {
    pub profile: Profile,
    pub revision: ProfileRevision,
    pub build_availability: RetainedBuildAvailability,
    pub originals: Vec<OriginalStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileInventory {
    pub port_id: String,
    pub profiles: Vec<ProfileView>,
}

impl PortcoveService {
    /// Gives a port with an active installation its equivalent default profile.
    /// Idempotent: a player with one setup needs no further profile ceremony.
    pub fn ensure_default_profile(&self, port_id: &str) -> Result<Profile> {
        self.catalog().port(port_id)?;
        let _guard = self
            .library
            .try_lock_port(port_id, "ensure-default-profile")?;
        if let Some(existing) = default_profile(&self.library.connection()?, port_id)? {
            return Ok(existing);
        }
        let install_id =
            active_install_id(&self.library.connection()?, port_id)?.ok_or_else(|| {
                PortcoveError::not_found("the port has no active installation to migrate")
            })?;
        let build = self.verified_retained_build(port_id, &install_id)?;
        let originals = self.registered_originals(port_id)?;
        let profile = new_profile(port_id, "Default", true);
        let created =
            self.publish_new_profile(&profile, &install_id, build, originals, None, None)?;
        // Existing live player data belongs to the equivalent default profile.
        let connection = self.library.connection()?;
        set_selection(&connection, port_id, &created.id, 1)?;
        Ok(created)
    }

    /// Creates another profile from a source profile's current revision. The copy
    /// receives its own save group, so progress is isolated unless shared later
    /// through an explicit, scoped action.
    pub fn copy_profile(
        &self,
        port_id: &str,
        source_profile_id: &str,
        display_name: &str,
    ) -> Result<Profile> {
        let _guard = self.library.try_lock_port(port_id, "copy-profile")?;
        let connection = self.library.connection()?;
        let source = profile_from(&connection, port_id, source_profile_id)?;
        let revision = revision_from(&connection, &source.id, source.current_revision)?;
        if profiles_from(&connection, port_id)?.len() >= MAX_PROFILES_PER_PORT {
            return Err(PortcoveError::state(
                "this port has the maximum number of profiles",
            ));
        }
        let mut profile = new_profile(port_id, display_name, false);
        profile.intent = source.intent.clone();
        self.publish_new_profile(
            &profile,
            &revision.build.install_id,
            self.verified_retained_build(port_id, &revision.build.install_id)?,
            revision.originals.clone(),
            Some(&revision),
            None,
        )
    }

    /// Appends a successor revision. Stale callers, missing builds and unreviewed
    /// identity changes fail without altering the profile or its retained builds.
    pub fn create_profile_revision(
        &self,
        port_id: &str,
        profile_id: &str,
        request: &ProfileRevisionRequest,
    ) -> Result<ProfileRevision> {
        let _guard = self
            .library
            .try_lock_port(port_id, "create-profile-revision")?;
        self.create_profile_revision_locked(port_id, profile_id, request)
    }

    /// The caller holds the port lock.
    pub(crate) fn create_profile_revision_locked(
        &self,
        port_id: &str,
        profile_id: &str,
        request: &ProfileRevisionRequest,
    ) -> Result<ProfileRevision> {
        let connection = self.library.connection()?;
        let profile = profile_from(&connection, port_id, profile_id)?;
        if profile.current_revision != request.expected_revision {
            return Err(PortcoveError::conflict(
                "the profile changed after review; review its current revision again",
            ));
        }
        let current = revision_from(&connection, profile_id, profile.current_revision)?;
        let install_id = request
            .install_id
            .clone()
            .unwrap_or_else(|| current.build.install_id.clone());
        let build = self.verified_retained_build(port_id, &install_id)?;
        let previous = self.current_retained_reference(port_id, profile_id)?;
        let mut next = ProfileRevision {
            profile_id: profile_id.into(),
            revision: current
                .revision
                .checked_add(1)
                .ok_or_else(|| PortcoveError::state("profile revision exhausted"))?,
            parent_revision: Some(current.revision),
            build: build.clone(),
            originals: current.originals.clone(),
            loader: request.loader.clone().or_else(|| current.loader.clone()),
            packages: request.packages.clone().unwrap_or(current.packages.clone()),
            orderings: request
                .orderings
                .clone()
                .unwrap_or(current.orderings.clone()),
            settings: request.settings.clone().unwrap_or(current.settings.clone()),
            save_group: current.save_group.clone(),
            limits: request.limits.clone().unwrap_or(current.limits.clone()),
            created_at: Library::now(),
            digest: String::new(),
        };
        // A revision the game could not load unambiguously is never recorded.
        crate::profile_deploy::require_projectable(port_id, &next)?;
        seal(&mut next)?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let latest = profile_from(&transaction, port_id, profile_id)?;
        if latest.current_revision != request.expected_revision {
            return Err(PortcoveError::conflict(
                "the profile changed after review; review its current revision again",
            ));
        }
        self.publish_binding(
            &transaction,
            port_id,
            profile_id,
            &install_id,
            build,
            previous.as_ref(),
        )?;
        write_revision(&transaction, &next)?;
        let mut updated = latest;
        updated.current_revision = next.revision;
        updated.updated_at = next.created_at.max(updated.updated_at);
        write_profile(&transaction, &updated)?;
        transaction.commit()?;
        Ok(next)
    }

    pub fn set_profile_update_policy(
        &self,
        port_id: &str,
        profile_id: &str,
        policy: ProfileUpdatePolicy,
    ) -> Result<Profile> {
        let _guard = self.library.try_lock_port(port_id, "set-profile-policy")?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut profile = profile_from(&transaction, port_id, profile_id)?;
        profile.intent.update_policy = policy;
        profile.updated_at = Library::now().max(profile.updated_at);
        write_profile(&transaction, &profile)?;
        transaction.commit()?;
        Ok(profile)
    }

    pub fn profile_inventory(&self, port_id: &str) -> Result<ProfileInventory> {
        self.catalog().port(port_id)?;
        let connection = self.library.connection()?;
        let sources = self.library.sources()?;
        let mut views = Vec::new();
        for profile in profiles_from(&connection, port_id)? {
            let revision = revision_from(&connection, &profile.id, profile.current_revision)?;
            let build_availability = self
                .resolve_retained_build(port_id, &profile.id)
                .map(|resolved| resolved.availability)
                .unwrap_or(RetainedBuildAvailability::Unavailable);
            views.push(ProfileView {
                originals: original_statuses(&revision.originals, &sources),
                profile,
                revision,
                build_availability,
            });
        }
        Ok(ProfileInventory {
            port_id: port_id.into(),
            profiles: views,
        })
    }

    pub fn profile_revisions(
        &self,
        port_id: &str,
        profile_id: &str,
    ) -> Result<Vec<ProfileRevision>> {
        let connection = self.library.connection()?;
        let profile = profile_from(&connection, port_id, profile_id)?;
        (1..=profile.current_revision)
            .map(|revision| revision_from(&connection, profile_id, revision))
            .collect()
    }

    fn registered_originals(&self, port_id: &str) -> Result<Vec<OriginalBinding>> {
        let port = self.catalog().port(port_id)?;
        let sources = self.library.sources()?;
        Ok([
            port.source_profile.as_ref(),
            port.bios_source_profile.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(|requirement| {
            sources
                .iter()
                .find(|source| &source.profile_id == requirement)
                .map(|source| bind_original(requirement, source))
        })
        .collect())
    }

    fn publish_new_profile(
        &self,
        profile: &Profile,
        install_id: &str,
        build: RetainedBuildIdentity,
        originals: Vec<OriginalBinding>,
        base: Option<&ProfileRevision>,
        loader: Option<LoaderContractRef>,
    ) -> Result<Profile> {
        let mut revision = ProfileRevision {
            profile_id: profile.id.clone(),
            revision: 1,
            parent_revision: None,
            build: build.clone(),
            originals,
            loader: loader.or_else(|| base.and_then(|b| b.loader.clone())),
            packages: base.map(|b| b.packages.clone()).unwrap_or_default(),
            orderings: base.map(|b| b.orderings.clone()).unwrap_or_default(),
            settings: base.map(|b| b.settings.clone()).unwrap_or_default(),
            save_group: uuid::Uuid::new_v4().to_string(),
            limits: base.map(|b| b.limits.clone()).unwrap_or_default(),
            created_at: profile.created_at,
            digest: String::new(),
        };
        seal(&mut revision)?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if profile.is_default && default_profile(&transaction, &profile.port_id)?.is_some() {
            return Err(PortcoveError::conflict(
                "the default profile was created concurrently",
            ));
        }
        self.publish_binding(
            &transaction,
            &profile.port_id,
            &profile.id,
            install_id,
            build,
            None,
        )?;
        let mut stored = profile.clone();
        stored.current_revision = 1;
        write_profile(&transaction, &stored)?;
        write_revision(&transaction, &revision)?;
        transaction.commit()?;
        Ok(stored)
    }
}

pub(crate) fn new_profile(port_id: &str, display_name: &str, is_default: bool) -> Profile {
    let now = Library::now();
    Profile {
        id: uuid::Uuid::new_v4().to_string(),
        port_id: port_id.into(),
        display_name: display_name.into(),
        is_default,
        intent: ProfileIntent {
            update_policy: ProfileUpdatePolicy::ReviewUpdates,
            requested_packages: Vec::new(),
        },
        current_revision: 0,
        created_at: now,
        updated_at: now,
    }
}

fn bind_original(requirement_id: &str, source: &SourceRecord) -> OriginalBinding {
    OriginalBinding {
        requirement_id: requirement_id.into(),
        sha256: source.sha256.clone(),
        size: source.size,
        storage_sha256: source.storage_sha256.clone(),
        storage_size: source.storage_size,
        observed_identity_sha256: source
            .observed_identity
            .as_ref()
            .and_then(|identity| serde_json::to_vec(identity).ok())
            .map(|bytes| hex::encode(Sha256::digest(bytes))),
    }
}

/// Compares bindings with the registry by content identity. A path change alone
/// never changes the result; a missing original holds only its own operations.
fn original_statuses(
    bindings: &[OriginalBinding],
    sources: &[SourceRecord],
) -> Vec<OriginalStatus> {
    bindings
        .iter()
        .map(|binding| {
            let candidates = sources
                .iter()
                .filter(|source| source.profile_id == binding.requirement_id)
                .collect::<Vec<_>>();
            let availability = if candidates.is_empty() {
                OriginalAvailability::Missing
            } else if candidates
                .iter()
                .any(|source| bind_original(&binding.requirement_id, source) == *binding)
            {
                OriginalAvailability::Verified
            } else {
                OriginalAvailability::Changed
            };
            OriginalStatus {
                binding: binding.clone(),
                availability,
            }
        })
        .collect()
}

/// A native ID that may name a file inside a mods folder: plain ASCII, no
/// separators, drive or stream markers, controls or leading dot.
pub(crate) fn valid_native_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && !value.starts_with('.')
        && !value.ends_with(['.', ' '])
        && !value.chars().any(|c| c.is_control() || "/\\:".contains(c))
}

fn text(value: &str, name: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_TEXT || value.chars().any(char::is_control) {
        return Err(PortcoveError::usage(format!(
            "{name} must be 1–{MAX_TEXT} characters without control characters"
        )));
    }
    Ok(())
}

fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn validate_revision(revision: &ProfileRevision) -> Result<()> {
    if revision.revision == 0
        || revision
            .parent_revision
            .is_some_and(|p| p >= revision.revision)
        || revision.packages.len() > MAX_PACKAGES
        || revision.settings.len() > MAX_SETTINGS
        || revision.limits.len() > MAX_LIMITS
        || revision.originals.len() > MAX_PACKAGES
    {
        return Err(PortcoveError::verification(
            "profile revision has an invalid or oversized shape",
        ));
    }
    text(&revision.save_group, "save group")?;
    let mut native_ids = BTreeSet::new();
    for package in &revision.packages {
        text(&package.native_id, "package native ID")?;
        if !valid_native_id(&package.native_id) {
            return Err(PortcoveError::verification(
                "a package native ID must be a plain file name",
            )
            .detail("package", &package.native_id));
        }
        if !hash(&package.sha256) || !native_ids.insert(package.native_id.as_str()) {
            return Err(PortcoveError::verification(
                "profile packages need distinct native IDs and exact SHA-256 digests",
            ));
        }
        package
            .requires
            .iter()
            .try_for_each(|id| text(id, "required native ID"))?;
    }
    for package in &revision.packages {
        if let Some(missing) = package
            .requires
            .iter()
            .find(|id| !native_ids.contains(id.as_str()))
            .filter(|_| package.enabled)
        {
            return Err(PortcoveError::conflict(
                "an enabled package requires a native ID this revision does not contain",
            )
            .detail("package", &package.native_id)
            .detail("requires", missing));
        }
    }
    let mut domains = BTreeSet::new();
    for ordering in &revision.orderings {
        text(&ordering.domain, "ordering domain")?;
        let members = ordering.native_ids.iter().collect::<BTreeSet<_>>();
        if !domains.insert(ordering.domain.as_str())
            || members.len() != ordering.native_ids.len()
            || ordering
                .native_ids
                .iter()
                .any(|id| !native_ids.contains(id.as_str()))
        {
            return Err(PortcoveError::verification(
                "each ordering domain must be unique and list distinct packages of this revision",
            ));
        }
    }
    let mut requirements = BTreeSet::new();
    for original in &revision.originals {
        if !hash(&original.sha256)
            || !hash(&original.storage_sha256)
            || !requirements.insert(original.requirement_id.as_str())
        {
            return Err(PortcoveError::verification(
                "each original requirement needs one exact content and storage identity",
            ));
        }
    }
    for (key, value) in &revision.settings {
        text(key, "setting key")?;
        if value.len() > MAX_TEXT {
            return Err(PortcoveError::verification("setting value is oversized"));
        }
    }
    revision
        .limits
        .iter()
        .try_for_each(|limit| text(limit, "limit"))?;
    Ok(())
}

/// Digest over content with the portable (slash) executable spelling, so the same
/// revision hashes identically before and after a cross-platform library transfer.
fn content_digest(revision: &ProfileRevision) -> Result<String> {
    let mut copy = revision.clone();
    copy.digest.clear();
    copy.build.selected_executable = std::path::PathBuf::from(
        crate::portability::portable_relative(&copy.build.selected_executable)?,
    );
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&copy)?)))
}

pub(crate) fn seal(revision: &mut ProfileRevision) -> Result<()> {
    validate_revision(revision)?;
    revision.digest = content_digest(revision)?;
    Ok(())
}

fn digest_matches(revision: &ProfileRevision) -> Result<bool> {
    Ok(content_digest(revision)? == revision.digest)
}

/// One profile with every revision, as carried by library metadata schema 6.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryProfile {
    pub profile: Profile,
    pub revisions: Vec<ProfileRevision>,
    /// Set when this profile's revision currently owns the port's live player data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_revision: Option<u64>,
}

pub(crate) const MAX_EXPORTED_PROFILES: usize = 1024;

pub(crate) fn export(connection: &Connection) -> Result<Vec<LibraryProfile>> {
    let mut statement =
        connection.prepare("SELECT DISTINCT port_id FROM profiles ORDER BY port_id")?;
    let ports = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut exported = Vec::new();
    for port_id in ports {
        for profile in profiles_from(connection, &port_id)? {
            let mut revisions = (1..=profile.current_revision)
                .map(|revision| revision_from(connection, &profile.id, revision))
                .collect::<Result<Vec<_>>>()?;
            for revision in &mut revisions {
                revision.build.selected_executable = std::path::PathBuf::from(
                    crate::portability::portable_relative(&revision.build.selected_executable)?,
                );
            }
            let selected_revision = selection(connection, &port_id)?
                .filter(|(id, _)| *id == profile.id)
                .map(|(_, revision)| revision);
            exported.push(LibraryProfile {
                profile,
                revisions,
                selected_revision,
            });
        }
    }
    if exported.len() > MAX_EXPORTED_PROFILES {
        return Err(PortcoveError::state(
            "library has more profiles than metadata can carry",
        ));
    }
    exported.sort_by(|a, b| {
        (&a.profile.port_id, &a.profile.id).cmp(&(&b.profile.port_id, &b.profile.id))
    });
    Ok(exported)
}

/// Checks profiles against the exported retained references before any write: each
/// profile needs the reference keyed by its ID, a complete append-only history, and
/// revisions that only name builds that reference retains.
pub(crate) fn validate_export(
    profiles: &[LibraryProfile],
    references: &[crate::RetainedBuildReference],
) -> Result<()> {
    if profiles.len() > MAX_EXPORTED_PROFILES {
        return Err(PortcoveError::verification(
            "library metadata exceeds the profile limit",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut defaults = BTreeSet::new();
    let mut selected_ports = BTreeSet::new();
    for entry in profiles {
        let profile = &entry.profile;
        if !ids.insert(profile.id.as_str())
            || (profile.is_default && !defaults.insert(profile.port_id.as_str()))
            || uuid::Uuid::parse_str(&profile.id).is_err()
            || profile.current_revision == 0
            || entry.revisions.len() as u64 != profile.current_revision
        {
            return Err(PortcoveError::verification(
                "library metadata has a repeated, malformed or incomplete profile",
            ));
        }
        let reference = references
            .iter()
            .find(|r| r.setup_id == profile.id && r.build.port_id == profile.port_id)
            .ok_or_else(|| {
                PortcoveError::verification("a profile has no retained build reference")
                    .detail("profile_id", &profile.id)
            })?;
        let retained = reference
            .retained_builds()
            .map(|build| build.install_id.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(selected) = entry.selected_revision {
            if selected == 0 || selected > profile.current_revision {
                return Err(PortcoveError::verification(
                    "a selected profile revision does not exist",
                ));
            }
            if !selected_ports.insert(profile.port_id.as_str()) {
                return Err(PortcoveError::verification(
                    "a port has more than one selected profile",
                ));
            }
        }
        for (index, revision) in entry.revisions.iter().enumerate() {
            validate_revision(revision)?;
            if revision.build.port_id != profile.port_id
                || revision.profile_id != profile.id
                || revision.revision != index as u64 + 1
                || !digest_matches(revision)?
                || !retained.contains(revision.build.install_id.as_str())
            {
                return Err(PortcoveError::verification(
                    "a profile revision differs from its recorded identity or retained builds",
                )
                .detail("profile_id", &profile.id));
            }
        }
    }
    Ok(())
}

pub(crate) fn restore(connection: &Connection, profiles: &[LibraryProfile]) -> Result<()> {
    for entry in profiles {
        write_profile(connection, &entry.profile)?;
        for revision in &entry.revisions {
            write_revision(connection, revision)?;
        }
        if let Some(selected) = entry.selected_revision {
            set_selection(
                connection,
                &entry.profile.port_id,
                &entry.profile.id,
                selected,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn any_profiles(connection: &Connection) -> Result<bool> {
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='profiles')",
        [],
        |row| row.get(0),
    )?;
    if !present {
        return Ok(false);
    }
    Ok(
        connection.query_row("SELECT EXISTS(SELECT 1 FROM profiles)", [], |row| {
            row.get(0)
        })?,
    )
}

pub(crate) fn migrate_selection(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE profile_selection (
            port_id TEXT PRIMARY KEY NOT NULL,
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
            materialized_revision INTEGER NOT NULL CHECK(materialized_revision >= 1)
        );",
    )?;
    Ok(())
}

pub(crate) fn verify_selection_migration(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(profile_selection)")?;
    let present = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    for column in ["port_id", "profile_id", "materialized_revision"] {
        if !present.contains(column) {
            return Err(PortcoveError::state(format!(
                "library schema is missing profile_selection.{column}"
            )));
        }
    }
    Ok(())
}

/// The profile whose revision currently owns the port's live player data and mods.
pub(crate) fn selection(connection: &Connection, port_id: &str) -> Result<Option<(String, u64)>> {
    Ok(connection
        .query_row(
            "SELECT profile_id, materialized_revision FROM profile_selection WHERE port_id=?1",
            [port_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(crate) fn set_selection(
    connection: &Connection,
    port_id: &str,
    profile_id: &str,
    revision: u64,
) -> Result<()> {
    connection.execute(
        "INSERT INTO profile_selection(port_id, profile_id, materialized_revision) VALUES (?1, ?2, ?3)
         ON CONFLICT(port_id) DO UPDATE SET profile_id=excluded.profile_id,
         materialized_revision=excluded.materialized_revision",
        params![port_id, profile_id, revision],
    )?;
    Ok(())
}

pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE profiles (
            id TEXT PRIMARY KEY NOT NULL,
            port_id TEXT NOT NULL,
            is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
            current_revision INTEGER NOT NULL,
            profile_json TEXT NOT NULL CHECK(length(profile_json) <= 65536)
        );
        CREATE UNIQUE INDEX profiles_one_default ON profiles(port_id) WHERE is_default = 1;
        CREATE INDEX profiles_by_port ON profiles(port_id);
        CREATE TABLE profile_revisions (
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
            revision INTEGER NOT NULL,
            digest TEXT NOT NULL,
            revision_json TEXT NOT NULL CHECK(length(revision_json) <= 262144),
            PRIMARY KEY(profile_id, revision)
        );",
    )?;
    Ok(())
}

pub(crate) fn verify_migration(connection: &Connection) -> Result<()> {
    for (table, columns) in [
        (
            "profiles",
            &[
                "id",
                "port_id",
                "is_default",
                "current_revision",
                "profile_json",
            ][..],
        ),
        (
            "profile_revisions",
            &["profile_id", "revision", "digest", "revision_json"][..],
        ),
    ] {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let present = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        if let Some(missing) = columns.iter().find(|column| !present.contains(**column)) {
            return Err(PortcoveError::state(format!(
                "library schema is missing {table}.{missing}"
            )));
        }
    }
    Ok(())
}

fn active_install_id(connection: &Connection, port_id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT active_install_id FROM port_settings WHERE port_id=?1",
            [port_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn read_profile(json: &str, id: &str, port_id: &str, current: u64) -> Result<Profile> {
    if json.len() > MAX_PROFILE_BYTES {
        return Err(PortcoveError::state("stored profile exceeds its bound"));
    }
    let profile: Profile = serde_json::from_str(json)?;
    if profile.id != id || profile.port_id != port_id || profile.current_revision != current {
        return Err(PortcoveError::verification(
            "stored profile differs from its indexed identity",
        ));
    }
    Ok(profile)
}

fn profiles_from(connection: &Connection, port_id: &str) -> Result<Vec<Profile>> {
    let mut statement = connection.prepare(
        "SELECT id, port_id, current_revision, profile_json FROM profiles
         WHERE port_id=?1 ORDER BY is_default DESC, id LIMIT 65",
    )?;
    let rows = statement.query_map([port_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut profiles = Vec::new();
    for row in rows {
        let (id, port, current, json) = row?;
        profiles.push(read_profile(&json, &id, &port, current)?);
    }
    Ok(profiles)
}

fn default_profile(connection: &Connection, port_id: &str) -> Result<Option<Profile>> {
    Ok(profiles_from(connection, port_id)?
        .into_iter()
        .find(|profile| profile.is_default))
}

fn profile_from(connection: &Connection, port_id: &str, profile_id: &str) -> Result<Profile> {
    profiles_from(connection, port_id)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| PortcoveError::not_found("profile is not registered for this port"))
}

fn revision_from(
    connection: &Connection,
    profile_id: &str,
    revision: u64,
) -> Result<ProfileRevision> {
    let (digest, json): (String, String) = connection
        .query_row(
            "SELECT digest, revision_json FROM profile_revisions WHERE profile_id=?1 AND revision=?2",
            params![profile_id, revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| PortcoveError::not_found("profile revision is missing"))?;
    if json.len() > MAX_REVISION_BYTES {
        return Err(PortcoveError::state(
            "stored profile revision exceeds its bound",
        ));
    }
    let stored: ProfileRevision = serde_json::from_str(&json)?;
    if stored.profile_id != profile_id
        || stored.revision != revision
        || stored.digest != digest
        || !digest_matches(&stored)?
    {
        return Err(PortcoveError::verification(
            "stored profile revision differs from its recorded identity",
        ));
    }
    validate_revision(&stored)?;
    Ok(stored)
}

pub(crate) fn write_profile(connection: &Connection, profile: &Profile) -> Result<()> {
    text(&profile.display_name, "profile name")?;
    if profile.display_name.len() > 80 {
        return Err(PortcoveError::usage(
            "profile name must be at most 80 characters",
        ));
    }
    if profile.intent.requested_packages.len() > MAX_PACKAGES {
        return Err(PortcoveError::usage("too many requested packages"));
    }
    let json = serde_json::to_string(profile)?;
    if json.len() > MAX_PROFILE_BYTES {
        return Err(PortcoveError::usage("profile exceeds its size bound"));
    }
    connection.execute(
        "INSERT INTO profiles(id, port_id, is_default, current_revision, profile_json)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET
         current_revision=excluded.current_revision, profile_json=excluded.profile_json",
        params![
            profile.id,
            profile.port_id,
            profile.is_default,
            profile.current_revision,
            json
        ],
    )?;
    Ok(())
}

pub(crate) fn write_revision(connection: &Connection, revision: &ProfileRevision) -> Result<()> {
    validate_revision(revision)?;
    let json = serde_json::to_string(revision)?;
    if json.len() > MAX_REVISION_BYTES {
        return Err(PortcoveError::usage(
            "profile revision exceeds its size bound",
        ));
    }
    // Revisions are append-only: a conflict means a concurrent writer, never an edit.
    connection.execute(
        "INSERT INTO profile_revisions(profile_id, revision, digest, revision_json)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            revision.profile_id,
            revision.revision,
            revision.digest,
            json
        ],
    )?;
    Ok(())
}

pub(crate) fn revision_by_number(
    connection: &Connection,
    profile_id: &str,
    revision: u64,
) -> Result<ProfileRevision> {
    revision_from(connection, profile_id, revision)
}

pub(crate) fn current_revision(
    connection: &Connection,
    port_id: &str,
    profile_id: &str,
) -> Result<ProfileRevision> {
    let profile = profile_from(connection, port_id, profile_id)?;
    revision_from(connection, profile_id, profile.current_revision)
}
