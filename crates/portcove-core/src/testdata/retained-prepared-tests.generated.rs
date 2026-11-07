// Retained prepared tests are generated from independent fixture enrollment.
fn retained_prepared_definition(id: &str) -> Option<&'static str> {
    match id {
        "elasota-aerofoil" => Some(include_str!("aerofoil-retained-selected-2026-11-07.json")),
        "blake-stone-aliens-of-gold-bstone" => {
            Some(include_str!("bstone-retained-selected-2026-10-29.json"))
        }
        "blake-stone-planet-strike-bstone" => {
            Some(include_str!("bstone-retained-selected-2026-10-29.json"))
        }
        "final-doom-crispy-doom-family" => {
            Some(include_str!("crispy-final-doom-retained-selected-2026-10-29.json"))
        }
        "doom-ii-crispy-doom-family" => {
            Some(include_str!("crispy-retained-selected-2026-10-29.json"))
        }
        "doom-the-ultimate-doom-crispy-doom-family" => {
            Some(include_str!("crispy-retained-selected-2026-10-29.json"))
        }
        "heretic-crispy-doom-family" => {
            Some(include_str!("crispy-retained-selected-2026-10-29.json"))
        }
        "hexen-crispy-doom-family" => {
            Some(include_str!("crispy-retained-selected-2026-10-29.json"))
        }
        "strife-crispy-doom-family" => {
            Some(include_str!("crispy-retained-selected-2026-10-29.json"))
        }
        "diablo-devilutionx" => Some(include_str!("devilution-retained-selected-2026-10-29.json")),
        "diablo-hellfire-devilutionx" => {
            Some(include_str!("devilution-retained-selected-2026-10-29.json"))
        }
        "pokemon-firered-fireredleafgreenrecomp" => {
            Some(include_str!("gba-pokemon-retained-selected-2026-11-05.json"))
        }
        "pokemon-leafgreen-fireredleafgreenrecomp" => {
            Some(include_str!("gba-pokemon-retained-selected-2026-11-05.json"))
        }
        "pokemon-ruby-rubysapphirerecomp" => {
            Some(include_str!("gba-ruby-sapphire-retained-selected-2026-11-06.json"))
        }
        "pokemon-sapphire-rubysapphirerecomp" => {
            Some(include_str!("gba-ruby-sapphire-retained-selected-2026-11-06.json"))
        }
        "doom-3-classic-dhewm3" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "doom-3-classic-dude-doom-3-unified-development-engine" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "doom-3-resurrection-of-evil-classic-dhewm3" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "medal-of-honor-allied-assault-breakthrough-openmohaa" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "medal-of-honor-allied-assault-openmohaa" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "medal-of-honor-allied-assault-spearhead-openmohaa" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo" => {
            Some(include_str!("native-engine-retained-selected-2026-11-02.json"))
        }
        "bio-menace-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "catacomb-3-d-the-descent-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "keen-dreams-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "spear-of-destiny-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "super-3-d-noah-s-ark-dos-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "the-catacomb-abyss-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "the-catacomb-apocalypse-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "the-catacomb-armageddon-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        "wolfenstein-3d-reflectionhle" => {
            Some(include_str!("reflectionhle-retained-selected-2026-10-28.json"))
        }
        _ => None,
    }
}

#[test]
fn classic_pc_route_1790() {
    assert_prepared_player_route("elasota-aerofoil", None);
}

#[test]
fn desktop_prepared_route_2555() {
    assert_prepared_player_route("blake-stone-aliens-of-gold-bstone", None);
}

#[test]
fn desktop_prepared_route_2556() {
    assert_prepared_player_route("blake-stone-planet-strike-bstone", None);
}

#[test]
fn desktop_prepared_route_2656() {
    assert_prepared_player_route("final-doom-crispy-doom-family", None);
}

#[test]
fn desktop_prepared_route_2655() {
    assert_prepared_player_route("doom-ii-crispy-doom-family", None);
}

#[test]
fn desktop_prepared_route_2654() {
    assert_prepared_player_route("doom-the-ultimate-doom-crispy-doom-family", None);
}

#[test]
fn desktop_prepared_route_2657() {
    assert_prepared_player_route("heretic-crispy-doom-family", None);
}

#[test]
fn desktop_prepared_route_2662() {
    assert_prepared_player_route("hexen-crispy-doom-family", None);
}

#[test]
fn desktop_prepared_route_2663() {
    assert_prepared_player_route("strife-crispy-doom-family", None);
}

#[test]
fn desktop_prepared_route_2563() {
    assert_prepared_player_route("diablo-devilutionx", None);
}

#[test]
fn desktop_prepared_route_2564() {
    assert_prepared_player_route("diablo-hellfire-devilutionx", None);
}

#[test]
fn historical_route_firered() {
    assert_prepared_player_route("pokemon-firered-fireredleafgreenrecomp", None);
}

#[test]
fn historical_route_leafgreen() {
    assert_prepared_player_route("pokemon-leafgreen-fireredleafgreenrecomp", None);
}

#[test]
fn historical_route_ruby() {
    assert_prepared_player_route("pokemon-ruby-rubysapphirerecomp", None);
}

#[test]
fn historical_route_sapphire() {
    assert_prepared_player_route("pokemon-sapphire-rubysapphirerecomp", None);
}

#[test]
fn desktop_prepared_route_2567() {
    assert_prepared_player_route("doom-3-classic-dhewm3", None);
}

#[test]
fn native_engine_route_2565() {
    assert_prepared_player_route("doom-3-classic-dude-doom-3-unified-development-engine", None);
}

#[test]
fn desktop_prepared_route_2568() {
    assert_prepared_player_route("doom-3-resurrection-of-evil-classic-dhewm3", None);
}

#[test]
fn native_engine_route_2566() {
    assert_prepared_player_route("doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine", None);
}

#[test]
fn native_engine_route_2594() {
    assert_prepared_player_route("medal-of-honor-allied-assault-breakthrough-openmohaa", None);
}

#[test]
fn native_engine_route_2592() {
    assert_prepared_player_route("medal-of-honor-allied-assault-openmohaa", None);
}

#[test]
fn native_engine_route_2593() {
    assert_prepared_player_route("medal-of-honor-allied-assault-spearhead-openmohaa", None);
}

#[test]
fn native_engine_route_2611() {
    assert_prepared_player_route("star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo", None);
}

#[test]
fn native_engine_route_2612() {
    assert_prepared_player_route("star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo", None);
}

#[test]
fn desktop_prepared_route_2692() {
    assert_prepared_player_route("bio-menace-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2684() {
    assert_prepared_player_route("catacomb-3-d-the-descent-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2683() {
    assert_prepared_player_route("keen-dreams-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2689() {
    assert_prepared_player_route("spear-of-destiny-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2690() {
    assert_prepared_player_route("super-3-d-noah-s-ark-dos-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2685() {
    assert_prepared_player_route("the-catacomb-abyss-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2687() {
    assert_prepared_player_route("the-catacomb-apocalypse-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2686() {
    assert_prepared_player_route("the-catacomb-armageddon-reflectionhle", None);
}

#[test]
fn desktop_prepared_route_2688() {
    assert_prepared_player_route("wolfenstein-3d-reflectionhle", None);
}
