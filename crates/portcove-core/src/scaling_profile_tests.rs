//! Reproducible scaling profile of the complete workspace acquisition path.
//!
//! The fixtures duplicate the embedded catalog deterministically with fresh
//! identities (`<id>-xscale<k>`) and register synthetic managed installation
//! rows. They are validation scenarios, never product limits: a size that a
//! product bound refuses is reported as that refusal, not hidden.
//!
//! Run (prints a Markdown table; `PORTCOVE_SCALING_FACTORS=1,5` narrows it):
//!
//! ```text
//! cargo nextest run -p portcove-core --lib --run-ignored only \
//!   -E 'test(scaling_profile::)' --no-capture
//! ```

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{
    ArtifactIdentity, Catalog, CatalogDocument, CatalogListingDocument, InstallRecord, Library,
    PortcoveService, ReleaseChannel,
};

thread_local! {
    static EMBEDDED_OVERRIDE: RefCell<Option<Catalog>> = const { RefCell::new(None) };
    static PORT_LOOKUPS: Cell<u64> = const { Cell::new(0) };
    static LISTING_LOOKUPS: Cell<u64> = const { Cell::new(0) };
}

/// The embedded catalog replacement installed by a profile on this thread.
pub(crate) fn embedded_override() -> Option<Catalog> {
    EMBEDDED_OVERRIDE.with(|slot| slot.borrow().clone())
}

#[derive(Clone, Copy)]
pub(crate) enum Lookup {
    Port,
    Listing,
}

pub(crate) fn count_lookup(lookup: Lookup) {
    let counter = match lookup {
        Lookup::Port => &PORT_LOOKUPS,
        Lookup::Listing => &LISTING_LOOKUPS,
    };
    counter.with(|count| count.set(count.get() + 1));
}

fn take_lookups() -> (u64, u64) {
    (
        PORT_LOOKUPS.with(|count| count.replace(0)),
        LISTING_LOOKUPS.with(|count| count.replace(0)),
    )
}

/// Restores the real embedded catalog when the profile ends or panics.
struct OverrideGuard;

impl OverrideGuard {
    fn install(catalog: Catalog) -> Self {
        EMBEDDED_OVERRIDE.with(|slot| *slot.borrow_mut() = Some(catalog));
        Self
    }
}

impl Drop for OverrideGuard {
    fn drop(&mut self) {
        EMBEDDED_OVERRIDE.with(|slot| *slot.borrow_mut() = None);
    }
}

fn rename(value: &mut Value, ids: &HashSet<String>, suffix: &str) {
    match value {
        Value::String(text) if ids.contains(text.as_str()) => text.push_str(suffix),
        Value::Array(items) => items.iter_mut().for_each(|item| rename(item, ids, suffix)),
        Value::Object(map) => {
            let renamed = std::mem::take(map)
                .into_iter()
                .map(|(key, mut item)| {
                    rename(&mut item, ids, suffix);
                    let key = if ids.contains(key.as_str()) {
                        format!("{key}{suffix}")
                    } else {
                        key
                    };
                    (key, item)
                })
                .collect();
            *map = renamed;
        }
        _ => {}
    }
}

/// Top-level source-catalog records (identities, contracts, evidence, ...)
/// carry the identities other records reference.
fn collect_ids(source_catalog: &Value, ids: &mut HashSet<String>) {
    let Value::Object(map) = source_catalog else {
        return;
    };
    for records in map.values().filter_map(Value::as_array) {
        for record in records {
            if let Some(Value::String(id)) = record.get("id") {
                ids.insert(id.clone());
            }
        }
    }
}

fn contains_string(value: &Value, wanted: &HashSet<String>) -> bool {
    match value {
        Value::String(text) => wanted.contains(text.as_str()),
        Value::Array(items) => items.iter().any(|item| contains_string(item, wanted)),
        Value::Object(map) => map.values().any(|item| contains_string(item, wanted)),
        _ => false,
    }
}

