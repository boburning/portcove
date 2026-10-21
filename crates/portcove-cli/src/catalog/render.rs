use portcove_core::{
    CatalogOrigin, CatalogStatus, CatalogUpdatePlan, CatalogUpdateSource,
    DefinitionAuthorityProvisioning, DefinitionAuthorityReview, DefinitionEligibilityOutcome,
    DefinitionRefresh, DefinitionRefreshDisposition,
};

use crate::human;

pub(super) fn catalog_result(outcome: &str, status: &CatalogStatus) -> String {
    format!(
        "{outcome}\n{}\nNext step: Run catalog list or catalog show PORT_ID to inspect the active definitions. Installed game files were not updated by this catalog operation.",
        human::catalog_status(status)
    )
}

fn catalog_origin(origin: CatalogOrigin) -> &'static str {
    match origin {
        CatalogOrigin::Embedded => "built-in catalog",
        CatalogOrigin::SignedActive => "active signed catalog",
        CatalogOrigin::SignedPrevious => "previous signed catalog",
        CatalogOrigin::DefinitionSelected => "selected definition catalog",
    }
}

pub(super) fn catalog_update_plan(plan: &CatalogUpdatePlan) -> String {
    let source = match &plan.source {
        CatalogUpdateSource::File(path) => {
            format!("Local file: {}", human::clean(&path.display().to_string()))
        }
        CatalogUpdateSource::Https(url) => format!(
            "HTTPS URL: {}",
            human::clean(&portcove_core::redact_diagnostic_text(url))
        ),
    };
    let mut lines = vec![
        "Signed catalog update review".into(),
        source,
        format!("Active catalog: {}", catalog_origin(plan.current.origin)),
        format!(
            "Active catalog SHA-256: {}",
            human::clean(&plan.current.catalog_sha256)
        ),
        format!(
            "Candidate envelope SHA-256: {}",
            human::clean(&plan.envelope_sha256)
        ),
        format!("Publisher key ID: {}", human::clean(&plan.key_id)),
        format!("Sequence: {}", plan.sequence),
        format!("Issued: {}", human::utc_time(plan.issued_at)),
        format!("Expires: {}", human::utc_time(plan.expires_at)),
        format!(
            "New or changed port definitions: {}",
            plan.changed_ports.len()
        ),
    ];
    if plan.changed_ports.is_empty() {
        lines.push("No new or changed port definitions are listed by this review.".into());
    }
    for port in &plan.changed_ports {
        lines.push(format!(
            "  {} ({})",
            human::clean(&port.name),
            human::clean(&port.id)
        ));
    }
    lines.extend([
        "The list covers added or changed entries; it does not list removals.".into(),
        "Catalog signature, validity, and rollback and replay protection are checked again when applying.".into(),
        "Review only; no catalog change has been applied.".into(),
        format!("Review SHA-256: {}", human::clean(&plan.plan_sha256)),
        format!("Next step: Repeat the selected --file or --url with --apply --expected-plan {}.", human::clean(&plan.plan_sha256)),
    ]);
    lines.join("\n")
}

fn authority_facts(review: &DefinitionAuthorityReview) -> Vec<String> {
    vec![
        format!("Library ID: {}", human::clean(&review.library_id)),
        format!("Compiled authority anchor SHA-256: {}", review.compiled_anchor_sha256.as_deref().map(human::clean).unwrap_or_else(|| "Not configured in this build".into())),
        format!("Installed authority anchor SHA-256: {}", review.installed_anchor_sha256.as_deref().map(human::clean).unwrap_or_else(|| "Not installed".into())),
        format!("Fixed authority installed: {}", if review.installed { "Yes" } else { "No" }),
        "This authority alone does not select a definition or authorize a game operation; authenticated publisher policy is still required.".into(),
    ]
}

