//! Ephemeral browsing facts, assembled by Core from one accepted workspace.
//! These facts are neither action permission nor evidence of tested execution.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    Catalog, GameFileRouteKind, InstallationMethod, LibraryIdentity, Platform, PortStatus,
    ReleaseChannel, ReleaseSource, Result, SourceRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogBrowsingSnapshot {
    pub schema_version: u32,
    pub library: LibraryIdentity,
    pub host_platform: Platform,
    /// False when bounded retained metadata could not be observed. Membership
    /// still comes from complete Core status, not from metadata-read success.
    pub retained_metadata_complete: bool,
    /// Binds the complete catalog, status and source inputs; never a private path.
    pub workspace_binding_sha256: String,
    pub contexts: Vec<CatalogBrowsingContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogBrowsingContext {
    pub context_id: String,
    pub port_id: String,
    pub route: GameFileRouteKind,
    /// Legacy managed metadata can lack this fact. Do not substitute the host.
    pub platform: Option<Platform>,
    pub channel: Option<ReleaseChannel>,
    pub installation_method: Option<InstallationMethod>,
    /// Whole-port membership is distinct from membership of this exact context.
    pub port_member: bool,
    pub member_context: bool,
    pub installation_id: Option<String>,
    pub definition_sha256: Option<String>,
    pub instance_sha256: Option<String>,
    pub release_version: Option<String>,
    pub artifact_sha256: Option<String>,
}

/// Inputs collected by the owning snapshot reader, not accepted from clients.
#[derive(Default)]
pub(crate) struct RetainedBrowsingFacts {
    pub managed_catalog: Option<Catalog>,
    pub managed_platform: Option<Platform>,
    pub external_catalog: Option<Catalog>,
    pub managed_observed: bool,
    pub external_observed: bool,
}

const MAX_CONTEXTS: usize = 8192;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BINDING_BYTES: usize = 32 * 1024 * 1024;

/// No serialized buffer: count and hash directly into fixed-size state.
struct BindingWriter {
    remaining: usize,
    exceeded: bool,
    hash: Sha256,
}

impl std::io::Write for BindingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            self.exceeded = true;
            return Err(std::io::Error::other(
                "browsing serialization budget reached",
            ));
        }
        self.remaining -= bytes.len();
        self.hash.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialized_size(value: &impl Serialize, limit: usize) -> Result<Option<usize>> {
    let mut writer = BindingWriter {
        remaining: limit,
        exceeded: false,
        hash: Sha256::new(),
    };
    let result = serde_json::to_writer(&mut writer, value);
    if writer.exceeded {
        return Ok(None);
    }
    result?;
    Ok(Some(limit - writer.remaining))
}

fn fingerprint(value: &impl Serialize) -> Result<String> {
    let mut writer = BindingWriter {
        remaining: MAX_BINDING_BYTES,
        exceeded: false,
        hash: Sha256::new(),
    };
    serde_json::to_writer(&mut writer, value)?;
    Ok(hex::encode(writer.hash.finalize()))
}

