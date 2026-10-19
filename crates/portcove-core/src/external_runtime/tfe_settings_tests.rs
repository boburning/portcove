use super::*;
const VALID: &str = "[Game]\ngame=\"Dark Forces\"\n[Dark_Forces]\nsourcePath=\"GameData/\"\n";

#[test]
fn bounded_reader_refuses_nul_and_oversized_settings() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("settings.ini");
    for bytes in [
        format!("{VALID}\0").into_bytes(),
        vec![b' '; MAX_BYTES as usize + 1],
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert!(check(&File::open(&path).unwrap()).is_err());
    }
    std::fs::write(&path, VALID).unwrap();
    check(&File::open(path).unwrap()).unwrap();
}

#[test]
fn cvar_value_obeys_the_smaller_upstream_buffer() {
    parse(format!("{VALID}[CVar]\nx=\"{}\"\n", "a".repeat(255)).as_bytes()).unwrap();
    assert!(parse(format!("{VALID}[CVar]\nx=\"{}\"\n", "a".repeat(256)).as_bytes()).is_err());
    for value in ["string x", "STRING   x"] {
        assert!(parse(format!("{VALID}[CVar]\nx=\"{value}\"\n").as_bytes()).is_err());
    }
    for value in ["string", "string xx", "STRING   xx"] {
        parse(format!("{VALID}[CVar]\nx=\"{value}\"\n").as_bytes()).unwrap();
    }
}

#[test]
fn pinned_selection_allows_ordinary_preferences() {
    parse(format!("{VALID}[Window]\nwidth=1280\n[game]\n# player comment\n").as_bytes()).unwrap();
    parse(
        VALID
            .replace("[Game]", "[GAME]")
            .replace("game=", "GAME=")
            .as_bytes(),
    )
    .unwrap();
}

#[test]
fn refuses_redirects_ambiguity_and_parser_edge_cases() {
    for invalid in [
        VALID.replace("GameData/", "C:/Games/"),
        VALID.replace("GameData/", "../GameData/"),
        VALID.replace("GameData/", "GameData\\"),
        VALID.replace("Dark Forces", "Outlaws"),
        VALID.replace("[Game]", "xGamex"),
        VALID.replace("GameData/\"", "GameData/#\""),
        VALID.replace("sourcePath=", "sourcePath=\"\""),
        VALID.replace("game=", "game,extra="),
        VALID.replace("GameData/\"", "GameData/"),
        format!("{VALID}[Game]\ngame=\"Dark Forces\""),
        format!("{VALID}{}", "a".repeat(4096)),
        format!("{VALID}[Other]\nkey={}", "a".repeat(1024)),
    ] {
        assert!(parse(invalid.as_bytes()).is_err(), "{invalid:?}");
    }
}

#[test]
fn matches_empty_quote_and_ignored_extra_token_behavior() {
    assert_eq!(
        tokens(b"key=\"\"value").unwrap(),
        vec![b"key".to_vec(), vec![], b"value".to_vec()]
    );
    assert_eq!(
        tokens(b"key = \"value with spaces\" ; comment").unwrap(),
        vec![b"key".to_vec(), b"value with spaces".to_vec()]
    );
    assert!(tokens(b"key=\"value#comment\"").is_err());
    parse(format!("{VALID}sourcePath=elsewhere,ignored").as_bytes()).unwrap();
}
