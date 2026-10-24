//! Synthetic string-only cases: no filesystem access or installation fixtures.
use std::path::Path;

use proptest::{
    prelude::*,
    test_runner::{FileFailurePersistence, RngAlgorithm, RngSeed},
};

fn mixed_case(text: &str, mask: u32) -> String {
    text.chars()
        .enumerate()
        .map(|(index, character)| {
            if mask & (1 << (index % 32)) == 0 {
                character.to_ascii_lowercase()
            } else {
                character.to_ascii_uppercase()
            }
        })
        .collect()
}

fn surrounding_components() -> impl Strategy<Value = Vec<String>> {
    prop::collection::vec(
        prop_oneof![
            "piece_[A-Za-z0-9_-]{0,12}",
            Just("雪".to_owned()),
            Just("café".to_owned()),
        ],
        0..6,
    )
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 64,
        max_shrink_iters: 4096,
        failure_persistence: Some(Box::new(FileFailurePersistence::SourceParallel("proptest-regressions"))),
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(242046),
        ..ProptestConfig::default()
    })]

    #[test]
    fn metadata_component_is_reserved_at_every_generated_position(
        before in surrounding_components(),
        after in surrounding_components(),
        slug in "[A-Za-z0-9_-]{0,12}",
        source_suffix in any::<bool>(),
        case_mask in any::<u32>(),
        separator in prop::sample::select(vec!["/", "\\"]),
    ) {
        let marker = if source_suffix {
            format!("{slug}.portcove-source.json")
        } else {
            format!(".portcove-{slug}")
        };
        let components = before.into_iter()
            .chain([mixed_case(&marker, case_mask)])
            .chain(after)
            .collect::<Vec<_>>();
        prop_assert!(super::is_portcove_metadata(Path::new(&components.join(separator))));
    }

    #[test]
    fn similar_names_do_not_reserve_unrelated_player_files(
        before in surrounding_components(),
        after in surrounding_components(),
        name in prop::sample::select(vec![
            ".portcove", "portcove-cache", "item.portcove-source.json.backup",
            "item.portcove_source.json", ".other-portcove-cache", "portcove-source.json",
        ]),
        case_mask in any::<u32>(),
        separator in prop::sample::select(vec!["/", "\\"]),
    ) {
        let components = before.into_iter()
            .chain([mixed_case(name, case_mask)])
            .chain(after)
            .collect::<Vec<_>>();
        prop_assert!(!super::is_portcove_metadata(Path::new(&components.join(separator))));
    }

    #[test]
    fn removing_the_reserved_component_restores_an_ordinary_path(
        before in surrounding_components(),
        after in surrounding_components(),
        separator in prop::sample::select(vec!["/", "\\"]),
    ) {
        let mut components = before;
        let position = components.len();
        components.push(".portcove-state".to_owned());
        components.extend(after);
        prop_assert!(super::is_portcove_metadata(Path::new(&components.join(separator))));
        components.remove(position);
        prop_assert!(!super::is_portcove_metadata(Path::new(&components.join(separator))));
    }
}