/// Deterministically duplicate the embedded operational and listing documents.
/// Copy zero is the real catalog; copy `k` renames every port, listing and
/// source-catalog identity with `-xscale<k>`, keeping each copy self-consistent.
/// Definitions whose validation is pinned to their exact real identity (for
/// example a route reserved for one named project) are not duplicated; their
/// renamed listings remain as listing-only directory entries.
pub(crate) fn scaled_documents(factor: usize) -> (CatalogDocument, CatalogListingDocument) {
    scaled_documents_excluding(factor, identity_pinned_ports())
}

pub(crate) fn scaled_documents_excluding(
    factor: usize,
    pinned: &HashSet<String>,
) -> (CatalogDocument, CatalogListingDocument) {
    let embedded = Catalog::embedded().unwrap();
    let mut document = serde_json::to_value(embedded.authoritative_document()).unwrap();
    let listings = serde_json::to_value(embedded.listing_document()).unwrap();
    let mut ids = HashSet::new();
    for port in embedded.ports() {
        ids.insert(port.id.clone());
    }
    for listing in embedded.listings() {
        ids.insert(listing.id.clone());
    }
    if let Some(source_catalog) = document.get("source_catalog") {
        collect_ids(source_catalog, &mut ids);
    }
    let base_document = document.clone();
    let mut scaled_listings = listings.clone();
    for copy in 1..factor {
        let suffix = format!("-xscale{copy}");
        let dropped = pinned
            .iter()
            .map(|id| format!("{id}{suffix}"))
            .collect::<HashSet<_>>();
        let mut next = base_document.clone();
        rename(&mut next, &ids, &suffix);
        let ports = next["ports"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|port| !dropped.contains(port["id"].as_str().unwrap()))
            .cloned()
            .collect::<Vec<_>>();
        document["ports"].as_array_mut().unwrap().extend(ports);
        if let Some(Value::Object(source_catalog)) = next.get("source_catalog").cloned() {
            for (key, items) in source_catalog {
                if let (Value::Array(items), Some(Value::Array(target))) =
                    (items, document["source_catalog"].get_mut(&key))
                {
                    target.extend(
                        items
                            .into_iter()
                            .filter(|record| !contains_string(record, &dropped)),
                    );
                }
            }
        }
        let mut next = listings.clone();
        rename(&mut next, &ids, &suffix);
        let entries = next["listings"].as_array().unwrap().clone();
        scaled_listings["listings"]
            .as_array_mut()
            .unwrap()
            .extend(entries);
    }
    (
        serde_json::from_value(document).unwrap(),
        serde_json::from_value(scaled_listings).unwrap(),
    )
}

/// Find, by bisection over one renamed copy, the real definitions whose
/// validation only accepts their exact identity. Computed once per process.
fn identity_pinned_ports() -> &'static HashSet<String> {
    static PINNED: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    PINNED.get_or_init(|| {
        let embedded = Catalog::embedded().unwrap();
        let all = embedded
            .ports()
            .iter()
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        // A candidate set is accepted when a copy of exactly those definitions validates.
        let accepts = |kept: &[String]| {
            let pinned = all
                .iter()
                .filter(|id| !kept.contains(id))
                .cloned()
                .collect::<HashSet<_>>();
            let (document, listings) = scaled_documents_excluding(2, &pinned);
            validated_catalog(document, listings).is_ok()
        };
        fn bisect(
            candidates: &[String],
            accepts: &dyn Fn(&[String]) -> bool,
            pinned: &mut HashSet<String>,
        ) {
            if candidates.is_empty() || accepts(candidates) {
                return;
            }
            if let [single] = candidates {
                pinned.insert(single.clone());
                return;
            }
            let (left, right) = candidates.split_at(candidates.len() / 2);
            bisect(left, accepts, pinned);
            bisect(right, accepts, pinned);
        }
        let mut pinned = HashSet::new();
        bisect(&all, &accepts, &mut pinned);
        let kept = all
            .iter()
            .filter(|id| !pinned.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        assert!(
            accepts(&kept),
            "pinned definitions interact; refine the fixture"
        );
        // Pinned routes are exceptions; most definitions must duplicate.
        assert!(pinned.len() * 10 < all.len(), "{pinned:?}");
        pinned
    })
}

