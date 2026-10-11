//! Ephemeral browsing facts, assembled by Core from one accepted workspace.
//! These facts are neither action permission nor evidence of tested execution.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, GameFileRouteKind, InstallationMethod, LibraryIdentity, Platform, PortStatus,
    ReleaseChannel, ReleaseSource, Result, SourceRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogBrowsingSnapshot {
    pub schema_version: u32,
    pub library: LibraryIdentity,
    pub host_platform: Platform,
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
    pub channel: ReleaseChannel,
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
    use crate::source_batch::fingerprint;
    let retained_binding: Vec<_> = catalog
        .ports()
        .iter()
        .map(|port| {
            let facts = retained.get(&port.id);
            (
                &port.id,
                facts.and_then(|facts| facts.managed_platform),
                facts
                    .and_then(|facts| facts.managed_catalog.as_ref())
                    .map(Catalog::authoritative_document),
                facts
                    .and_then(|facts| facts.external_catalog.as_ref())
                    .map(Catalog::authoritative_document),
            )
        })
        .collect();
    let binding = fingerprint(&(
        &library,
        catalog.authoritative_document(),
        statuses,
        sources,
        host_platform,
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
        let definition = |catalog: Option<&Catalog>| {
            catalog
                .map(|catalog| fingerprint(&catalog.authoritative_document()))
                .transpose()
        };
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
                    channel,
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
                channel: install.channel,
                installation_method: method(catalog),
                port_member,
                member_context: true,
                installation_id: Some(install.id.clone()),
                definition_sha256: definition(catalog)?,
                instance_sha256: Some(fingerprint(install)?),
                release_version: Some(install.version.clone()),
                artifact_sha256: Some(install.artifact.sha256.clone()),
            });
        }
        if let (Some(status), Some(runtime)) = (status, external) {
            let catalog = facts.and_then(|facts| facts.external_catalog.as_ref());
            contexts.push(CatalogBrowsingContext {
                context_id: String::new(),
                port_id: port.id.clone(),
                route: GameFileRouteKind::ExternalLaunch,
                platform: Some(runtime.platform),
                channel: status.channel,
                installation_method: method(catalog),
                port_member,
                member_context: true,
                installation_id: Some(runtime.id.clone()),
                definition_sha256: definition(catalog)?,
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
        workspace_binding_sha256: binding,
        contexts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ArtifactIdentity, ExternalRuntimeRecord, InstallRecord, UpdatePolicy};

    fn status(id: &str) -> PortStatus {
        PortStatus {
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
            path: "/private/managed-path".into(),
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
                root: "/selected/library".into(),
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
            id: "external-linux-instance".into(),
            port_id: id.clone(),
            path: "/private/external-path".into(),
            executable: "game".into(),
            version: "external-version".into(),
            platform: Platform::LinuxX86_64,
            archive_sha256: "b".repeat(64),
            immutable_tree_sha256: "c".repeat(64),
            registered_at: 1,
            retained_definition: None,
        });
        let retained = HashMap::from([(
            id.clone(),
            RetainedBrowsingFacts {
                managed_catalog: Some(catalog.clone()),
                managed_platform: Some(Platform::WindowsX86_64),
                external_catalog: Some(catalog.clone()),
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
                    && context.channel == ReleaseChannel::Stable
                    && context.route == GameFileRouteKind::ManagedLaunch)
        );
        assert!(
            members
                .iter()
                .any(|context| context.platform == Some(Platform::LinuxX86_64)
                    && context.channel == ReleaseChannel::Beta
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
        assert!(!encoded.contains("/private/managed-path"));
        assert!(!encoded.contains("/private/external-path"));
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
                    root: "/selected/library".into()
                },
                Platform::LinuxX86_64,
            )
            .is_err()
        );
    }
}
