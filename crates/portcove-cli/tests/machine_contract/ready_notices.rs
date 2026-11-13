//! Compiled CLI coverage for turning ready notices off and on (#965).

use super::*;

#[test]
fn ready_notices_are_on_by_default_and_can_be_turned_off_and_on() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let library = root.join("library");
    let preferences = root.join("preferences.json");
    let run = |args: &[&str]| portcove_tool(&preferences, &library, args);

    let initial = run(&["--json", "games", "notices"]);
    assert!(initial.status.success(), "{initial:?}");
    assert_eq!(json_stdout(&initial)["data"]["ready_notices_enabled"], true);

    let off = run(&["--json", "games", "notices", "off"]);
    assert!(off.status.success(), "{off:?}");
    assert_eq!(json_stdout(&off)["data"]["ready_notices_enabled"], false);

    // The setting is durable: a new process reads it, and reassessment reports it.
    let again = run(&["--json", "games", "notices"]);
    assert_eq!(json_stdout(&again)["data"]["ready_notices_enabled"], false);
    let intents = run(&["--json", "games", "intents"]);
    assert!(intents.status.success(), "{intents:?}");
    assert_eq!(
        json_stdout(&intents)["data"]["ready_notices_enabled"],
        false
    );

    let human = run(&["games", "notices"]);
    let text = String::from_utf8_lossy(&human.stdout);
    assert!(text.contains("Ready notices are off"), "{text}");
    assert!(text.contains("portcove games notices on"), "{text}");

    let on = run(&["--json", "games", "notices", "on"]);
    assert_eq!(json_stdout(&on)["data"]["ready_notices_enabled"], true);
}
