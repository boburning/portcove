//! Read-only shape checks for Ghostship 2.0.0's exact schema-1 reader.
//!
//! The oracle is SaveConversion.h at 762ce4a6dff8d69b934a41a326ae41e78431e6cd.
//! These checks grant neither generated-archive provenance nor transition consent.

use serde_json::{Map, Value};

const COURSES: [&str; 25] = [
    "BOB", "WF", "JRB", "CCM", "BBH", "HMC", "LLL", "SSL", "DDD", "SL", "WDW", "TTM", "THI", "TTC",
    "RR", "BITDW", "BITFS", "BITS", "PSS", "COTMC", "TOTWC", "VCUTM", "WMOTR", "SA", "CG",
];

// Exact list constructed by the pinned Achievements.cpp. Unknown IDs mutate
// upstream's global maps; a short population leaves later-read entries unset.
const ACHIEVEMENTS: [&str; 45] = [
    "Get1Star",
    "Talk25Times",
    "Jump1000Times",
    "Slide20Times",
    "DeathByEnemy",
    "DeathByFalling",
    "DeathByCrushing",
    "DeathByDrowning",
    "DeathByFire",
    "DeathByQuickSand",
    "DeathByBoss",
    "DeathByBowser",
    "DefeatKingBobomb",
    "ReleaseChainChomp",
    "DefeatKingWhomp",
    "Get6MainStars",
    "Get100CoinStar",
    "Get8Stars",
    "DefeatBowser1",
    "UnlockWingCap",
    "DefeatAllBooses",
    "DefeatMrI",
    "UnlockMetalCap",
    "UnlockVanishCap",
    "DefeatAllBigBullies",
    "DefeatEyerok",
    "Get30Stars",
    "Get31Stars",
    "DefeatBowser2",
    "Get50Stars",
    "DefeatWiggler",
    "Get70Stars",
    "DefeatBowser3",
    "WatchEnding",
    "BeatEveryRace",
    "GrabSwimmingStars",
    "GetAllCoinsOneLevel",
    "GetAllStarsInBasement",
    "GetAllStarsInFloor1",
    "GetAllStarsInFloor2",
    "GetAllCourseStars",
    "GetAllCastleStars",
    "Get120Stars",
    "TalkWithYoshi",
    "DefeatBowser3WithAllStars",
];

// LEVEL identifiers from StaticData/Entrances.cpp, not entrance array indexes.
const DESTINATIONS: [i64; 25] = [
    1, 4, 17, 19, 21, 9, 5, 28, 23, 7, 12, 22, 27, 15, 20, 10, 8, 13, 29, 14, 36, 18, 11, 24, 31,
];

type Check<T = ()> = std::result::Result<T, &'static str>;

fn object(value: &Value) -> Check<&Map<String, Value>> {
    value
        .as_object()
        .ok_or("a required save object is missing or malformed")
}

fn member<'a>(value: &'a Map<String, Value>, key: &str) -> Check<&'a Value> {
    value.get(key).ok_or("a required save member is missing")
}

fn integer(value: &Value, minimum: i64, maximum: i64) -> Check {
    if value
        .as_i64()
        .is_some_and(|number| (minimum..=maximum).contains(&number))
    {
        Ok(())
    } else {
        Err("a save integer has an invalid type or is outside its reader range")
    }
}

fn optional_integer(value: &Map<String, Value>, key: &str, minimum: i64, maximum: i64) -> Check {
    value
        .get(key)
        .map_or(Ok(()), |value| integer(value, minimum, maximum))
}