pub(crate) fn validated_catalog(
    document: CatalogDocument,
    listings: CatalogListingDocument,
) -> crate::Result<Catalog> {
    Catalog::from_document(document)?.with_listing_document(listings)
}

/// One active installation per managed definition, then retained inactive
/// installation rows round-robin until `count` rows exist.
fn register_installs(library: &Library, catalog: &Catalog, count: usize) -> usize {
    let managed = catalog
        .ports()
        .iter()
        .filter(|port| port.release.provider != crate::ReleaseSource::UserPrepared)
        .collect::<Vec<_>>();
    let mut registered = 0;
    let mut attempts = 0;
    while registered < count && attempts < count * 2 && !managed.is_empty() {
        let port = managed[attempts % managed.len()];
        let activate = attempts < managed.len();
        attempts += 1;
        let id = format!("profile-install-{registered}");
        let path = library.versions_dir().join(&port.id).join(&id);
        std::fs::create_dir_all(&path).unwrap();
        let install = InstallRecord {
            id,
            port_id: port.id.clone(),
            version: format!("1.0.{registered}"),
            path,
            channel: ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact: ArtifactIdentity {
                asset_name: "profile.zip".into(),
                sha256: format!("{registered:064x}"),
                size: 1,
            },
            manifest_sha256: "a".repeat(64),
            selected_executable: "profile.exe".into(),
            runtime: None,
        };
        if library.register_install(&install, activate).is_ok() {
            registered += 1;
        }
    }
    registered
}

/// Linux process accounting: reset the peak resident set size (VmHWM).
#[cfg(target_os = "linux")]
fn peak_reset() {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
}

#[cfg(not(target_os = "linux"))]
fn peak_reset() {}

#[cfg(target_os = "linux")]
fn status_kib(field: &str) -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
}

/// Memory is unreported where the process status is unavailable.
#[cfg(not(target_os = "linux"))]
fn status_kib(_: &str) -> Option<u64> {
    None
}

fn peak_kib() -> Option<u64> {
    status_kib("VmHWM:")
}

fn rss_kib() -> Option<u64> {
    status_kib("VmRSS:")
}

struct Stage {
    name: &'static str,
    samples: Vec<Duration>,
    peak_delta_kib: u64,
    lookups: (u64, u64),
    bytes: Option<usize>,
    note: String,
}

fn measure<T>(
    name: &'static str,
    iterations: usize,
    mut run: impl FnMut() -> T,
) -> (Stage, Option<T>) {
    let mut samples = Vec::with_capacity(iterations);
    let mut peak_delta_kib = 0;
    let mut lookups = (0, 0);
    let mut last = None;
    for iteration in 0..iterations {
        drop(last.take());
        peak_reset();
        let baseline = rss_kib().unwrap_or(0);
        take_lookups();
        let started = Instant::now();
        let value = run();
        samples.push(started.elapsed());
        let counted = take_lookups();
        if iteration == 0 {
            lookups = counted;
        }
        peak_delta_kib = peak_delta_kib.max(peak_kib().unwrap_or(0).saturating_sub(baseline));
        last = Some(value);
    }
    samples.sort();
    (
        Stage {
            name,
            samples,
            peak_delta_kib,
            lookups,
            bytes: None,
            note: String::new(),
        },
        last,
    )
}

fn percentile(samples: &[Duration], percentile: usize) -> Duration {
    let index = (samples.len() * percentile).div_ceil(100).saturating_sub(1);
    samples[index.min(samples.len() - 1)]
}

fn milliseconds(duration: Duration) -> String {
    format!("{:.1}", duration.as_secs_f64() * 1000.0)
}

