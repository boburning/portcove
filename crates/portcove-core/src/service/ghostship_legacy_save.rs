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
#[path = "ghostship_legacy_save_tests.rs"]
pub(crate) mod tests;
