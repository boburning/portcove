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
        return Err(out_of_scope("catalog schema changed"));
    }

    let baseline_ports = values_by_id(&baseline.ports, |port| &port.id)?;
    let candidate_ports = values_by_id(&candidate.ports, |port| &port.id)?;
    if !candidate_ports.contains_key(selected_port_id) {
        return Err(out_of_scope("selected port is missing"));
    }
    for (id, value) in &baseline_ports {
        if *id != selected_port_id && candidate_ports.get(id) != Some(value) {
            return Err(out_of_scope("an unrelated port changed or was removed"));
        }
    }
    if candidate_ports
        .keys()
        .any(|id| !baseline_ports.contains_key(id) && *id != selected_port_id)
    {
        return Err(out_of_scope("more than the selected port was added"));
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
        return Err(out_of_scope("unrelated port ordering changed"));
    }

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

    require_existing_records(&baseline_evidence, &candidate_evidence, "source evidence")?;
    require_existing_records(
        &baseline_identities,
        &candidate_identities,
        "source identity",
    )?;
    require_existing_records(
        &baseline_validators,
        &candidate_validators,
        "source validator",
    )?;
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
            return Err(out_of_scope(
                "an unrelated source contract changed or was removed",
            ));
        }
    }
    for contract in &candidate.contracts {
        let unchanged = baseline_contracts.get(contract.id.as_str())
            == candidate_contracts.get(contract.id.as_str());
        if !unchanged && contract.port_id != selected_port_id {
            return Err(out_of_scope("a changed source contract is not selected"));
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
        return Err(out_of_scope("unrelated source qualification changed"));
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

    fn rebuild(document: crate::CatalogDocument) -> Catalog {
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
    }

    #[test]
    fn accepts_a_scoped_post_client_definition() {
        let baseline = Catalog::embedded().unwrap();
        let (candidate, port_id) = post_client_catalog();

        validate_definition_transition(&baseline, &candidate, &port_id).unwrap();
    }

    #[test]
    fn rejects_an_unrelated_port_change() {
        let baseline = Catalog::embedded().unwrap();
        let (candidate, port_id) = post_client_catalog();
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
        let baseline = Catalog::embedded().unwrap();
        let (candidate, port_id) = post_client_catalog();
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
        let baseline = Catalog::embedded().unwrap();
        let (candidate, port_id) = post_client_catalog();
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
        let baseline = Catalog::embedded().unwrap();
        let (candidate, port_id) = post_client_catalog();
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
