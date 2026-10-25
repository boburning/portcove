use super::*;
use serde_json::json;

pub(crate) fn vanilla(global: bool) -> Value {
    if global {
        return json!({"version":1,"coinScoreAges":[0,0,0,0],"soundMode":0});
    }
    let stars = COURSES
        .iter()
        .map(|course| ((*course).to_owned(), json!(0)))
        .collect::<Map<_, _>>();
    let coins = COURSES[..15]
        .iter()
        .map(|course| ((*course).to_owned(), json!(0)))
        .collect::<Map<_, _>>();
    json!({"version":1,"capLevel":0,"capArea":0,"capPos":{"x":0,"y":0,"z":0},
        "flags":0,"courseStars":stars,"courseCoinScores":coins,
        "shipSaveData":{"features":{"achievements":false,"rando":false}}})
}

fn with_features() -> Value {
    let mut save = vanilla(false);
    save["shipSaveData"] = json!({
        "features":{"achievements":true,"rando":true},
        "achievementSaveData":{"cheated":false,"capStars":i32::MAX,"coins":0,
            "entries":ACHIEVEMENTS.iter().rev().map(|id| json!({"id":id,"progress":i32::MAX})).collect::<Vec<_>>()},
        "randoSaveData":{
            "randoSaveChecks":vec![json!({"randoItemId":3,"randoAct":-1,"obtained":false,"skipped":true});364],
            "randoSaveEntrances":(0..25).map(|index|json!({"randoEntranceId":index,"destinationId":if index==0 {1} else {36},"found":false})).collect::<Vec<_>>(),
            "randoSaveOptions":[0,1,0,1,0,1,0,1,0,1],"finalSeed":u32::MAX
        }
    });
    save
}

#[test]
fn complete_enabled_features_and_disabled_unparsed_data_are_accepted() {
    validate(&with_features(), false).unwrap();
    let mut save = with_features();
    save["shipSaveData"]["features"] = json!({"achievements":false,"rando":false});
    save["shipSaveData"]["achievementSaveData"] = Value::Null;
    save["shipSaveData"]["randoSaveData"] = json!("ignored by pinned reader");
    validate(&save, false).unwrap();
}

#[test]
fn enabled_features_refuse_incomplete_populations_and_unsafe_values() {
    for length in [44, 46, 101] {
        let mut save = with_features();
        let entries = save["shipSaveData"]["achievementSaveData"]["entries"]
            .as_array_mut()
            .unwrap();
        entries.resize(length, json!({"id":"Get1Star","progress":0}));
        assert!(validate(&save, false).is_err());
    }
    for (pointer, value) in [
        (
            "/shipSaveData/achievementSaveData/entries/0/id",
            json!("not a known achievement"),
        ),
        (
            "/shipSaveData/achievementSaveData/entries/0/id",
            json!("Get1Star"),
        ),
        (
            "/shipSaveData/achievementSaveData/entries/0/progress",
            json!(2147483648_i64),
        ),
        ("/shipSaveData/achievementSaveData/cheated", json!(1)),
        (
            "/shipSaveData/achievementSaveData/capStars",
            json!(-2147483649_i64),
        ),
        ("/shipSaveData/achievementSaveData/coins", json!(1.25)),
        (
            "/shipSaveData/randoSaveData/randoSaveChecks/0/randoItemId",
            json!(4),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveChecks/0/randoAct",
            json!(7),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveChecks/1/randoAct",
            json!(-2),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveChecks/0/obtained",
            json!(0),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveChecks/0/skipped",
            Value::Null,
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveEntrances/0/destinationId",
            json!(36),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/destinationId",
            json!(1),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/destinationId",
            json!(6),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/randoEntranceId",
            json!(24),
        ),
        (
            "/shipSaveData/randoSaveData/randoSaveEntrances/1/found",
            json!("false"),
        ),
        ("/shipSaveData/randoSaveData/randoSaveOptions/9", json!(2)),
        (
            "/shipSaveData/randoSaveData/finalSeed",
            json!(4294967296_i64),
        ),
    ] {
        let mut save = with_features();
        *save.pointer_mut(pointer).unwrap() = value;
        assert!(validate(&save, false).is_err(), "{pointer}");
    }
    for key in ["randoSaveChecks", "randoSaveEntrances", "randoSaveOptions"] {
        for extend in [false, true] {
            let mut save = with_features();
            let array = save["shipSaveData"]["randoSaveData"][key]
                .as_array_mut()
                .unwrap();
            if extend {
                array.push(array[0].clone());
            } else {
                array.pop();
            }
            assert!(validate(&save, false).is_err(), "{key}");
        }
    }
}