fn sha256_json(value: &impl serde::Serialize) -> (String, usize) {
    use sha2::{Digest, Sha256};
    struct Writer(Sha256, usize);
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            self.1 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer(Sha256::new(), 0);
    serde_json::to_writer(&mut writer, value).unwrap();
    (hex::encode(writer.0.finalize()), writer.1)
}

fn profile(factor: usize, installs: usize, iterations: usize) -> Vec<Stage> {
    let (document, listings) = scaled_documents(factor);
    let port_count = document.ports.len();
    let listing_count = listings.listings.len();
    let mut stages = Vec::new();
    let (mut stage, catalog) = measure("catalog load and validation", iterations, || {
        validated_catalog(document.clone(), listings.clone())
    });
    let catalog = match catalog {
        Some(Ok(catalog)) => catalog,
        Some(Err(error)) => {
            stage.note = format!("REFUSED: {}", error.message);
            stages.push(stage);
            return stages;
        }
        None => unreachable!(),
    };
    stage.note = format!("{port_count} definitions, {listing_count} listings");
    stages.push(stage);
    let _guard = OverrideGuard::install(catalog.clone());
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let registered = register_installs(&library, &catalog, installs);
    let service = PortcoveService::new(library.clone()).unwrap();

    let (stage, _) = measure("effective catalog resolution", iterations, || {
        library.load_catalog().unwrap()
    });
    stages.push(stage);
    let (mut stage, _) = measure("listing projection (registered)", iterations, || {
        catalog
            .clone()
            .with_projected_listing_document(catalog.listing_document().clone())
            .unwrap()
    });
    stage.note = "with_projected_listing_document on every workspace read".into();
    stages.push(stage);
    let (mut stage, statuses) = measure("status + eligibility hydration", iterations, || {
        service.statuses().unwrap()
    });
    stage.note = format!("{registered} installation rows registered");
    stages.push(stage);
    let statuses = statuses.unwrap();
    let sources = Vec::new();
    let (mut stage, browsing) = measure("browsing contexts", iterations, || {
        service
            .browsing_contexts_for_workspace(&catalog, &statuses, &sources)
            .unwrap()
    });
    // The inputs `browsing_context::projection_fits` charges before projecting.
    let binding_bytes = serde_json::to_vec(&(
        catalog.document(),
        &statuses,
        &sources,
        library.identity_record().unwrap(),
    ))
    .unwrap()
    .len();
    let declared_contexts = catalog
        .ports()
        .iter()
        .map(|port| port.platforms.len() * port.channels.len())
        .sum::<usize>()
        + registered.min(catalog.ports().len());
    let budget = format!(
        "binding input {binding_bytes} B of {} B; declared contexts <= {declared_contexts} of 8192",
        16 * 1024 * 1024
    );
    match browsing.flatten() {
        Some(browsing) => {
            stage.bytes = Some(serde_json::to_vec(&browsing).unwrap().len());
            stage.note = format!("{} contexts; {budget}", browsing.contexts.len());
        }
        None => {
            stage.note =
                format!("OMITTED: projection budget reached (snapshot.browsing = None); {budget}")
        }
    }
    stages.push(stage);
    let (mut stage, snapshot) = measure("workspace snapshot (total)", iterations, || {
        service.workspace_snapshot(50)
    });
    let snapshot = match snapshot {
        Some(Ok(snapshot)) => snapshot,
        Some(Err(error)) => {
            stage.note = format!("REFUSED: {}", error.message);
            stages.push(stage);
            return stages;
        }
        None => unreachable!(),
    };
    stage.note = format!(
        "{} statuses, {} listing statuses",
        snapshot.statuses.len(),
        snapshot.listing_statuses.len()
    );
    stages.push(stage);
    let (stage, _) = measure("snapshot clone", iterations, || snapshot.clone());
    stages.push(stage);
    let (mut stage, digest) = measure("catalog digest (Tauri)", iterations, || {
        sha256_json(&(&snapshot.catalog, &snapshot.listing_catalog))
    });
    stage.bytes = digest.map(|(_, bytes)| bytes);
    stage.note = "serialize + SHA-256 of catalog and listing documents".into();
    stages.push(stage);
    let (mut stage, bytes) = measure("IPC serialization (full)", iterations, || {
        serde_json::to_vec(&snapshot).unwrap()
    });
    stage.bytes = bytes.map(|bytes| bytes.len());
    stages.push(stage);
    let mut unchanged = snapshot.clone();
    unchanged.catalog.ports.clear();
    unchanged.listing_catalog = None;
    let (mut stage, bytes) = measure("IPC serialization (catalog unchanged)", iterations, || {
        serde_json::to_vec(&(
            &unchanged.statuses,
            &unchanged.listing_statuses,
            &unchanged.sources,
            &unchanged.activities,
            &unchanged.browsing,
        ))
        .unwrap()
    });
    stage.bytes = bytes.map(|bytes| bytes.len());
    stage.note = "approximate payload when the held digest matches".into();
    stages.push(stage);
    stages
}