/// Conservative upper bound before cloning any per-context strings. JSON can
/// expand a byte into six bytes; 1024 covers keys, enums and fixed-size digests.
/// The whole borrowed input is separately counted before catalog cloning/hash.
fn projection_fits(
    catalog: &Catalog,
    statuses: &[PortStatus],
    sources: &[SourceRecord],
    library: &LibraryIdentity,
) -> Result<bool> {
    // Leave room in the binding ceiling for retained definition digests and
    // envelope fields; those are bounded by MAX_CONTEXTS, not source strings.
    if serialized_size(
        &(catalog.document(), statuses, sources, library),
        MAX_BINDING_BYTES / 2,
    )?
    .is_none()
    {
        return Ok(false);
    }
    let Some(mut bytes) = serialized_size(library, MAX_RESPONSE_BYTES)? else {
        return Ok(false);
    };
    bytes += 1024;
    let mut count = 0usize;
    let mut charge = |strings: &[&str], copies: usize| -> bool {
        let length = strings
            .iter()
            .try_fold(0usize, |total, string| total.checked_add(string.len()));
        let allocation = length
            .and_then(|length| length.checked_mul(6))
            .and_then(|length| length.checked_add(1024))
            .and_then(|length| length.checked_mul(copies));
        let Some(next_bytes) = allocation.and_then(|allocation| bytes.checked_add(allocation))
        else {
            return false;
        };
        let Some(next_count) = count.checked_add(copies) else {
            return false;
        };
        bytes = next_bytes;
        count = next_count;
        bytes <= MAX_RESPONSE_BYTES && count <= MAX_CONTEXTS
    };
    for port in catalog.ports() {
        for platform in &port.platforms {
            let mut strings = vec![port.id.as_str()];
            if let Some(release) = port.release.direct.get(platform) {
                strings.extend([release.version.as_str(), release.sha256.as_str()]);
            }
            if !charge(&strings, port.channels.len()) {
                return Ok(false);
            }
        }
    }
    for status in statuses {
        if let Some(install) = &status.active
            && !charge(
                &[
                    &status.port_id,
                    &install.id,
                    &install.version,
                    &install.artifact.sha256,
                ],
                1,
            )
        {
            return Ok(false);
        }
        if let Some(runtime) = &status.external_runtime
            && !charge(
                &[
                    &status.port_id,
                    &runtime.id,
                    &runtime.version,
                    &runtime.archive_sha256,
                ],
                1,
            )
        {
            return Ok(false);
        }
    }
    Ok(true)
}