pub(super) fn validate(value: &Value, global: bool) -> Check {
    let root = object(value)?;
    integer(member(root, "version")?, 1, 1)?;
    if global {
        let ages = member(root, "coinScoreAges")?
            .as_array()
            .ok_or("coinScoreAges is not an array")?;
        // The reader consumes four entries. Extra entries are ignored upstream.
        if ages.len() < 4 {
            return Err("coinScoreAges has fewer than four entries");
        }
        for age in &ages[..4] {
            integer(age, 0, u32::MAX.into())?;
        }
        return optional_integer(root, "soundMode", 0, u16::MAX.into());
    }
    let position = object(member(root, "capPos")?)?;
    for axis in ["x", "y", "z"] {
        optional_integer(position, axis, i16::MIN.into(), i16::MAX.into())?;
    }
    for key in ["capLevel", "capArea"] {
        optional_integer(root, key, 0, u8::MAX.into())?;
    }
    // This optional member is read through GetSafeEntry<int>, then assigned u32.
    optional_integer(root, "flags", 0, i32::MAX.into())?;
    for (key, count) in [("courseStars", COURSES.len()), ("courseCoinScores", 15)] {
        let courses = object(member(root, key)?)?;
        for course in &COURSES[..count] {
            integer(member(courses, course)?, 0, u8::MAX.into())?;
        }
    }
    if let Some(ship) = root.get("shipSaveData") {
        validate_ship(object(ship)?)?;
    }
    // Saves.cpp supplies false/false in memory when shipSaveData is absent.
    Ok(())
}

fn validate_ship(ship: &Map<String, Value>) -> Check {
    let features = object(member(ship, "features")?)?;
    for key in ["achievements", "rando"] {
        member(features, key)?
            .as_bool()
            .ok_or("a save feature flag is not a boolean")?;
    }
    if features["achievements"] == true {
        let achievements = object(member(ship, "achievementSaveData")?)?;
        boolean(member(achievements, "cheated")?)?;
        for key in ["capStars", "coins"] {
            integer(member(achievements, key)?, i32::MIN.into(), i32::MAX.into())?;
        }
        let entries = array(member(achievements, "entries")?, ACHIEVEMENTS.len())?;
        let mut seen = std::collections::BTreeSet::new();
        for entry in entries {
            let entry = object(entry)?;
            let id = member(entry, "id")?
                .as_str()
                .ok_or("an achievement ID is not a string")?;
            if !ACHIEVEMENTS.contains(&id) || !seen.insert(id) {
                return Err("achievement IDs do not form the complete reviewed population");
            }
            integer(member(entry, "progress")?, i32::MIN.into(), i32::MAX.into())?;
        }
    }
    if features["rando"] == true {
        let rando = object(member(ship, "randoSaveData")?)?;
        for check in array(member(rando, "randoSaveChecks")?, 364)? {
            let check = object(check)?;
            integer(member(check, "randoItemId")?, 0, 3)?;
            integer(member(check, "randoAct")?, -1, 6)?;
            boolean(member(check, "obtained")?)?;
            boolean(member(check, "skipped")?)?;
        }
        for (index, entrance) in array(member(rando, "randoSaveEntrances")?, DESTINATIONS.len())?
            .iter()
            .enumerate()
        {
            let entrance = object(entrance)?;
            integer(
                member(entrance, "randoEntranceId")?,
                index as i64,
                index as i64,
            )?;
            boolean(member(entrance, "found")?)?;
            let destination = member(entrance, "destinationId")?
                .as_i64()
                .ok_or("a randomizer destination is not an integer")?;
            let allowed = if index == 0 {
                &DESTINATIONS[..1]
            } else {
                &DESTINATIONS[1..]
            };
            if !allowed.contains(&destination) {
                return Err("a randomizer destination is outside the reviewed level mapping");
            }
        }
        for option in array(member(rando, "randoSaveOptions")?, 10)? {
            integer(option, 0, 1)?;
        }
        integer(member(rando, "finalSeed")?, 0, u32::MAX.into())?;
    }
    Ok(())
}

fn boolean(value: &Value) -> Check {
    value
        .as_bool()
        .map(|_| ())
        .ok_or("a required save boolean has an invalid type")
}

fn array(value: &Value, length: usize) -> Check<&[Value]> {
    value
        .as_array()
        .filter(|array| array.len() == length)
        .map(Vec::as_slice)
        .ok_or("a feature array does not have its complete reviewed writer shape")
}

#[cfg(test)]
pub(crate) mod tests {
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
}
