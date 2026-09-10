//! Exercise connection churn through the same canonical paths used after a move.
use std::sync::{
    Arc, Barrier,
    atomic::{AtomicBool, Ordering},
};

#[test]
fn concurrent_canonical_connections_preserve_wal_reads_and_writes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    let initial = super::connect(&root).unwrap();
    initial
        .execute_batch(
            "CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES(0)",
        )
        .unwrap();
    drop(initial);

    let barrier = Arc::new(Barrier::new(8));
    let failed = AtomicBool::new(false);
    let outcomes = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..8)
            .map(|worker| {
                let root = &root;
                let failed = &failed;
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    for cycle in 0..300 {
                        if failed.load(Ordering::Relaxed) {
                            return Ok(());
                        }
                        let result = (|| -> crate::Result<()> {
                            let connection = super::connect(root)?;
                            let value: i64 =
                                connection
                                    .query_row("SELECT value FROM counter", [], |row| row.get(0))?;
                            assert!((0..=30).contains(&value));
                            if worker == 0 && cycle % 10 == 0 {
                                connection.execute("UPDATE counter SET value=value+1", [])?;
                            }
                            Ok(())
                        })();
                        if let Err(error) = result {
                            failed.store(true, Ordering::Relaxed);
                            return Err(format!("worker {worker}, cycle {cycle}: {error:?}"));
                        }
                    }
                    Ok(())
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(outcomes.iter().all(Result::is_ok), "{outcomes:#?}");
    let final_connection = super::connect(&root).unwrap();
    let value: i64 = final_connection
        .query_row("SELECT value FROM counter", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, 30, "every committed increment must remain visible");
    let integrity: String = final_connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}