impl crate::PortcoveService {
    /// Collect metadata during the existing workspace refresh, before its final
    /// durable-revision fence. This budget is shared by managed and external
    /// instances; filtering has no route to this reader.
    pub(crate) fn browsing_contexts_for_workspace(
        &self,
        catalog: &Catalog,
        statuses: &[PortStatus],
        sources: &[SourceRecord],
    ) -> Result<Option<CatalogBrowsingSnapshot>> {
        const MAX_METADATA_BYTES: u64 = 32 * 1024 * 1024;
        let library = self.library().identity_record()?;
        if !projection_fits(catalog, statuses, sources, &library)? {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        let mut budget = MAX_METADATA_BYTES;
        let mut retained = HashMap::new();
        for status in statuses {
            if budget == 0 || started.elapsed() > std::time::Duration::from_millis(250) {
                break;
            }
            let mut facts = RetainedBrowsingFacts::default();
            if let Some(install) = &status.active
                && let Ok((catalog, platform)) = crate::output_root::validate_install_path(
                    self.library(),
                    &status.port_id,
                    &install.path,
                )
                .and_then(|_| {
                    crate::install::retained_query_context_with_budget(install, Some(&mut budget))
                })
            {
                facts.managed_catalog = catalog;
                facts.managed_platform = platform;
                facts.managed_observed = true;
            }
            if let Some(expected) = &status.external_runtime
                && budget > 0
                && started.elapsed() <= std::time::Duration::from_millis(250)
                && let Ok(Some((record, catalog))) = self
                    .library()
                    .external_runtime_with_port_bounded(&status.port_id, &mut budget)
                && fingerprint(&record)? == fingerprint(expected)?
            {
                facts.external_catalog = Some(catalog);
                facts.external_observed = true;
            }
            retained.insert(status.port_id.clone(), facts);
        }
        let snapshot = project_browsing_contexts(
            catalog,
            statuses,
            sources,
            &retained,
            library,
            Platform::current()?,
        )?;
        if serialized_size(&snapshot, MAX_RESPONSE_BYTES)?.is_none() {
            return Ok(None);
        }
        Ok(Some(snapshot))
    }
}

/// Pure projection. Metadata loading and workspace consistency stay at the caller.
/// Current setup contexts deliberately ignore action occupancy: an installed
/// member does not erase the declaration, nor turn that declaration into a member.
pub(crate) fn project_browsing_contexts(
    catalog: &Catalog,
    statuses: &[PortStatus],
    sources: &[SourceRecord],
    retained: &HashMap<String, RetainedBrowsingFacts>,
    library: LibraryIdentity,
    host_platform: Platform,
) -> Result<CatalogBrowsingSnapshot> {
    if !projection_fits(catalog, statuses, sources, &library)? {
        return Err(crate::PortcoveError::unsupported(
            "browsing projection budget reached",
        ));
    }
    let retained_metadata_complete = statuses.iter().all(|status| {
        let facts = retained.get(&status.port_id);
        (status.active.is_none() || facts.is_some_and(|facts| facts.managed_observed))
            && (status.external_runtime.is_none()
                || facts.is_some_and(|facts| facts.external_observed))
    });
    let definition = |catalog: Option<&Catalog>| {
        catalog
            .map(|catalog| fingerprint(&catalog.authoritative_document()))
            .transpose()
    };
    let retained_binding: Vec<_> = catalog
        .ports()
        .iter()
        .map(|port| {
            let facts = retained.get(&port.id);
            Ok((
                &port.id,
                facts.and_then(|facts| facts.managed_platform),
                definition(facts.and_then(|facts| facts.managed_catalog.as_ref()))?,
                definition(facts.and_then(|facts| facts.external_catalog.as_ref()))?,
            ))
        })
        .collect::<Result<_>>()?;
    // Keep digests rather than retaining one cloned catalog document per member.
    let definitions: HashMap<_, _> = retained_binding
        .iter()
        .map(|(id, _, managed, external)| (id.to_string(), (managed.clone(), external.clone())))
        .collect();
    let binding = fingerprint(&(
        &library,
        catalog.authoritative_document(),
        statuses,
        sources,
        host_platform,
        retained_metadata_complete,
        retained_binding,
    ))?;
    let current_definition = fingerprint(&catalog.authoritative_document())?;
    let indexed: HashMap<_, _> = statuses
        .iter()
        .map(|status| (&status.port_id, status))
        .collect();
    if indexed.len() != statuses.len()
        || indexed.len() != catalog.ports().len()
        || catalog
            .ports()
            .iter()
            .any(|port| !indexed.contains_key(&port.id))
        || statuses.iter().any(|status| {
            status
                .active
                .as_ref()
                .is_some_and(|record| record.port_id != status.port_id)
                || status
                    .external_runtime
                    .as_ref()
                    .is_some_and(|record| record.port_id != status.port_id)
        })
    {
        return Err(crate::PortcoveError::state(
            "inconsistent browsing membership identities",
        ));
    }
    let statuses = indexed;
    let mut contexts = Vec::new();
    for port in catalog.ports() {
        let status = statuses.get(&port.id).copied();
        let active = status.and_then(|status| status.active.as_ref());
        let external = status.and_then(|status| status.external_runtime.as_ref());
        let port_member = active.is_some() || external.is_some();
        let facts = retained.get(&port.id);
        let method = |catalog: Option<&Catalog>| {
            catalog
                .and_then(|catalog| catalog.port(&port.id).ok())
                .and_then(|port| port.presentation.as_ref())
                .map(|presentation| presentation.installation_method)
        };
        let (managed_definition, external_definition) = definitions
            .get(port.id.as_str())
            .cloned()
            .unwrap_or_default();
        for &platform in &port.platforms {
            let route = if port.release.provider == ReleaseSource::UserPrepared {
                // A declared target alone does not establish an external package.
                if !port.release.user_prepared.contains_key(&platform) {
                    continue;
                }
                GameFileRouteKind::ExternalRegistration
            } else {
                GameFileRouteKind::ManagedInstall
            };
            for &channel in &port.channels {
                let declared_release = port
                    .release
                    .direct
                    .get(&platform)
                    .map(|release| (release.version.clone(), release.sha256.clone()));
                let (release_version, artifact_sha256) = declared_release
                    .map_or((None, None), |(version, hash)| (Some(version), Some(hash)));
                contexts.push(CatalogBrowsingContext {
                    context_id: String::new(),
                    port_id: port.id.clone(),
                    route,
                    platform: Some(platform),
                    channel: Some(channel),
                    installation_method: method(Some(catalog)),
                    port_member,
                    member_context: false,
                    installation_id: None,
                    definition_sha256: Some(current_definition.clone()),
                    instance_sha256: None,
                    release_version,
                    artifact_sha256,
                });
            }
        }
        if let Some(install) = active {
            let catalog = facts.and_then(|facts| facts.managed_catalog.as_ref());
            contexts.push(CatalogBrowsingContext {
                context_id: String::new(),
                port_id: port.id.clone(),
                route: GameFileRouteKind::ManagedLaunch,
                platform: facts.and_then(|facts| facts.managed_platform),
                channel: Some(install.channel),
                installation_method: method(catalog),
                port_member,
                member_context: true,
                installation_id: Some(install.id.clone()),
                definition_sha256: managed_definition,
                instance_sha256: Some(fingerprint(install)?),
                release_version: Some(install.version.clone()),
                artifact_sha256: Some(install.artifact.sha256.clone()),
            });
        }
        if let Some(runtime) = external {
            let catalog = facts
                .and_then(|facts| facts.external_catalog.as_ref())
                .filter(|catalog| {
                    catalog.port(&port.id).is_ok_and(|port| {
                        port.release.provider == ReleaseSource::UserPrepared
                            && port.channels == [ReleaseChannel::Stable]
                            && port
                                .release
                                .user_prepared
                                .get(&runtime.platform)
                                .is_some_and(|package| {
                                    package.version == runtime.version
                                        && package
                                            .archive_sha256
                                            .eq_ignore_ascii_case(&runtime.archive_sha256)
                                        && package
                                            .immutable_tree_sha256
                                            .eq_ignore_ascii_case(&runtime.immutable_tree_sha256)
                                })
                    })
                });
            contexts.push(CatalogBrowsingContext {
                context_id: String::new(),
                port_id: port.id.clone(),
                route: GameFileRouteKind::ExternalLaunch,
                platform: Some(runtime.platform),
                // The accepted UserPrepared schema is Stable-only. A mutable
                // selected-channel preference is not the registered build's channel.
                channel: catalog.map(|_| ReleaseChannel::Stable),
                installation_method: method(catalog),
                port_member,
                member_context: true,
                installation_id: Some(runtime.id.clone()),
                definition_sha256: catalog.and(external_definition),
                instance_sha256: Some(fingerprint(runtime)?),
                release_version: Some(runtime.version.clone()),
                artifact_sha256: Some(runtime.archive_sha256.clone()),
            });
        }
    }
    for context in &mut contexts {
        context.context_id = fingerprint(&(&binding, &*context))?;
    }
    Ok(CatalogBrowsingSnapshot {
        schema_version: 1,
        library,
        host_platform,
        retained_metadata_complete,
        workspace_binding_sha256: binding,
        contexts,
    })
}

#[cfg(test)]
mod tests {
    fn fixture_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join("portcove-browsing-fixture")
            .join(name)
    }