fn report(factor: usize, installs: usize, stages: &[Stage]) {
    println!("\n### {factor}x catalog, {installs} installs\n");
    println!(
        "| stage | n | p50 ms | p95 ms | peak RSS delta KiB | port()/listing() calls | bytes | note |"
    );
    println!("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for stage in stages {
        println!(
            "| {} | {} | {} | {} | {} | {}/{} | {} | {} |",
            stage.name,
            stage.samples.len(),
            milliseconds(percentile(&stage.samples, 50)),
            milliseconds(percentile(&stage.samples, 95)),
            stage.peak_delta_kib,
            stage.lookups.0,
            stage.lookups.1,
            stage
                .bytes
                .map_or_else(|| "-".to_string(), |bytes| bytes.to_string()),
            stage.note
        );
    }
}

#[test]
#[ignore = "manual scaling profile; see the module documentation"]
fn scaling_profile_workspace_acquisition() {
    let factors = std::env::var("PORTCOVE_SCALING_FACTORS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(|factor| factor.trim().parse().unwrap())
                .collect::<Vec<usize>>()
        })
        .unwrap_or_else(|| vec![1, 5, 10]);
    let installs = std::env::var("PORTCOVE_SCALING_INSTALLS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(|count| count.trim().parse().unwrap())
                .collect::<Vec<usize>>()
        })
        .unwrap_or_else(|| vec![0, 100, 1000]);
    let iterations = std::env::var("PORTCOVE_SCALING_ITERATIONS")
        .ok()
        .map_or(5, |value| value.parse().unwrap());
    println!(
        "profile: {} build, {} logical CPUs",
        if cfg!(debug_assertions) {
            "test (debug assertions)"
        } else {
            "optimized"
        },
        std::thread::available_parallelism().map_or(0, std::num::NonZero::get)
    );
    for &factor in &factors {
        for &count in &installs {
            let stages = profile(factor, count, iterations);
            report(factor, count, &stages);
        }
    }
}

#[test]
fn scaled_fixture_is_deterministic_with_fresh_identities() {
    let none = HashSet::new();
    let (first, first_listings) = scaled_documents_excluding(3, &none);
    let (second, second_listings) = scaled_documents_excluding(3, &none);
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(
        serde_json::to_vec(&first_listings).unwrap(),
        serde_json::to_vec(&second_listings).unwrap()
    );
    let embedded = Catalog::embedded().unwrap();
    assert_eq!(first.ports.len(), embedded.ports().len() * 3);
    assert_eq!(first_listings.listings.len(), embedded.listings().len() * 3);
    let ports = first
        .ports
        .iter()
        .map(|port| port.id.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(ports.len(), first.ports.len());
    let listings = first_listings
        .listings
        .iter()
        .map(|listing| listing.id.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(listings.len(), first_listings.listings.len());
}