pub(super) fn definition_authority_review(review: &DefinitionAuthorityReview) -> String {
    let mut lines = vec!["Definition authority review".into()];
    lines.extend(authority_facts(review));
    lines.push("Review only; no authority change has been applied.".into());
    lines.push(format!(
        "Review SHA-256: {}",
        human::clean(&review.expected_plan)
    ));
    lines.push(if !review.configured {
        "Next step: This build has no configured definition authority; use its available catalog routes.".into()
    } else if review.installed {
        "Next step: The fixed authority is already installed; review catalog status before refreshing a definition.".into()
    } else {
        format!("Next step: Review the fixed anchor, then run catalog definition-authority --apply --expected-plan {}. Add --yes for noninteractive confirmation.", human::clean(&review.expected_plan))
    });
    lines.join("\n")
}

pub(super) fn definition_authority_result(result: &DefinitionAuthorityProvisioning) -> String {
    let mut lines = vec![if result.changed {
        "Definition authority installed".into()
    } else {
        "Definition authority already installed; no authority change needed".into()
    }];
    lines.extend(authority_facts(&result.review));
    lines.push("Next step: Inspect catalog status; an official definition refresh still checks authenticated policy and eligibility.".into());
    lines.join("\n")
}

pub(super) fn definition_refresh(result: &DefinitionRefresh) -> String {
    let disposition = match result.disposition {
        DefinitionRefreshDisposition::Revoked => "Publisher revoked; existing selection retained",
        DefinitionRefreshDisposition::Selected => "Authenticated definition selected",
        DefinitionRefreshDisposition::Ineligible => {
            "Definition unavailable; existing selection retained"
        }
    };
    let mut lines = vec![
        format!("Definition refresh: {disposition}"),
        format!("Publisher namespace: {}", human::clean(&result.namespace)),
        format!("Definition ID: {}", human::clean(&result.stable_id)),
        format!(
            "Publisher policy changed: {}",
            if result.policy_changed { "Yes" } else { "No" }
        ),
        format!(
            "Launch assessment changed: {}",
            if result.launch_assessment_changed {
                "Yes"
            } else {
                "No"
            }
        ),
        format!("Selection revision: {}", result.selection.revision),
    ];
    if let Some(eligibility) = result.eligibility {
        let outcome = match eligibility.outcome {
            DefinitionEligibilityOutcome::Eligible => "Eligible for the checked operation",
            DefinitionEligibilityOutcome::Hold => "On hold",
            DefinitionEligibilityOutcome::Escalate => "Further review required",
        };
        lines.push(format!(
            "Eligibility: {outcome}; {}",
            human::definition_reason(eligibility.reason)
        ));
    } else {
        lines.push("Eligibility: No operation assessment returned by this refresh".into());
    }
    if let Some(selected) = &result.selection.selected {
        lines.extend([
            format!(
                "Selected definition: {} / {} (revision {})",
                human::clean(&selected.namespace),
                human::clean(&selected.stable_id),
                selected.definition_revision
            ),
            format!("Publisher grant ID: {}", human::clean(&selected.grant_id)),
            format!("Publisher policy revision: {}", selected.policy_revision),
            format!(
                "Authority root SHA-256: {}",
                human::clean(&selected.repository_root_sha256)
            ),
            format!(
                "Definition index SHA-256: {}",
                human::clean(&selected.provenance.index_sha256)
            ),
            format!(
                "Expires: {}",
                human::clean(&selected.provenance.earliest_expiration)
            ),
        ]);
    } else {
        lines.push("Selected definition: None".into());
    }
    if let Some(floor) = &result.selection.replay_floor {
        lines.push("Rollback and replay protection: retained authenticated metadata floor".into());
        for (role, version, hash) in [
            ("Root", floor.root_version, &floor.root_sha256),
            (
                "Timestamp",
                floor.timestamp_version,
                &floor.timestamp_sha256,
            ),
            ("Snapshot", floor.snapshot_version, &floor.snapshot_sha256),
            ("Targets", floor.targets_version, &floor.targets_sha256),
            (
                "Definitions",
                floor.definitions_version,
                &floor.definitions_sha256,
            ),
        ] {
            lines.push(format!(
                "  {role}: version {version}, SHA-256 {}",
                human::clean(hash)
            ));
        }
        lines.push(format!(
            "  Index SHA-256: {}",
            human::clean(&floor.index_sha256)
        ));
    } else {
        lines.push("Rollback and replay protection: no selected-definition floor recorded".into());
    }
    lines.extend([
        format!("Retained definition rollback: {}", if result.selection.can_rollback { "Available" } else { "Unavailable" }),
        "Installed game files were not updated by this refresh.".into(),
        "Next step: Run catalog status and status PORT_ID in a new invocation to read the resulting catalog and operation eligibility.".into(),
    ]);
    lines.join("\n")
}

