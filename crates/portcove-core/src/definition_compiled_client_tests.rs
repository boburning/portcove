use super::*;
use std::process::Command;

struct Consumer {
    path: PathBuf,
    sha256: String,
}

impl Consumer {
    fn from_environment(prefix: &str) -> Self {
        Self {
            path: PathBuf::from(std::env::var_os(format!("{prefix}_PATH")).unwrap()),
            sha256: std::env::var(format!("{prefix}_SHA256")).unwrap(),
        }
    }

    fn invoke(&self, library: &Library, args: &[&str]) -> Value {
        assert_eq!(
            hex::encode(Sha256::digest(fs::read(&self.path).unwrap())),
            self.sha256
        );
        let output = Command::new(&self.path)
            .args(args)
            .env_remove("PORTCOVE_QUALIFICATION_CATALOG")
            .env("PORTCOVE_QUALIFICATION_LIBRARY", library.root())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            hex::encode(Sha256::digest(fs::read(&self.path).unwrap())),
            self.sha256
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

#[tokio::test]
#[ignore = "explicit unchanged compiled-client correction consumption"]
async fn qualification_compiled_clients_consume_managed_corrections() {
    let cli = Consumer::from_environment("PORTCOVE_QUALIFICATION_CLI");
    let desktop = Consumer::from_environment("PORTCOVE_QUALIFICATION_DESKTOP");
    let report = PathBuf::from(std::env::var_os("PORTCOVE_QUALIFICATION_CONSUMER_REPORT").unwrap());
    let mut stages = Vec::new();
    let mut observe = |library: &Library, stage: &str| {
        let root = library.root().to_str().unwrap();
        let cli_status = cli.invoke(
            library,
            &["--library", root, "--json", "--non-interactive", "status"],
        );
        assert_eq!(cli_status["ok"], true);
        assert_eq!(cli_status["command"], "status");
        let desktop_status =
            desktop.invoke(library, &["--portcove-adapter-conformance-statuses", root]);
        let service = PortcoveService::new(library.clone()).unwrap();
        let expected = serde_json::to_value(service.statuses().unwrap()).unwrap();
        assert_eq!(cli_status["data"], expected, "{stage}: CLI projection");
        assert_eq!(desktop_status, expected, "{stage}: Desktop projection");
        let content = cli.invoke(
            library,
            &[
                "--library",
                root,
                "--json",
                "--non-interactive",
                "catalog",
                "show",
                ID,
            ],
        );
        assert_eq!(content["ok"], true);
        assert_eq!(content["command"], "catalog.show");
        assert_eq!(
            content["data"],
            serde_json::to_value(service.catalog().port(ID).unwrap()).unwrap()
        );
        if stage.starts_with("correction-") {
            assert_eq!(
                content["data"]["summary"],
                "Reviewed presentation correction"
            );
        }
        stages.push(serde_json::json!({
            "stage": stage,
            "selected": library.definition_selection_status().unwrap().selected,
            "cli_catalog_content": content["data"],
            "statuses": expected,
            "complete_status_parity": true,
        }));
    };
    managed_ordinary_lifecycle(Some(&mut observe)).await;
    assert_eq!(
        stages
            .iter()
            .map(|s| s["stage"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "new-definition",
            "v1",
            "v2",
            "correction-8",
            "correction-9",
            "authorization-narrowed",
            "authorization-restored"
        ]
    );
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "scope": "Fixture-produced signed managed state consumed by unchanged compiled CLI/Desktop; no production acquisition, publication or installed GUI claim",
        "cli_sha256": cli.sha256,
        "desktop_sha256": desktop.sha256,
        "stages": stages,
    })).unwrap();
    use std::io::Write;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
}