    use super::*;
    use crate::{ArtifactIdentity, ExternalRuntimeRecord, InstallRecord, UpdatePolicy};

    #[test]
    fn streaming_binding_preserves_existing_digest_and_stops_at_limit() {
        let value = ("escaped\n\"é", vec![1, 2, 3]);
        assert_eq!(
            fingerprint(&value).unwrap(),
            crate::source_batch::fingerprint(&value).unwrap()
        );
        let length = serde_json::to_vec(&value).unwrap().len();
        assert_eq!(serialized_size(&value, length).unwrap(), Some(length));
        assert_eq!(serialized_size(&value, length - 1).unwrap(), None);
    }

    #[test]
    fn oversized_installed_string_is_rejected_before_context_construction() {
        let catalog = Catalog::embedded().unwrap();
        let id = &catalog.ports()[0].id;
        let mut installed = managed(id);
        installed.version = "\n".repeat(MAX_RESPONSE_BYTES / 6 + 1);
        let mut member = status(id);
        member.active = Some(installed);
        let library = LibraryIdentity {
            id: "selected".into(),
            root: fixture_path("selected"),
        };
        assert!(!projection_fits(&catalog, &[member.clone()], &[], &library).unwrap());
        assert!(
            project_browsing_contexts(
                &catalog,
                &[member],
                &[],
                &HashMap::new(),
                library,
                Platform::LinuxX86_64
            )
            .unwrap_err()
            .to_string()
            .contains("projection budget")
        );
    }

