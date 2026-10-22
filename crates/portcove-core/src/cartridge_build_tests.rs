use super::*;

pub(crate) fn fixture_port() -> (PortDefinition, SourceProfile) {
    let port = CartridgeBuildRecipe::YoshisCookieNesCycle110
        .historical_port()
        .unwrap();
    let catalog = crate::Catalog::embedded().unwrap();
    let profile = catalog
        .source_profile(port.source_profile.as_deref().unwrap())
        .unwrap()
        .clone();
    (port, profile)
}

pub(crate) fn fixture_catalog() -> crate::Catalog {
    let (port, profile) = fixture_port();
    crate::Catalog::from_json(
        &serde_json::to_string(&crate::CatalogDocument {
            schema_version: 1,
            source_catalog: None,
            source_profiles: vec![profile],
            ports: vec![port],
        })
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn retained_cartridge_contract_keeps_original_semantics_after_catalog_route_changes() {
    let catalog = fixture_catalog();
    let retained =
        crate::installed_contract::InstalledContract::capture(&catalog, "yoshis-cookie-recomp")
            .unwrap();
    let encoded = serde_json::to_vec(&retained).unwrap();
    let decoded: crate::installed_contract::InstalledContract =
        serde_json::from_slice(&encoded).unwrap();
    let restored = decoded.catalog("yoshis-cookie-recomp").unwrap();
    let port = restored.port("yoshis-cookie-recomp").unwrap();
    assert_eq!(port.launch_arguments, ["game.nes"]);
    assert_eq!(
        port.persistent_paths,
        ["config.ini", "config.ini.tmp", "saves"]
    );
    assert_eq!(
        port.release.managed_build.values().next(),
        Some(&CartridgeBuildRecipe::YoshisCookieNesCycle110)
    );
    assert_eq!(
        serde_json::to_value(restored.authoritative_document()).unwrap(),
        serde_json::to_value(catalog.authoritative_document()).unwrap()
    );
    assert!(
        crate::Catalog::embedded()
            .unwrap()
            .port(&port.id)
            .unwrap()
            .release
            .managed_build
            .is_empty()
    );
}

#[test]
fn retired_indexed_definition_is_interpreted_only_as_retained_state() {
    // Synthetic old-client envelope around frozen pre-reset definition bytes.
    // This exercises reader compatibility and grants no new artifact admission.
    let catalog = fixture_catalog();
    let id = "yoshis-cookie-recomp";
    let bundle = crate::test_fixture::IndexedCatalogFixture::new(&catalog, id).at_revision(7);
    let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
    assert!(
        index
            .inspect_catalog_projection(
                "official",
                id,
                &bundle.contents[0].1,
                &bundle.contents[1].1
            )
            .is_err()
    );
    let projection = index
        .inspect_retained_catalog_projection(
            "official",
            id,
            &bundle.contents[0].1,
            &bundle.contents[1].1,
        )
        .unwrap();
    let retained =
        crate::installed_contract::InstalledContract::capture(projection.catalog(), id).unwrap();
    let encoded = serde_json::to_vec(&retained).unwrap();
    let decoded: crate::installed_contract::InstalledContract =
        serde_json::from_slice(&encoded).unwrap();
    assert_eq!(
        decoded
            .catalog(id)
            .unwrap()
            .port(id)
            .unwrap()
            .launch_arguments,
        ["game.nes"]
    );
}

#[test]
fn known_development_runtime_definitions_remain_lossless_retained_inputs() {
    for recipe in [
        CartridgeBuildRecipe::YoshisCookieNesCycle110,
        CartridgeBuildRecipe::DrMarioNesCycle130Usa,
        CartridgeBuildRecipe::EarthBoundSnesSourceV1,
        CartridgeBuildRecipe::Render96UsSourceV1,
        CartridgeBuildRecipe::GundamWingSnesSourceV1,
        CartridgeBuildRecipe::CvlodSourceV1,
    ] {
        let historical = recipe.historical_port().unwrap();
        let mut document = crate::Catalog::embedded().unwrap().authoritative_document();
        *document
            .ports
            .iter_mut()
            .find(|port| port.id == historical.id)
            .unwrap() = historical.clone();
        let catalog =
            crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let retained =
            crate::installed_contract::InstalledContract::capture(&catalog, &historical.id)
                .unwrap();
        let bytes = serde_json::to_vec(&retained).unwrap();
        let decoded: crate::installed_contract::InstalledContract =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            serde_json::to_value(
                decoded
                    .catalog(&historical.id)
                    .unwrap()
                    .port(&historical.id)
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&historical).unwrap()
        );
    }
}

#[test]
fn historical_runtime_reader_rejects_changed_execution_source_and_ownership() {
    let (port, profile) = fixture_port();
    validate_port(&port, &profile).unwrap();
    for change in 0..7 {
        let mut changed = port.clone();
        match change {
            0 => changed.launch_arguments.push("unchecked".into()),
            1 => changed
                .persistent_paths
                .push("YoshisCookieRecomp.exe".into()),
            2 => changed.executable_hints.clear(),
            3 => changed.release.managed_build.clear(),
            4 => changed.project_url = "https://invalid.example/other".into(),
            5 => changed.source_profile = Some("other-source".into()),
            _ => changed.runtime_mutable_paths.push("game.nes".into()),
        }
        if change != 3 {
            assert!(validate_port(&changed, &profile).is_err(), "{change}");
        }
    }
    let mut changed_source = profile;
    changed_source.accepted_sha1 = vec!["a".repeat(40)];
    assert!(validate_port(&port, &changed_source).is_err());
    assert!(serde_json::from_str::<CartridgeBuildRecipe>("\"unknown-build-v1\"").is_err());
    let retired: CartridgeBuildRecipe =
        serde_json::from_str("\"advance-wars-gba-source-cb3facb53b6b-usa-rev1\"").unwrap();
    assert!(retired.historical_port().is_err());
}

#[test]
fn retained_runtime_environment_guards_do_not_require_compilers() {
    for recipe in [
        CartridgeBuildRecipe::Render96UsSourceV1,
        CartridgeBuildRecipe::GundamWingSnesSourceV1,
        CartridgeBuildRecipe::EarthBoundSnesSourceV1,
        CartridgeBuildRecipe::AdvanceWarsGbaSourceV1,
        CartridgeBuildRecipe::CvlodSourceV1,
    ] {
        assert!(
            recipe
                .require_environment([("sdl_dynamic_api".into(), "other.dll".into())])
                .is_err()
        );
        recipe
            .require_environment([("PATH".into(), "no compiler installed".into())])
            .unwrap();
    }
    for variable in ["LOD_DEBUG", "RECOMP_UI_OVERRIDE"] {
        assert!(
            CartridgeBuildRecipe::CvlodSourceV1
                .require_environment([(variable.into(), "1".into())])
                .is_err()
        );
    }
}
