//! Scoped activation checks for an already selected successor definition.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::{Catalog, PortcoveError, Result, SourceCatalog, SourceRepresentationKind};

pub(crate) fn validate_definition_transition(
    baseline: &Catalog,
    candidate: &Catalog,
    selected_port_id: &str,
) -> Result<()> {
    let baseline = baseline.authoritative_document();
    let candidate = candidate.authoritative_document();
    if baseline.schema_version != candidate.schema_version {
        return Err(baseline_drift("catalog schema changed"));
    }

    let baseline_ports = values_by_id(&baseline.ports, |port| &port.id)?;
    let candidate_ports = values_by_id(&candidate.ports, |port| &port.id)?;
    if !candidate_ports.contains_key(selected_port_id) {
        return Err(out_of_scope("selected port is missing"));
    }
    for (id, value) in &baseline_ports {
        if *id != selected_port_id && candidate_ports.get(id) != Some(value) {
            return Err(baseline_drift("an unrelated port changed or was removed"));
        }
    }
    if candidate_ports
        .keys()
        .any(|id| !baseline_ports.contains_key(id) && *id != selected_port_id)
    {
        return Err(baseline_drift("more than the selected port was added"));
    }
    let baseline_order = baseline
        .ports
        .iter()
        .filter(|port| port.id != selected_port_id)
        .map(|port| port.id.as_str())
        .collect::<Vec<_>>();
    let candidate_order = candidate
        .ports
        .iter()
        .filter(|port| port.id != selected_port_id)
        .map(|port| port.id.as_str())
        .collect::<Vec<_>>();
    if baseline_order != candidate_order {
        return Err(baseline_drift("unrelated port ordering changed"));
    }
    validate_subject_safety(&baseline.ports, &candidate.ports, selected_port_id)?;

    match (
        baseline.source_catalog.as_ref(),
        candidate.source_catalog.as_ref(),
    ) {
        (None, None) => Ok(()),
        (Some(baseline), Some(candidate)) => {
            validate_source_transition(baseline, candidate, selected_port_id)
        }
        _ => Err(out_of_scope("source authority presence changed")),
    }
}

fn validate_subject_safety(
    baseline: &[crate::PortDefinition],
    candidate: &[crate::PortDefinition],
    selected_port_id: &str,
) -> Result<()> {
    if let Some(previous) = baseline.iter().find(|port| port.id == selected_port_id)
        && let Some(next) = candidate.iter().find(|port| port.id == selected_port_id)
    {
        crate::profile_loader::validate_successor(previous, next)?;
        crate::provider_binding::validate_successor(previous, next)?;
    }
    validate_acquisition_hold_transition(baseline, candidate, selected_port_id)?;
    validate_package_layout_transition(baseline, candidate, selected_port_id)?;
    validate_accepted_uploader_transition(baseline, candidate, selected_port_id)?;

    Ok(())
}

/// A committed predecessor is already an exact typed snapshot. Its unrelated
/// rows and embedded schema no longer determine the new catalog baseline.
pub(crate) fn validate_retained_subject_successor(
    predecessor: &Catalog,
    successor: &Catalog,
    selected: &str,
) -> Result<()> {
    predecessor.port(selected)?;
    successor.port(selected)?;
    validate_subject_safety(predecessor.ports(), successor.ports(), selected)?;
    let Some(prior) = predecessor.source_catalog() else {
        return Ok(());
    };
    let next = successor
        .source_catalog()
        .ok_or_else(|| out_of_scope("retained subject lost source authority"))?;
    let prior = subject_source_records(prior, selected);
    require_existing_records(
        &values_by_id(&prior.evidence, |value| &value.id)?,
        &values_by_id(&next.evidence, |value| &value.id)?,
        "source evidence",
    )?;
    require_existing_records(
        &values_by_id(&prior.identities, |value| &value.id)?,
        &values_by_id(&next.identities, |value| &value.id)?,
        "source identity",
    )?;
    require_existing_records(
        &values_by_id(&prior.validators, |value| &value.id)?,
        &values_by_id(&next.validators, |value| &value.id)?,
        "source validator",
    )
}