    fn status(id: &str) -> PortStatus {
        PortStatus {
            acquisition: None,
            port_id: id.into(),
            user_data_root: None,
            channel: ReleaseChannel::Stable,
            update_policy: UpdatePolicy::Notify,
            active: None,
            external_runtime: None,
            previous: None,
            staged: None,
            last_launched_at: None,
            successful_launches: 0,
            readiness: None,
            last_update_check: None,
            definition_operations: Vec::new(),
            port_actions: Vec::new(),
        }
    }

    fn managed(id: &str) -> InstallRecord {
        InstallRecord {
            id: "managed-windows-instance".into(),
            port_id: id.into(),
            version: "retained-managed-version".into(),
            path: fixture_path("private-managed-path"),
            channel: ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact: ArtifactIdentity::default(),
            runtime: None,
            manifest_sha256: "a".repeat(64),
            selected_executable: "game.exe".into(),
        }
    }

    fn project(
        catalog: &Catalog,
        statuses: &[PortStatus],
        retained: &HashMap<String, RetainedBrowsingFacts>,
    ) -> CatalogBrowsingSnapshot {
        let supplied: HashMap<_, _> = statuses
            .iter()
            .map(|status| (&status.port_id, status))
            .collect();
        let statuses: Vec<_> = catalog
            .ports()
            .iter()
            .map(|port| {
                supplied
                    .get(&port.id)
                    .map_or_else(|| status(&port.id), |status| (*status).clone())
            })
            .collect();
        project_browsing_contexts(
            catalog,
            &statuses,
            &[],
            retained,
            LibraryIdentity {
                id: "opaque-library".into(),
                root: fixture_path("selected-library"),
            },
            Platform::LinuxX86_64,
        )
        .unwrap()
    }

    #[test]
    fn retained_membership_never_acquires_the_host_platform() {
        let catalog = Catalog::embedded().unwrap();
        let id = &catalog.ports()[0].id;
        let mut status = status(id);
        status.active = Some(managed(id));
        let snapshot = project(&catalog, &[status], &HashMap::new());
        let member = snapshot
            .contexts
            .iter()
            .find(|context| context.port_id == *id && context.member_context)
            .unwrap();
        assert_eq!(snapshot.host_platform, Platform::LinuxX86_64);
        assert_eq!(member.platform, None);
        assert_eq!(member.installation_method, None);
        assert_eq!(member.definition_sha256, None);
        assert!(member.port_member);
        assert_eq!(
            member.release_version.as_deref(),
            Some("retained-managed-version")
        );
    }