#[test]
fn vanilla_writer_shapes_and_reader_defaults_are_accepted() {
    for global in [false, true] {
        validate(&vanilla(global), global).unwrap();
    }
    let mut save = vanilla(false);
    let root = save.as_object_mut().unwrap();
    for key in ["capLevel", "capArea", "flags", "shipSaveData"] {
        root.remove(key);
    }
    root.insert("capPos".into(), json!({}));
    validate(&save, false).unwrap();
    let mut global = vanilla(true);
    global.as_object_mut().unwrap().remove("soundMode");
    global["coinScoreAges"]
        .as_array_mut()
        .unwrap()
        .push(json!("ignored upstream"));
    validate(&global, true).unwrap();
}

#[test]
fn required_nested_members_are_checked_independently() {
    assert!(validate(&json!({"version":1}), false).is_err());
    assert!(validate(&json!({"version":1}), true).is_err());
    for (key, courses) in [
        ("courseStars", &COURSES[..]),
        ("courseCoinScores", &COURSES[..15]),
    ] {
        for course in courses {
            let mut save = vanilla(false);
            save[key].as_object_mut().unwrap().remove(*course);
            assert!(validate(&save, false).is_err(), "{key}/{course}");
        }
    }
    for key in ["capPos", "courseStars", "courseCoinScores", "shipSaveData"] {
        let mut save = vanilla(false);
        save[key] = Value::Null;
        assert!(validate(&save, false).is_err(), "{key}");
    }
    for key in ["achievements", "rando"] {
        let mut save = vanilla(false);
        save["shipSaveData"]["features"]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(validate(&save, false).is_err());
    }
}

#[test]
fn integer_destinations_refuse_types_and_narrowing() {
    for (pointer, low, high) in [
        ("/version", 1, 1),
        ("/capLevel", 0, 255),
        ("/capArea", 0, 255),
        ("/capPos/x", -32768, 32767),
        ("/capPos/y", -32768, 32767),
        ("/capPos/z", -32768, 32767),
        ("/flags", 0, i64::from(i32::MAX)),
        ("/courseStars/BOB", 0, 255),
        ("/courseCoinScores/RR", 0, 255),
    ] {
        for invalid in [
            json!(low - 1),
            json!(high + 1),
            json!(1.5),
            json!(true),
            json!("1"),
            Value::Null,
        ] {
            let mut save = vanilla(false);
            *save.pointer_mut(pointer).unwrap() = invalid;
            assert!(validate(&save, false).is_err(), "{pointer}");
        }
        for valid in [low, high] {
            let mut save = vanilla(false);
            *save.pointer_mut(pointer).unwrap() = json!(valid);
            validate(&save, false).unwrap();
        }
    }
    for invalid in [
        json!([]),
        json!([0, 0, 0]),
        json!([0, -1, 0, 0]),
        json!([0, 4294967296_i64, 0, 0]),
        json!([0, true, 0, 0]),
    ] {
        let mut save = vanilla(true);
        save["coinScoreAges"] = invalid;
        assert!(validate(&save, true).is_err());
    }
    for invalid in [json!(-1), json!(65536), json!("0"), json!(false)] {
        let mut save = vanilla(true);
        save["soundMode"] = invalid;
        assert!(validate(&save, true).is_err());
    }
}
