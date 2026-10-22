//! Presentation of Core-owned retained build identities and review boundaries.

use portcove_core::{
    Catalog, RetainedBuildAvailability, RetainedBuildBindingPreview, RetainedBuildGap,
    RetainedBuildIdentity, RetainedBuildInventory, RetainedBuildReference,
    RetainedBuildRemovalPreview, RetainedBuildResolution,
};

use crate::human::{clean, platform_name, port_name, utc_time};

fn availability(value: RetainedBuildAvailability) -> &'static str {
    match value {
        RetainedBuildAvailability::Verified => "Verified local build",
        RetainedBuildAvailability::Missing => "Missing local build",
        RetainedBuildAvailability::Changed => "Changed local build",
        RetainedBuildAvailability::Held => "Held by current policy or lifecycle state",
        RetainedBuildAvailability::Unavailable => "Availability could not be established",
    }
}

fn gap_lines(gap: Option<&RetainedBuildGap>, lines: &mut Vec<String>) {
    if let Some(gap) = gap {
        lines.push(format!("Gap: {}", clean(&gap.message)));
        for (key, value) in &gap.details {
            lines.push(format!("  {}: {}", clean(key), clean(value)));
        }
    }
}

fn identity_lines(build: &RetainedBuildIdentity, catalog: &Catalog) -> Vec<String> {
    let mut lines = vec![
        format!("Port: {}", port_name(catalog, &build.port_id)),
        format!("Install ID: {}", clean(&build.install_id)),
        format!("Platform: {}", platform_name(build.platform)),
        format!("Artifact: {}", clean(&build.artifact.asset_name)),
        format!("Artifact SHA-256: {}", clean(&build.artifact.sha256)),
        format!("Manifest SHA-256: {}", clean(&build.manifest_sha256)),
        format!(
            "Installed contract SHA-256: {}",
            clean(&build.installed_contract_sha256)
        ),
        format!(
            "Selected executable: {}",
            clean(&build.selected_executable.display().to_string())
        ),
    ];
    if let Some(runtime) = &build.runtime {
        lines.extend([
            format!("Runtime artifact: {}", clean(&runtime.artifact.asset_name)),
            format!("Runtime SHA-256: {}", clean(&runtime.artifact.sha256)),
            format!("Runtime executable: {}", clean(&runtime.executable)),
            format!("Runtime directory: {}", clean(&runtime.target_directory)),
        ]);
    } else {
        lines.push(
            "Separate runtime identity: none; the executable and installed contract remain bound."
                .into(),
        );
    }
    if let Some(definition) = &build.definition {
        lines.extend([
            format!(
                "Definition: {}/{} revision {}",
                clean(&definition.namespace),
                clean(&definition.stable_id),
                definition.definition_revision
            ),
            format!(
                "Definition repository SHA-256: {}",
                clean(&definition.repository_root_sha256)
            ),
            format!(
                "Definition grant: {} (policy revision {})",
                clean(&definition.grant_id),
                definition.policy_revision
            ),
        ]);
    } else {
        lines.push(
            "Definition selection: not recorded; the installed contract is identified above."
                .into(),
        );
    }
    lines
}

fn reference_lines(reference: &RetainedBuildReference, catalog: &Catalog) -> Vec<String> {
    let mut lines = vec![
        format!("Setup ID: {}", clean(&reference.setup_id)),
        format!("Reference ID: {}", clean(&reference.id)),
        format!("Reference revision: {}", reference.revision),
    ];
    lines.extend(identity_lines(&reference.build, catalog));
    lines.extend([
        format!("Created: {}", utc_time(reference.created_at)),
        format!("Updated: {}", utc_time(reference.updated_at)),
    ]);
    lines
}