    #[test]
    fn distinct_installed_contexts_retain_platform_channel_and_instance() {
        let catalog = Catalog::embedded().unwrap();
        let id = &catalog.ports()[0].id;
        let mut status = status(id);
        status.active = Some(managed(id));
        status.channel = ReleaseChannel::Beta;
        status.external_runtime = Some(ExternalRuntimeRecord {
            user_selected: None,
            id: "external-linux-instance".into(),
            port_id: id.clone(),
            path: fixture_path("private-external-path"),
            executable: "game".into(),
            version: "external-version".into(),
            platform: Platform::LinuxX86_64,
            archive_sha256: "b".repeat(64),
            immutable_tree_sha256: "c".repeat(64),
            registered_at: 1,
            retained_definition: None,
            shared_preferences: None,
        });
        let retained = HashMap::from([(
            id.clone(),
            RetainedBrowsingFacts {
                managed_catalog: Some(catalog.clone()),
                managed_platform: Some(Platform::WindowsX86_64),
                external_catalog: Some(catalog.clone()),
                managed_observed: true,
                external_observed: true,
            },
        )]);
        let snapshot = project(&catalog, &[status], &retained);
        let members: Vec<_> = snapshot
            .contexts
            .iter()
            .filter(|context| context.port_id == *id && context.member_context)
            .collect();
        assert_eq!(members.len(), 2);
        assert!(
            members
                .iter()
                .any(|context| context.platform == Some(Platform::WindowsX86_64)
                    && context.channel == Some(ReleaseChannel::Stable)
                    && context.route == GameFileRouteKind::ManagedLaunch)
        );
        assert!(
            members
                .iter()
                .any(|context| context.platform == Some(Platform::LinuxX86_64)
                    && context.channel.is_none()
                    && context.route == GameFileRouteKind::ExternalLaunch)
        );
        assert!(
            !members
                .iter()
                .any(|context| context.platform == Some(Platform::LinuxX86_64)
                    && context.route == GameFileRouteKind::ManagedLaunch)
        );
        assert_ne!(members[0].context_id, members[1].context_id);
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("private-managed-path"));
        assert!(!encoded.contains("private-external-path"));
    }

    #[test]
    fn occupied_setup_is_not_erased_or_mistaken_for_absent_membership() {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog
            .ports()
            .iter()
            .find(|port| port.release.provider != ReleaseSource::UserPrepared)
            .unwrap();
        let mut status = status(&port.id);
        status.active = Some(managed(&port.id));
        let snapshot = project(&catalog, &[status], &HashMap::new());
        let setup: Vec<_> = snapshot
            .contexts
            .iter()
            .filter(|context| {
                context.port_id == port.id && context.route == GameFileRouteKind::ManagedInstall
            })
            .collect();
        assert!(!setup.is_empty());
        assert!(
            setup
                .iter()
                .all(|context| context.port_member && !context.member_context)
        );
        assert!(
            setup
                .iter()
                .all(|context| context.installation_id.is_none())
        );
    }

    #[test]
    fn changed_workspace_cannot_reuse_a_matching_context_identity() {
        let catalog = Catalog::embedded().unwrap();
        let id = &catalog.ports()[0].id;
        let mut status = status(id);
        let first = project(&catalog, &[status.clone()], &HashMap::new());
        status.active = Some(managed(id));
        let second = project(&catalog, &[status], &HashMap::new());
        assert_ne!(
            first.workspace_binding_sha256,
            second.workspace_binding_sha256
        );
        let first_ids: std::collections::HashSet<_> = first
            .contexts
            .iter()
            .map(|context| &context.context_id)
            .collect();
        assert!(
            second
                .contexts
                .iter()
                .all(|context| !first_ids.contains(&context.context_id))
        );
    }

    #[test]
    fn external_build_channel_comes_from_the_retained_package_not_preference() {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog
            .ports()
            .iter()
            .find(|port| port.release.provider == ReleaseSource::UserPrepared)
            .unwrap();
        let (&platform, package) = port.release.user_prepared.iter().next().unwrap();
        let mut status = status(&port.id);
        status.channel = ReleaseChannel::Beta;
        status.external_runtime = Some(ExternalRuntimeRecord {
            user_selected: None,
            id: "accepted-external-instance".into(),
            port_id: port.id.clone(),
            path: fixture_path("private-accepted-runtime"),
            executable: "game".into(),
            version: package.version.clone(),
            platform,
            archive_sha256: package.archive_sha256.clone(),
            immutable_tree_sha256: package.immutable_tree_sha256.clone(),
            registered_at: 1,
            retained_definition: None,
            shared_preferences: None,
        });
        let facts = HashMap::from([(
            port.id.clone(),
            RetainedBrowsingFacts {
                external_catalog: Some(catalog.clone()),
                external_observed: true,
                ..RetainedBrowsingFacts::default()
            },
        )]);
        let snapshot = project(&catalog, &[status], &facts);
        let member = snapshot
            .contexts
            .iter()
            .find(|context| context.port_id == port.id && context.member_context)
            .unwrap();
        assert_eq!(member.channel, Some(ReleaseChannel::Stable));
        assert_eq!(
            member.installation_method,
            Some(InstallationMethod::UserPreparedRuntime)
        );
        assert!(member.definition_sha256.is_some());
    }

    #[test]
    fn incomplete_membership_coverage_is_not_an_empty_library() {
        let catalog = Catalog::embedded().unwrap();
        assert!(
            project_browsing_contexts(
                &catalog,
                &[],
                &[],
                &HashMap::new(),
                LibraryIdentity {
                    id: "opaque-library".into(),
                    root: fixture_path("selected-library")
                },
                Platform::LinuxX86_64,
            )
            .is_err()
        );
    }
}