pub(crate) fn definition_capabilities(
    report: &portcove_core::DefinitionCapabilityReport,
) -> String {
    use portcove_core::DefinitionCapabilityOutcome;
    let mut lines = vec![format!(
        "Engine capability review: {}",
        if report.compatible {
            "Required versions available"
        } else {
            "Required versions unavailable"
        }
    )];
    lines.push(format!("Requirements checked: {}", report.checks.len()));
    for check in &report.checks {
        let outcome = match check.outcome {
            DefinitionCapabilityOutcome::Supported => "Supported",
            DefinitionCapabilityOutcome::UnsupportedTemplate => {
                "Template unavailable in this engine"
            }
            DefinitionCapabilityOutcome::UnsupportedVersion => {
                "Required version unavailable in this engine"
            }
        };
        lines.push(format!(
            "  Template {}: {outcome}; required versions {} through {}; installed version {}",
            human::clean(&check.requirement.template),
            check.requirement.minimum_version,
            check.requirement.maximum_version,
            check
                .installed_version
                .map_or_else(|| "Unavailable".into(), |version| version.to_string())
        ));
    }
    lines.push("This review checks engine capability versions only; it does not authenticate a publisher, admit a definition, or change a library.".into());
    lines.push(if report.compatible {
        "Next step: Continue the documented catalog review and trust workflow for the exact definition.".into()
    } else {
        "Next step: Use an engine version that supports the listed requirements, then check this file again; do not treat an unsupported template as admitted.".into()
    });
    lines.join("\n")
}

pub(crate) fn proposal_inspection(
    report: &portcove_core::CatalogProposalInspection,
    technical_details: bool,
) -> String {
    let mut lines = vec![
        "Catalog proposal inspection completed".into(),
        format!("Input: {}", human::format_bytes(report.input_bytes)),
        format!("Input SHA-256: {}", human::clean(&report.input_sha256)),
        format!("Catalog schema: {}", report.catalog_schema),
        format!("Port declarations checked: {}", report.ports.len()),
        "Scope: Inert catalog declarations and declared contracts only. Publisher trust, downloaded artifacts, gameplay and publication were not checked.".into(),
    ];
    if report.ports.is_empty() {
        lines.push("The proposal contains no port declarations.".into());
    }
    if technical_details {
        for port in &report.ports {
            lines.push(format!(
                "Definition ID: {}\n  Definition SHA-256: {}",
                human::clean(&port.port_id),
                human::clean(&port.definition_sha256)
            ));
            for (platform, hash) in &port.curated_record_sha256 {
                lines.push(format!(
                    "  Declared curated record ({}), SHA-256: {}",
                    human::platform_name(*platform),
                    human::clean(hash)
                ));
            }
        }
    } else if !report.ports.is_empty() {
        lines.push(
            "Use --technical-details for each checked definition ID and full declaration SHA-256."
                .into(),
        );
    }
    lines.push("Next step: Review the exact input and continue the documented catalog qualification and publication workflow; this inspection does not activate it.".into());
    lines.join("\n")
}

pub(crate) fn publication_inspection(
    report: &portcove_core::DefinitionPublicationInspection,
    technical_details: bool,
) -> String {
    let bytes: u64 = report.files.iter().map(|file| file.bytes).sum();
    let mut lines = vec![
        "Definition publication inspection completed".into(),
        format!("Definition index SHA-256: {}", human::clean(&report.index_sha256)),
        format!("Definitions checked: {}", report.definitions.len()),
        format!("Files checked: {} ({})", report.files.len(), human::format_bytes(bytes)),
        "Scope: Local supplied bytes and fixed publication contracts only. No publisher authority was installed, no definition was authenticated for use, and no library was changed.".into(),
    ];
    if report.definitions.is_empty() {
        lines.push("The bundle contains no definition identities.".into());
    }
    for definition in &report.definitions {
        lines.push(format!(
            "Definition: {} / {} (revision {}); policy revision {}; grant ID {}",
            human::clean(&definition.namespace),
            human::clean(&definition.stable_id),
            definition.revision,
            definition.policy_revision,
            human::clean(&definition.grant_id)
        ));
    }
    if technical_details {
        for file in &report.files {
            lines.push(format!(
                "File: {}\n  Size: {}\n  SHA-256: {}",
                human::clean(&file.target),
                human::format_bytes(file.bytes),
                human::clean(&file.sha256)
            ));
        }
    } else if !report.files.is_empty() {
        lines.push("Use --technical-details for each checked file and full SHA-256.".into());
    }
    lines.push("Next step: Continue the documented signed-definition publication review for these exact bytes; successful inspection is not permission to publish or activate them.".into());
    lines.join("\n")
}