pub(crate) fn validate_historical_source_overlap(
    historical: &Catalog,
    effective: &Catalog,
    selected: &str,
) -> Result<()> {
    if let (Some(historical), Some(effective)) =
        (historical.source_catalog(), effective.source_catalog())
    {
        let mut scoped = subject_source_records(historical, selected);
        merge_immutable_records(&mut scoped.evidence, &effective.evidence, |value| &value.id)?;
        merge_immutable_records(&mut scoped.identities, &effective.identities, |value| {
            &value.id
        })?;
        merge_immutable_records(&mut scoped.validators, &effective.validators, |value| {
            &value.id
        })?;
    }
    Ok(())
}

fn subject_source_records(graph: &SourceCatalog, selected: &str) -> SourceCatalog {
    let mut scope = SourceCatalog {
        evidence: Vec::new(),
        identities: Vec::new(),
        contracts: graph
            .contracts
            .iter()
            .filter(|row| row.port_id == selected)
            .cloned()
            .collect(),
        validators: Vec::new(),
        qualification: graph
            .qualification
            .iter()
            .filter(|row| row.scope.port_id == selected)
            .cloned()
            .collect(),
    };
    let profile_ids: HashSet<_> = scope
        .contracts
        .iter()
        .map(|row| row.profile_id.as_str())
        .collect();
    scope.identities.extend(
        graph
            .identities
            .iter()
            .filter(|row| profile_ids.contains(row.id.as_str()))
            .cloned(),
    );
    let mut validators: HashSet<_> = scope
        .contracts
        .iter()
        .filter_map(|row| row.validator_contract_id.as_deref())
        .collect();
    let mut evidence: HashSet<_> = scope
        .contracts
        .iter()
        .flat_map(|row| row.evidence_ids.iter().map(String::as_str))
        .collect();
    for variant in scope
        .identities
        .iter()
        .flat_map(|identity| &identity.variants)
    {
        evidence.extend(variant.evidence_ids.iter().map(String::as_str));
        for representation in &variant.representations {
            evidence.extend(representation.evidence_ids.iter().map(String::as_str));
            if let SourceRepresentationKind::PinnedValidator {
                validator_contract_id,
            } = &representation.kind
            {
                validators.insert(validator_contract_id);
            }
        }
    }
    scope.validators.extend(
        graph
            .validators
            .iter()
            .filter(|row| validators.contains(row.id.as_str()))
            .cloned(),
    );
    evidence.extend(
        scope
            .validators
            .iter()
            .flat_map(|row| row.evidence_ids.iter().map(String::as_str)),
    );
    evidence.extend(
        scope
            .qualification
            .iter()
            .flat_map(|row| row.evidence_ids.iter().map(String::as_str)),
    );
    scope.evidence.extend(
        graph
            .evidence
            .iter()
            .filter(|row| evidence.contains(row.id.as_str()))
            .cloned(),
    );
    scope
}

/// Combine one already-validated subject with previously validated unrelated
/// selections. A legacy full projection can only contribute its selected port
/// and in-scope source graph. It cannot replace another selection's document.
pub(crate) fn compose_verified_definition(
    effective: &Catalog,
    scoped: &Catalog,
    selected: &str,
) -> Result<Catalog> {
    let mut document = effective.authoritative_document();
    let port = scoped.port(selected)?.clone();
    if let Some(prior) = document.ports.iter_mut().find(|value| value.id == selected) {
        *prior = port;
    } else {
        document.ports.push(port);
    }
    match (document.source_catalog.as_mut(), scoped.source_catalog()) {
        (Some(effective), Some(scoped)) => {
            merge_immutable_records(&mut effective.evidence, &scoped.evidence, |value| &value.id)?;
            merge_immutable_records(&mut effective.identities, &scoped.identities, |value| {
                &value.id
            })?;
            merge_immutable_records(&mut effective.validators, &scoped.validators, |value| {
                &value.id
            })?;
            effective
                .contracts
                .retain(|value| value.port_id != selected);
            effective.contracts.extend(
                scoped
                    .contracts
                    .iter()
                    .filter(|value| value.port_id == selected)
                    .cloned(),
            );
            effective
                .qualification
                .retain(|value| value.scope.port_id != selected);
            effective.qualification.extend(
                scoped
                    .qualification
                    .iter()
                    .filter(|value| value.scope.port_id == selected)
                    .cloned(),
            );
        }
        (None, None) => {}
        _ => return Err(out_of_scope("source authority presence changed")),
    }
    let mut catalog = Catalog::from_document(document)?;
    catalog.retain_embedded_file_patterns(effective, selected)?;
    catalog.retain_unrelated_upstream_reviews(effective, selected);
    validate_definition_transition(effective, &catalog, selected)?;
    catalog.retain_cached_definition_selections(effective);
    catalog.retain_independent_definition_selection(scoped, selected)?;
    Ok(catalog)
}

