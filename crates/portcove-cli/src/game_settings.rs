//! Thin settings adapter. Core owns retained eligibility, review and publication.
use crate::*;
use portcove_core::{GameSettingChange, GameSettingReview, GameSettingsView};

pub(crate) fn name(command: &GameSettingsCommand) -> &'static str {
    match command {
        GameSettingsCommand::List { .. } => "game-settings.list",
        GameSettingsCommand::Review(_) => "game-settings.review",
        GameSettingsCommand::Apply { .. } => "game-settings.apply",
    }
}

fn change(intent: &GameSettingIntentArgs) -> Result<GameSettingChange> {
    match (&intent.value, intent.reset) {
        (None, true) => Ok(GameSettingChange::Reset),
        (Some(text), false) if text.len() <= 2048 => {
            let value: serde_json::Value = serde_json::from_str(text)
                .map_err(|_| PortcoveError::usage("setting value must be one JSON scalar"))?;
            if !matches!(
                value,
                serde_json::Value::Bool(_)
                    | serde_json::Value::Number(_)
                    | serde_json::Value::String(_)
            ) {
                return Err(PortcoveError::usage(
                    "setting value must be a boolean, number, or enum scalar",
                ));
            }
            Ok(GameSettingChange::Set { value })
        }
        _ => Err(PortcoveError::usage(
            "select one bounded --value or --reset",
        )),
    }
}

pub(crate) fn execute(
    command: GameSettingsCommand,
    service: &PortcoveService,
    mode: OutputMode,
) -> Result<()> {
    let command_name = name(&command);
    match command {
        GameSettingsCommand::List { port_id } => render_read_success(
            mode,
            command_name,
            service.get_game_settings(&port_id)?,
            view,
        ),
        GameSettingsCommand::Review(intent) => render_read_success(
            mode,
            command_name,
            service.review_game_setting(
                &intent.port_id,
                &intent.file_id,
                &intent.setting_id,
                change(&intent)?,
            )?,
            review,
        ),
        GameSettingsCommand::Apply {
            intent,
            expected_review,
        } => render_read_success(
            mode,
            command_name,
            service.apply_game_setting(
                &intent.port_id,
                &intent.file_id,
                &intent.setting_id,
                change(&intent)?,
                &expected_review,
            )?,
            view,
        ),
    }
}

fn view(value: &GameSettingsView) -> String {
    if !value.available {
        return format!(
            "Game settings unavailable: {}",
            human::clean(
                value
                    .reason
                    .as_deref()
                    .unwrap_or("no qualified settings for this installation")
            )
        );
    }
    let mut lines = vec![format!(
        "Game settings for {}",
        human::clean(&value.port_id)
    )];
    for file in &value.files {
        lines.push(format!(
            "{} ({})",
            human::clean(&file.path),
            human::clean(&file.id)
        ));
        if !file.available {
            lines.push(human::clean(
                file.reason.as_deref().unwrap_or("file unavailable"),
            ));
            continue;
        }
        for setting in &file.settings {
            lines.push(format!(
                "  {} [{}]: {}",
                human::clean(&setting.label),
                human::clean(&setting.id),
                setting
                    .value
                    .as_ref()
                    .map(|value| human::clean(&value.to_string()))
                    .unwrap_or_else(|| "not present; declared default is separate".into())
            ));
        }
    }
    lines.join("\n")
}

fn review(value: &GameSettingReview) -> String {
    format!(
        "{} — {}\nPrevious: {}\nProposed: {}\nReview SHA-256: {}",
        human::clean(&value.label),
        human::clean(&value.path),
        value
            .previous_value
            .as_ref()
            .map(|value| human::clean(&value.to_string()))
            .unwrap_or_else(|| "not present".into()),
        human::clean(&value.proposed_value.to_string()),
        value.review_sha256
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_setting_intent_requires_one_bounded_scalar_or_reset() {
        let mut intent = GameSettingIntentArgs {
            port_id: "port".into(),
            file_id: "prefs".into(),
            setting_id: "volume".into(),
            value: None,
            reset: false,
        };
        assert!(change(&intent).is_err());
        for text in ["null", "[]", "{}", "NaN", "not-json"] {
            intent.value = Some(text.into());
            assert!(change(&intent).is_err());
        }
        for text in ["70", "1.25", "true", "\"choice\""] {
            intent.value = Some(text.into());
            assert!(matches!(
                change(&intent).unwrap(),
                GameSettingChange::Set { .. }
            ));
        }
        intent.value = Some(format!("\"{}\"", "x".repeat(2048)));
        assert!(change(&intent).is_err());
        intent.reset = true;
        assert!(change(&intent).is_err());
        intent.value = None;
        assert!(matches!(change(&intent).unwrap(), GameSettingChange::Reset));
    }

    #[test]
    fn cli_review_is_read_only_and_apply_requires_explicit_review_binding() {
        let cli = Cli::try_parse_from([
            "portcove",
            "game-settings",
            "review",
            "port",
            "prefs",
            "volume",
            "--value",
            "70",
        ])
        .unwrap();
        assert!(matches!(
            startup::startup_mode(&cli.command),
            startup::StartupMode::ReadOnly
        ));
        assert!(
            Cli::try_parse_from([
                "portcove",
                "game-settings",
                "apply",
                "port",
                "prefs",
                "volume",
                "--reset"
            ])
            .is_err()
        );
        let cli = Cli::try_parse_from([
            "portcove",
            "game-settings",
            "apply",
            "port",
            "prefs",
            "volume",
            "--reset",
            "--expected-review",
            "review",
        ])
        .unwrap();
        assert!(matches!(
            startup::startup_mode(&cli.command),
            startup::StartupMode::Recovering
        ));
        assert!(
            Cli::try_parse_from([
                "portcove",
                "game-settings",
                "review",
                "port",
                "prefs",
                "volume",
                "--reset",
                "--value",
                "70"
            ])
            .is_err()
        );
    }
}