pub(crate) fn upstream_observation(
    report: &portcove_core::UpstreamObservationReport,
    port: &portcove_core::PortDefinition,
) -> String {
    let mut lines = vec![
        format!("Upstream observation review: {} ({})", human::clean(&port.name), human::clean(&report.port_id)),
        format!("Repository ID: {}", report.repository_id),
        format!("Observed: {}", human::clean(&report.observed_at)),
        format!("Observed facts SHA-256: {}", human::clean(&report.facts_sha256)),
        format!("Catalog definition SHA-256: {}", human::clean(&report.catalog_definition_sha256)),
        "Scope: Interpretation of supplied release metadata; the independent evidence is listed below.".into(),
        format!("Provider authentication: {}", if report.evidence.provider_authenticated { "Established" } else { "Not established" }),
        format!("Artifact bytes checked: {}", if report.evidence.artifact_bytes_verified { "Yes" } else { "No" }),
        format!("Catalog admission assessed: {}", if report.evidence.catalog_admission_assessed { "Yes" } else { "No" }),
        format!("Platform/channel projections: {}", report.projections.len()),
    ];
    for projection in &report.projections {
        lines.push(format!(
            "{} / {}",
            human::platform_name(projection.platform),
            human::release_channel(projection.channel)
        ));
        if let Some(latest) = &projection.latest_observed {
            lines.push(format!(
                "  Latest observed release: {} (release ID {})",
                human::clean(&latest.tag),
                latest.id
            ));
            lines.push(format!(
                "  Published: {}",
                latest
                    .published_at
                    .as_deref()
                    .map(human::clean)
                    .unwrap_or_else(|| "Unknown".into())
            ));
        } else {
            lines.push("  Latest observed release: None".into());
        }
        if let Some(candidate) = &projection.channel_candidate {
            lines.push(format!(
                "  Channel candidate: {} (release ID {})",
                human::clean(&candidate.tag),
                candidate.id
            ));
        } else {
            lines.push("  Channel candidate: None".into());
        }
        if let Some(resolved) = &projection.latest_eligible {
            lines.extend([
                format!(
                    "  Metadata-matched asset: {} (asset ID {}, release ID {})",
                    human::clean(&resolved.release.asset.name),
                    resolved.asset_id,
                    resolved.release_id
                ),
                format!(
                    "  Asset size: {}",
                    human::format_bytes(resolved.release.asset.size)
                ),
                format!(
                    "  Declared asset SHA-256: {}",
                    human::clean(&resolved.release.asset.sha256)
                ),
            ]);
        } else {
            lines.push("  Metadata-matched asset: None".into());
        }
        for reason in &projection.hold_reasons {
            let explanation = match reason.as_str() {
                "channel-not-offered" => "This port does not offer the selected channel",
                "no-published-channel-candidate" => "No published release matches this channel",
                "asset-missing-or-ambiguous" => {
                    "A unique asset for this platform could not be selected"
                }
                "authenticated-digest-requires-further-resolution" => {
                    "An authenticated digest requires further release resolution"
                }
                _ => "The metadata does not establish eligibility; inspect the structured reason",
            };
            lines.push(format!("  Hold: {explanation} ({})", human::clean(reason)));
        }
    }
    lines.push("Next step: Resolve and review the actual catalog release before installation; this inert observation does not authorize a download or a game operation.".into());
    lines.join("\n")
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