fn merge_immutable_records<T: Clone + PartialEq>(
    effective: &mut Vec<T>,
    scoped: &[T],
    id: impl Fn(&T) -> &str,
) -> Result<()> {
    let positions: HashMap<_, _> = effective
        .iter()
        .enumerate()
        .map(|(position, record)| (id(record), position))
        .collect();
    let mut added = Vec::new();
    for record in scoped {
        match positions.get(id(record)) {
            Some(position) if &effective[*position] != record => {
                return Err(out_of_scope(
                    "independently selected source records conflict",
                ));
            }
            Some(_) => {}
            None => added.push(record.clone()),
        }
    }
    effective.extend(added);
    Ok(())
}

/// A selected definition may keep or add restriction to an existing managed
/// acquisition hold, but never remove it or permit an artifact the baseline did
/// not review. Clearing a hold is a reviewed catalog change shipped with the
/// application.
fn validate_acquisition_hold_transition(
    baseline: &[crate::PortDefinition],
    candidate: &[crate::PortDefinition],
    selected_port_id: &str,
) -> Result<()> {
    let restrictions = |ports: &[crate::PortDefinition]| {
        ports
            .iter()
            .find(|port| port.id == selected_port_id)
            .map(crate::acquisition_restriction::definition_restrictions)
            .unwrap_or_default()
    };
    crate::acquisition_restriction::validate_transition(
        &restrictions(baseline),
        &restrictions(candidate),
    )
    .map_err(out_of_scope)
}

