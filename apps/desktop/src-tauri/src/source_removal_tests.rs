use super::source_removal_consent;
use std::path::Path;

#[test]
fn consent_names_the_location_impact_and_preserved_data() {
    let names = (1..=7)
        .map(|index| format!("Game ü · Port {index}"))
        .collect::<Vec<_>>();
    let text = source_removal_consent(
        Path::new("D:/Original ü/game.iso"),
        "Known game files",
        &names,
    );
    for expected in [
        "D:/Original ü/game.iso",
        "Known game files",
        "7 installed entries",
        "Game ü · Port 1",
        "And 2 more",
        "full affected set",
        "Original files, installations, game saves, backups",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    assert!(!text.contains("Game ü · Port 6"));
    assert!(
        source_removal_consent(Path::new("D:/game.iso"), "Files", &[])
            .contains("No installed entry")
    );
}
