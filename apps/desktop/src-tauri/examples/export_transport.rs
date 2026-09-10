// Compile the exact host-owned declarations without exposing them as product API.
#[path = "../src/transport.rs"]
mod transport;

use portcove_core::{ReconcileResult, UpdateCheck};
use schemars::{JsonSchema, generate::SchemaSettings};
use serde_json::{Value, json};
use transport::{
    BackupReview, BatchOutcome, BootstrapStatus, CliCommandContext, DesktopError, InstallInput,
    LaunchResult, SourceBatchOutcome,
};

fn output<T: JsonSchema>() -> Value {
    json!(
        SchemaSettings::default()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<T>()
    )
}

fn main() {
    println!(
        "{}",
        json!({
            "output": {
                "bootstrap_status": output::<BootstrapStatus>(),
                "backup_review": output::<BackupReview>(),
                "cli_command_context": output::<CliCommandContext>(),
                "desktop_error": output::<DesktopError>(),
                "update_check_outcome": output::<BatchOutcome<UpdateCheck>>(),
                "reconcile_outcome": output::<BatchOutcome<ReconcileResult>>(),
                "source_verification_outcome": output::<SourceBatchOutcome>(),
                "launch_result": output::<LaunchResult>(),
            },
            "input": {"install_input": schemars::schema_for!(InstallInput)},
        })
    );
}