/// A selected definition may replace a reviewed package-layout fingerprint with
/// a newly reviewed one, but never silently drop the requirement for a platform.
fn validate_package_layout_transition(
    baseline: &[crate::PortDefinition],
    candidate: &[crate::PortDefinition],
    selected_port_id: &str,
) -> Result<()> {
    let layouts = |ports: &[crate::PortDefinition]| {
        ports
            .iter()
            .find(|port| port.id == selected_port_id)
            .map(|port| {
                port.reviewed_package_layouts
                    .keys()
                    .copied()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let candidate_platforms = layouts(candidate);
    if layouts(baseline)
        .iter()
        .all(|platform| candidate_platforms.contains(platform))
    {
        Ok(())
    } else {
        Err(out_of_scope("a reviewed package layout was removed"))
    }
}

/// A selected definition may keep or narrow the reviewed release uploaders, but
/// never accept one the baseline did not. Accepting a new uploader is a reviewed
/// catalog change shipped with the application.
fn validate_accepted_uploader_transition(
    baseline: &[crate::PortDefinition],
    candidate: &[crate::PortDefinition],
    selected_port_id: &str,
) -> Result<()> {
    let accepted = |ports: &[crate::PortDefinition]| {
        ports
            .iter()
            .find(|port| port.id == selected_port_id)
            .map(|port| {
                port.release
                    .accepted_uploaders
                    .iter()
                    .map(|uploader| uploader.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let baseline = accepted(baseline);
    if accepted(candidate).iter().all(|id| baseline.contains(id)) {
        Ok(())
    } else {
        Err(out_of_scope(
            "a selected definition accepts an unreviewed release uploader",
        ))
    }
}

fn validate_source_transition(
    baseline: &SourceCatalog,
    candidate: &SourceCatalog,
    selected_port_id: &str,
) -> Result<()> {
    let baseline_evidence = values_by_id(&baseline.evidence, |value| &value.id)?;
    let candidate_evidence = values_by_id(&candidate.evidence, |value| &value.id)?;
    let baseline_identities = values_by_id(&baseline.identities, |value| &value.id)?;
    let candidate_identities = values_by_id(&candidate.identities, |value| &value.id)?;
    let baseline_validators = values_by_id(&baseline.validators, |value| &value.id)?;
    let candidate_validators = values_by_id(&candidate.validators, |value| &value.id)?;

    let immutable_frame =
        require_existing_records(&baseline_evidence, &candidate_evidence, "source evidence")
            .and_then(|()| {
                require_existing_records(
                    &baseline_identities,
                    &candidate_identities,
                    "source identity",
                )
            })
            .and_then(|()| {
                require_existing_records(
                    &baseline_validators,
                    &candidate_validators,
                    "source validator",
                )
            });
    if let Err(error) = immutable_frame {
        let prior = subject_source_records(baseline, selected_port_id);
        let proposed = subject_source_records(candidate, selected_port_id);
        let scoped_change = changed_owned_records(
            &prior.evidence,
            &proposed.evidence,
            &baseline_evidence,
            &candidate_evidence,
            |row| &row.id,
        ) || changed_owned_records(
            &prior.identities,
            &proposed.identities,
            &baseline_identities,
            &candidate_identities,
            |row| &row.id,
        ) || changed_owned_records(
            &prior.validators,
            &proposed.validators,
            &baseline_validators,
            &candidate_validators,
            |row| &row.id,
        );
        return Err(if scoped_change {
            error
        } else {
            error.detail("definition_baseline_drift", "true")
        });
    }
    require_existing_order(
        baseline.evidence.iter().map(|value| value.id.as_str()),
        candidate
            .evidence
            .iter()
            .filter(|value| baseline_evidence.contains_key(value.id.as_str()))
            .map(|value| value.id.as_str()),
        "source evidence",
    )?;
    require_existing_order(
        baseline.identities.iter().map(|value| value.id.as_str()),
        candidate
            .identities
            .iter()
            .filter(|value| baseline_identities.contains_key(value.id.as_str()))
            .map(|value| value.id.as_str()),
        "source identity",
    )?;
    require_existing_order(
        baseline.validators.iter().map(|value| value.id.as_str()),
        candidate
            .validators
            .iter()
            .filter(|value| baseline_validators.contains_key(value.id.as_str()))
            .map(|value| value.id.as_str()),
        "source validator",
    )?;

    let baseline_contracts = values_by_id(&baseline.contracts, |value| &value.id)?;
    let candidate_contracts = values_by_id(&candidate.contracts, |value| &value.id)?;
    for contract in &baseline.contracts {
        if contract.port_id != selected_port_id
            && candidate_contracts.get(contract.id.as_str())
                != baseline_contracts.get(contract.id.as_str())
        {
            return Err(baseline_drift(
                "an unrelated source contract changed or was removed",
            ));
        }
    }
    for contract in &candidate.contracts {
        let unchanged = baseline_contracts.get(contract.id.as_str())
            == candidate_contracts.get(contract.id.as_str());
        if !unchanged && contract.port_id != selected_port_id {
            return Err(baseline_drift("a changed source contract is not selected"));
        }
    }
    require_existing_order(
        baseline
            .contracts
            .iter()
            .filter(|value| value.port_id != selected_port_id)
            .map(|value| value.id.as_str()),
        candidate
            .contracts
            .iter()
            .filter(|value| value.port_id != selected_port_id)
            .map(|value| value.id.as_str()),
        "unrelated source contract",
    )?;

    let baseline_qualification = baseline
        .qualification
        .iter()
        .filter(|value| value.scope.port_id != selected_port_id)
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let candidate_qualification = candidate
        .qualification
        .iter()
        .filter(|value| value.scope.port_id != selected_port_id)
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if baseline_qualification != candidate_qualification {
        return Err(baseline_drift("unrelated source qualification changed"));
    }

    let selected_contracts = candidate
        .contracts
        .iter()
        .filter(|contract| contract.port_id == selected_port_id)
        .collect::<Vec<_>>();
    let selected_profiles = selected_contracts
        .iter()
        .map(|contract| contract.profile_id.as_str())
        .collect::<HashSet<_>>();
    for identity in &candidate.identities {
        if !baseline_identities.contains_key(identity.id.as_str())
            && !selected_profiles.contains(identity.id.as_str())
        {
            return Err(out_of_scope(
                "new source identity is not owned by the selected port",
            ));
        }
    }

    let new_identity_ids = candidate
        .identities
        .iter()
        .filter(|identity| !baseline_identities.contains_key(identity.id.as_str()))
        .map(|identity| identity.id.as_str())
        .collect::<HashSet<_>>();
    let mut selected_validators = selected_contracts
        .iter()
        .filter_map(|contract| contract.validator_contract_id.as_deref())
        .collect::<HashSet<_>>();
    for identity in candidate
        .identities
        .iter()
        .filter(|identity| new_identity_ids.contains(identity.id.as_str()))
    {
        for representation in identity
            .variants
            .iter()
            .flat_map(|variant| &variant.representations)
        {
            if let SourceRepresentationKind::PinnedValidator {
                validator_contract_id,
            } = &representation.kind
            {
                selected_validators.insert(validator_contract_id);
            }
        }
    }
    for validator in &candidate.validators {
        if !baseline_validators.contains_key(validator.id.as_str())
            && !selected_validators.contains(validator.id.as_str())
        {
            return Err(out_of_scope(
                "new source validator is not owned by the selected port",
            ));
        }
    }

    let mut selected_evidence = HashSet::new();
    for contract in selected_contracts {
        selected_evidence.extend(contract.evidence_ids.iter().map(String::as_str));
    }
    for identity in candidate
        .identities
        .iter()
        .filter(|identity| new_identity_ids.contains(identity.id.as_str()))
    {
        for variant in &identity.variants {
            selected_evidence.extend(variant.evidence_ids.iter().map(String::as_str));
            for representation in &variant.representations {
                selected_evidence.extend(representation.evidence_ids.iter().map(String::as_str));
            }
        }
    }
    for validator in candidate
        .validators
        .iter()
        .filter(|validator| !baseline_validators.contains_key(validator.id.as_str()))
    {
        selected_evidence.extend(validator.evidence_ids.iter().map(String::as_str));
    }
    for record in candidate
        .qualification
        .iter()
        .filter(|record| record.scope.port_id == selected_port_id)
    {
        selected_evidence.extend(record.evidence_ids.iter().map(String::as_str));
    }
    for evidence in &candidate.evidence {
        if !baseline_evidence.contains_key(evidence.id.as_str())
            && !selected_evidence.contains(evidence.id.as_str())
        {
            return Err(out_of_scope(
                "new source evidence is not owned by the selected port",
            ));
        }
    }
    Ok(())
}

fn values_by_id<'a, T: Serialize>(
    values: &'a [T],
    id: impl Fn(&'a T) -> &'a str,
) -> Result<HashMap<&'a str, serde_json::Value>> {
    values
        .iter()
        .map(|value| Ok((id(value), serde_json::to_value(value)?)))
        .collect()
}

fn changed_owned_records<T>(
    prior: &[T],
    proposed: &[T],
    baseline: &HashMap<&str, serde_json::Value>,
    candidate: &HashMap<&str, serde_json::Value>,
    id: impl Fn(&T) -> &str,
) -> bool {
    prior.iter().chain(proposed).any(|record| {
        let id = id(record);
        baseline
            .get(id)
            .is_some_and(|value| candidate.get(id) != Some(value))
    })
}

fn require_existing_records(
    baseline: &HashMap<&str, serde_json::Value>,
    candidate: &HashMap<&str, serde_json::Value>,
    label: &str,
) -> Result<()> {
    if baseline
        .iter()
        .any(|(id, value)| candidate.get(id) != Some(value))
    {
        return Err(out_of_scope(format!(
            "existing {label} changed or was removed"
        )));
    }
    Ok(())
}

fn require_existing_order<'a>(
    baseline: impl Iterator<Item = &'a str>,
    candidate: impl Iterator<Item = &'a str>,
    label: &str,
) -> Result<()> {
    if !baseline.eq(candidate) {
        return Err(out_of_scope(format!("existing {label} ordering changed")));
    }
    Ok(())
}

fn baseline_drift(message: impl Into<String>) -> PortcoveError {
    out_of_scope(message).detail("definition_baseline_drift", "true")
}

fn out_of_scope(message: impl Into<String>) -> PortcoveError {
    PortcoveError::verification(format!(
        "selected definition changes catalog state outside its scope: {}",
        message.into()
    ))
}

#[cfg(test)]
mod tests {
    use super::validate_definition_transition;
    use crate::{Catalog, test_fixture::post_client_catalog};
    use serde_json::{Value, json};

    fn rebuild(document: crate::CatalogDocument) -> Catalog {
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
    }

    // Scope checks only need two existing siblings and one selected addition.
    // Keep the embedded catalog in the acceptance test for production coverage.
    fn scoped_catalogs() -> (Catalog, Catalog, String) {
        let mut baseline = json!({
            "schema_version": 2,
            "source_catalog": {
                "evidence": [{
                    "id": "fixture-bytes", "role": "byte_identity",
                    "authority": "Synthetic scope fixture", "authority_ref": "fixture-1",
                    "reviewed_at": "2026-09-30", "claim": "Synthetic source byte identity",
                    "immutable_url": "https://example.invalid/fixtures/source-v1"
                }],
                "identities": [{
                    "id": "scope-source", "label": "Synthetic source",
                    "kind": "file", "variants": [{
                        "id": "fixture-1", "title": "Synthetic source",
                        "representations": [{
                            "id": "raw", "extensions": ["bin"], "kind": "raw-file",
                            "identities": [{"scope": "original-file", "sha256": "8".repeat(64)}],
                            "evidence_ids": ["fixture-bytes"]
                        }], "evidence_ids": ["fixture-bytes"]
                    }]
                }],
                "contracts": [{
                    "id": "scope-first-game", "port_id": "scope-first",
                    "role": "game", "profile_id": "scope-source",
                    "admission_mode": "enforced", "supported_variant_ids": ["fixture-1"],
                    "evidence_ids": ["fixture-bytes"], "authority_ref": "fixture-1",
                    "reviewed_at": "2026-09-30",
                    "immutable_review_url": "https://example.invalid/fixtures/source-v1"
                }], "validators": []
            },
            "ports": [{
                "id": "scope-first", "name": "Scope first",
                "summary": "Synthetic scope fixture",
                "project_url": "https://example.invalid/fixtures/scope", "support_tier": "stable",
                "channels": ["stable"], "platforms": ["linux-x86-64"],
                "adapter": "libultraship-portable",
                "release": {"repository": "fixture/scope"},
                "source_profile": "scope-source",
                "executable_hints": {"linux-x86-64": ["fixture"]},
                "persistent_paths": ["saves", "config.json"]
            }]
        });
        let mut sibling = baseline["ports"][0].clone();
        sibling["id"] = json!("scope-second");
        sibling["name"] = json!("Scope second");
        baseline["ports"].as_array_mut().unwrap().push(sibling);
        let mut sibling_contract = baseline["source_catalog"]["contracts"][0].clone();
        sibling_contract["id"] = json!("scope-second-game");
        sibling_contract["port_id"] = json!("scope-second");
        baseline["source_catalog"]["contracts"]
            .as_array_mut()
            .unwrap()
            .push(sibling_contract);

        let mut candidate = baseline.clone();
        let port_id = "scope-selected".to_string();
        let profile_id = "scope-selected-source";
        let mut selected = candidate["ports"][0].clone();
        selected["id"] = json!(port_id);
        selected["name"] = json!("Scope selected");
        selected["source_profile"] = json!(profile_id);
        candidate["ports"].as_array_mut().unwrap().push(selected);
        let mut identity = candidate["source_catalog"]["identities"][0].clone();
        identity["id"] = json!(profile_id);
        candidate["source_catalog"]["identities"]
            .as_array_mut()
            .unwrap()
            .push(identity);
        let mut selected_contract = candidate["source_catalog"]["contracts"][0].clone();
        selected_contract["id"] = json!("scope-selected-game");
        selected_contract["port_id"] = json!(port_id);
        selected_contract["profile_id"] = json!(profile_id);
        candidate["source_catalog"]["contracts"]
            .as_array_mut()
            .unwrap()
            .push(selected_contract);

        let parse = |value: Value| Catalog::from_json(&value.to_string()).unwrap();
        let baseline = parse(baseline);
        let candidate = parse(candidate);
        assert_eq!(baseline.authoritative_document().ports.len(), 2);
        assert_eq!(candidate.authoritative_document().ports.len(), 3);
        validate_definition_transition(&baseline, &candidate, &port_id).unwrap();
        (baseline, candidate, port_id)
    }

    #[test]
    fn accepts_a_scoped_post_client_definition() {
        let baseline = Catalog::embedded().unwrap();
        let (candidate, port_id) = post_client_catalog();

        validate_definition_transition(&baseline, &candidate, &port_id).unwrap();
    }

    #[test]
    fn a_selected_definition_cannot_remove_or_widen_a_managed_acquisition_hold() {
        let baseline = Catalog::embedded().unwrap();
        let port_id = "open-nectar-pikmin";
        let with = |change: &dyn Fn(&mut Option<crate::ManagedAcquisitionHold>)| {
            let mut document = baseline.authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == port_id)
                .unwrap();
            assert!(port.managed_acquisition_hold.is_some());
            change(&mut port.managed_acquisition_hold);
            rebuild(document)
        };

        let reworded = with(&|hold| hold.as_mut().unwrap().reason.push_str(" Check back later."));
        validate_definition_transition(&baseline, &reworded, port_id).unwrap();
        let narrowed = with(&|hold| hold.as_mut().unwrap().reviewed_artifacts.clear());
        validate_definition_transition(&baseline, &narrowed, port_id).unwrap();

        let removed = with(&|hold| *hold = None);
        let error = validate_definition_transition(&baseline, &removed, port_id).unwrap_err();
        assert!(error.message.contains("hold was removed"));
        let widened = with(&|hold| {
            hold.as_mut()
                .unwrap()
                .reviewed_artifacts
                .push(crate::ReviewedHoldArtifact {
                    version: "1.1.1".into(),
                    sha256: "3".repeat(64),
                });
        });
        let error = validate_definition_transition(&baseline, &widened, port_id).unwrap_err();
        assert!(error.message.contains("unreviewed artifact"));
    }

    #[test]
    fn a_selected_definition_cannot_drop_an_exact_artifact_exclusion() {
        let baseline = Catalog::embedded().unwrap();
        let port_id = "super-metroid-recomp";
        let mut document = baseline.authoritative_document();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == port_id)
            .unwrap();
        let hold = port.managed_acquisition_hold.as_mut().unwrap();
        assert!(hold.excluded_artifacts.len() > 1);
        hold.excluded_artifacts.pop();
        assert!(validate_definition_transition(&baseline, &rebuild(document), port_id).is_err());
    }

    #[test]
    fn a_selected_definition_can_replace_but_not_remove_a_reviewed_package_layout() {
        let port_id = "open-nectar-pikmin";
        let platform = crate::Platform::WindowsX86_64;
        let layout = |name: &str| crate::ReviewedPackageLayout {
            ignore_verified_macos_libraries: false,
            classify_linux_programs_by_format: false,
            directories: vec![],
            executables: vec![name.to_owned()],
        };
        let rebuilt = |change: &dyn Fn(&mut crate::PortDefinition)| {
            let mut document = Catalog::embedded().unwrap().authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == port_id)
                .unwrap();
            change(port);
            rebuild(document)
        };
        let baseline = rebuilt(&|port| {
            port.reviewed_package_layouts
                .insert(platform, layout("a.exe"));
        });
        let replaced = rebuilt(&|port| {
            port.reviewed_package_layouts
                .insert(platform, layout("b.exe"));
        });
        validate_definition_transition(&baseline, &replaced, port_id).unwrap();
        let removed = rebuilt(&|port| port.reviewed_package_layouts.clear());
        let error = validate_definition_transition(&baseline, &removed, port_id).unwrap_err();
        assert!(error.message.contains("package layout was removed"));
    }

    #[test]
    fn a_selected_definition_can_narrow_but_not_widen_accepted_release_uploaders() {
        let port_id = "open-nectar-pikmin";
        let uploader = |id: u64| crate::AcceptedUploader {
            id,
            login: format!("reviewed-{id}"),
        };
        let rebuilt = |ids: &[u64]| {
            let mut document = Catalog::embedded().unwrap().authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == port_id)
                .unwrap();
            port.release.accepted_uploaders = ids.iter().copied().map(uploader).collect();
            rebuild(document)
        };
        let baseline = rebuilt(&[7, 8]);
        validate_definition_transition(&baseline, &rebuilt(&[7, 8]), port_id).unwrap();
        validate_definition_transition(&baseline, &rebuilt(&[8]), port_id).unwrap();
        validate_definition_transition(&baseline, &rebuilt(&[]), port_id).unwrap();
        let error =
            validate_definition_transition(&baseline, &rebuilt(&[7, 9]), port_id).unwrap_err();
        assert!(error.message.contains("unreviewed release uploader"));
        let error = validate_definition_transition(&rebuilt(&[]), &baseline, port_id).unwrap_err();
        assert!(error.message.contains("unreviewed release uploader"));
    }

    #[test]
    fn rejects_an_unrelated_port_change() {
        let (baseline, candidate, port_id) = scoped_catalogs();
        let mut document = candidate.authoritative_document();
        document
            .ports
            .iter_mut()
            .find(|port| port.id != port_id)
            .unwrap()
            .summary
            .push_str(" changed");

        let error =
            validate_definition_transition(&baseline, &rebuild(document), &port_id).unwrap_err();
        assert!(error.message.contains("unrelated port changed"));
    }

    #[test]
    fn rejects_an_existing_source_authority_change() {
        let (baseline, candidate, port_id) = scoped_catalogs();
        let mut document = candidate.authoritative_document();
        document.source_catalog.as_mut().unwrap().identities[0]
            .aliases
            .push("scope-escape".to_string());

        let error =
            validate_definition_transition(&baseline, &rebuild(document), &port_id).unwrap_err();
        assert!(error.message.contains("existing source identity changed"));
    }

    #[test]
    fn rejects_unrelated_source_contract_reordering() {
        let (baseline, candidate, port_id) = scoped_catalogs();
        let mut document = candidate.authoritative_document();
        let source = document.source_catalog.as_mut().unwrap();
        let first = source
            .contracts
            .iter()
            .position(|contract| contract.port_id != port_id)
            .unwrap();
        let second = source
            .contracts
            .iter()
            .enumerate()
            .skip(first + 1)
            .find(|(_, contract)| contract.port_id != port_id)
            .map(|(index, _)| index)
            .unwrap();
        source.contracts.swap(first, second);

        let error =
            validate_definition_transition(&baseline, &rebuild(document), &port_id).unwrap_err();
        assert!(error.message.contains("source contract ordering changed"));
    }

    #[test]
    fn rejects_unreachable_new_source_authority() {
        let (baseline, candidate, port_id) = scoped_catalogs();
        let mut document = candidate.authoritative_document();
        let source = document.source_catalog.as_mut().unwrap();
        let mut identity = source.identities.last().unwrap().clone();
        identity.id = "unreachable-source-identity".to_string();
        source.identities.push(identity);

        let error =
            validate_definition_transition(&baseline, &rebuild(document), &port_id).unwrap_err();
        assert!(error.message.contains("new source identity is not owned"));
    }
}