pub(crate) fn inventory(value: &RetainedBuildInventory, catalog: &Catalog) -> String {
    let mut lines = vec![format!(
        "Retained local builds: {}",
        port_name(catalog, &value.port_id)
    )];
    if value.builds.is_empty() {
        lines.push("No managed install records are retained.".into());
    }
    for build in &value.builds {
        lines.extend([
            String::new(),
            format!(
                "Install ID: {} · version {} · {}",
                clean(&build.install.id),
                clean(&build.install.version),
                availability(build.availability)
            ),
            format!(
                "Artifact SHA-256: {}",
                clean(&build.install.artifact.sha256)
            ),
            format!(
                "Manifest SHA-256: {}",
                clean(&build.install.manifest_sha256)
            ),
        ]);
        let mut reasons = Vec::new();
        if build.active {
            reasons.push("active selection".to_owned());
        }
        if build.previous {
            reasons.push("previous selection".to_owned());
        }
        if build.install.staged {
            reasons.push("staged installation".to_owned());
        }
        reasons.extend(
            build
                .retained_by
                .iter()
                .map(|id| format!("setup {}", clean(id))),
        );
        lines.push(if reasons.is_empty() {
            "Retention references: none; cleanup eligibility is checked separately.".into()
        } else {
            format!("Retention references: {}", reasons.join(", "))
        });
        gap_lines(build.gap.as_ref(), &mut lines);
    }
    if !value.references.is_empty() {
        lines.extend([String::new(), "Setup references:".into()]);
        for resolved in &value.references {
            lines.push(format!(
                "  {} → {} · {} (reference {})",
                clean(&resolved.reference.setup_id),
                clean(&resolved.reference.build.install_id),
                availability(resolved.availability),
                clean(&resolved.reference.id)
            ));
            gap_lines(resolved.gap.as_ref(), &mut lines);
        }
    }
    lines.push(
        "Local retention does not establish upstream availability or a future download.".into(),
    );
    lines.join("\n")
}

pub(crate) fn resolution(value: &RetainedBuildResolution, catalog: &Catalog) -> String {
    let mut lines = vec![availability(value.availability).into()];
    lines.extend(reference_lines(&value.reference, catalog));
    gap_lines(value.gap.as_ref(), &mut lines);
    lines.push("The setup reference protects this exact build from cleanup. Current launch and preparation checks still apply.".into());
    lines.join("\n")
}

pub(crate) fn binding_preview(value: &RetainedBuildBindingPreview, catalog: &Catalog) -> String {
    let mut lines = vec![
        "Review retained-build binding".into(),
        format!("Setup ID: {}", clean(&value.setup_id)),
    ];
    lines.extend(identity_lines(&value.build, catalog));
    if let Some(previous) = &value.previous {
        lines.push(format!(
            "Replaces reference {} revision {} to install {} for this setup.",
            clean(&previous.id),
            previous.revision,
            clean(&previous.build.install_id)
        ));
    } else {
        lines.push("Creates this setup's first retained-build reference.".into());
    }
    lines.extend([
        format!("Review SHA-256: {}", clean(&value.preview_sha256)),
        "Binding protects the exact local build from cleanup. Active selection and player data stay unchanged.".into(),
        "No historical release download or future server availability is promised.".into(),
    ]);
    lines.join("\n")
}

pub(crate) fn bound(value: &RetainedBuildReference, catalog: &Catalog) -> String {
    let mut lines = vec!["Retained-build reference saved".into()];
    lines.extend(reference_lines(value, catalog));
    lines.push(
        "This setup protects the exact local build from cleanup; active selection is unchanged."
            .into(),
    );
    lines.join("\n")
}

pub(crate) fn removal_preview(value: &RetainedBuildRemovalPreview, catalog: &Catalog) -> String {
    let mut lines = vec!["Review retained-build reference removal".into()];
    lines.extend(reference_lines(&value.reference, catalog));
    lines.extend([
        format!("Review SHA-256: {}", clean(&value.preview_sha256)),
        "Removes only this setup's reference and cleanup protection. Build files and player data stay in place.".into(),
        "Other setup references, active sessions and lifecycle protections still apply to later cleanup.".into(),
    ]);
    lines.join("\n")
}

pub(crate) fn removed(value: &RetainedBuildReference, catalog: &Catalog) -> String {
    let mut lines = vec!["Retained-build reference removed".into()];
    lines.extend(reference_lines(value, catalog));
    lines.push("Build files and player data remain in place. Later cleanup rechecks every remaining protection.".into());
    lines.join("\n")
}
