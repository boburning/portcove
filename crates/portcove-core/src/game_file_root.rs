use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Library, PortcoveError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GameFileRootAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GameFileRoot {
    pub id: String,
    pub path: PathBuf,
    pub availability: GameFileRootAvailability,
    pub created_at: i64,
    pub updated_at: i64,
}

struct StoredGameFileRoot {
    id: String,
    path: String,
    created_at: i64,
    updated_at: i64,
}

impl StoredGameFileRoot {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            path: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    }

    fn into_record(self) -> Result<GameFileRoot> {
        uuid::Uuid::parse_str(&self.id).map_err(|error| {
            PortcoveError::state("stored game-file root identity is invalid")
                .detail("root_id", &self.id)
                .detail("cause", error.to_string())
        })?;
        let path = PathBuf::from(self.path);
        crate::path::unicode(&path, "game-file root")?;
        let availability = match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_dir() => GameFileRootAvailability::Available,
            _ => GameFileRootAvailability::Unavailable,
        };
        Ok(GameFileRoot {
            id: self.id,
            path,
            availability,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl Library {
    pub fn add_game_file_root(&self, path: &Path) -> Result<GameFileRoot> {
        let path = require_available_root(path)?;
        let path_text = crate::path::unicode(&path, "game-file root")?;
        let path_key = path_key(&path_text);
        let connection = self.connection()?;
        if let Some(stored) = connection
            .query_row(
                "SELECT id,path,created_at,updated_at FROM game_file_roots WHERE path_key=?1",
                [&path_key],
                StoredGameFileRoot::from_row,
            )
            .optional()?
        {
            return stored.into_record();
        }
        let now = Self::now();
        let id = uuid::Uuid::new_v4().to_string();
        connection.execute(
            "INSERT INTO game_file_roots(id,path,path_key,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?4)",
            params![id, path_text, path_key, now],
        )?;
        Ok(GameFileRoot {
            id,
            path,
            availability: GameFileRootAvailability::Available,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn game_file_roots(&self) -> Result<Vec<GameFileRoot>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,path,created_at,updated_at FROM game_file_roots ORDER BY created_at,id",
        )?;
        let rows = statement.query_map([], StoredGameFileRoot::from_row)?;
        rows.map(|row| row?.into_record()).collect()
    }

    pub fn relink_game_file_root(&self, id: &str, path: &Path) -> Result<GameFileRoot> {
        validate_id(id)?;
        let path = require_available_root(path)?;
        let path_text = crate::path::unicode(&path, "game-file root")?;
        let path_key = path_key(&path_text);
        let connection = self.connection()?;
        let existing_id = connection
            .query_row(
                "SELECT id FROM game_file_roots WHERE path_key=?1",
                [&path_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing_id
            .as_deref()
            .is_some_and(|existing| existing != id)
        {
            return Err(PortcoveError::conflict(
                "that folder is already saved as a game-file root",
            )
            .detail("existing_root_id", existing_id.unwrap()));
        }
        let now = Self::now();
        let changed = connection.execute(
            "UPDATE game_file_roots SET path=?2,path_key=?3,updated_at=?4 WHERE id=?1",
            params![id, path_text, path_key, now],
        )?;
        if changed == 0 {
            return Err(PortcoveError::state("game-file root does not exist").detail("root_id", id));
        }
        Ok(GameFileRoot {
            id: id.to_owned(),
            path,
            availability: GameFileRootAvailability::Available,
            created_at: connection.query_row(
                "SELECT created_at FROM game_file_roots WHERE id=?1",
                [id],
                |row| row.get(0),
            )?,
            updated_at: now,
        })
    }

    pub fn remove_game_file_root(&self, id: &str) -> Result<bool> {
        validate_id(id)?;
        Ok(self
            .connection()?
            .execute("DELETE FROM game_file_roots WHERE id=?1", [id])?
            > 0)
    }
}

fn require_available_root(path: &Path) -> Result<PathBuf> {
    crate::path::unicode(path, "game-file root")?;
    let path = std::fs::canonicalize(path).map_err(|error| {
        PortcoveError::source("game-file root is not available")
            .detail("path", path.display().to_string())
            .detail("cause", error.to_string())
    })?;
    if !std::fs::metadata(&path)?.is_dir() {
        return Err(
            PortcoveError::source("game-file root must be an existing folder")
                .detail("path", path.display().to_string()),
        );
    }
    Ok(path)
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

fn validate_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).map(|_| ()).map_err(|error| {
        PortcoveError::state("game-file root identity is invalid")
            .detail("root_id", id)
            .detail("cause", error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_persist_and_unavailable_paths_remain_relinkable() {
        let temporary = tempfile::tempdir().unwrap();
        let library_root = temporary.path().join("library");
        let selected = temporary.path().join("selected");
        std::fs::create_dir(&selected).unwrap();
        let library = Library::open(&library_root).unwrap();

        let added = library.add_game_file_root(&selected).unwrap();
        let duplicate = library.add_game_file_root(&selected).unwrap();
        assert_eq!(duplicate.id, added.id);
        drop(library);
        std::fs::remove_dir(&selected).unwrap();

        let reopened = Library::open(&library_root).unwrap();
        let roots = reopened.game_file_roots().unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, added.id);
        assert_eq!(roots[0].availability, GameFileRootAvailability::Unavailable);

        let replacement = temporary.path().join("replacement");
        std::fs::create_dir(&replacement).unwrap();
        let relinked = reopened
            .relink_game_file_root(&added.id, &replacement)
            .unwrap();
        assert_eq!(relinked.id, added.id);
        assert_eq!(relinked.created_at, added.created_at);
        assert_eq!(relinked.availability, GameFileRootAvailability::Available);
    }

    #[test]
    fn removing_one_root_preserves_unrelated_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let first = library.add_game_file_root(&first).unwrap();
        let second = library.add_game_file_root(&second).unwrap();

        assert!(library.remove_game_file_root(&first.id).unwrap());
        assert!(!library.remove_game_file_root(&first.id).unwrap());
        assert_eq!(library.game_file_roots().unwrap(), vec![second]);
    }

    #[test]
    fn relink_refuses_another_saved_root() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let first = library.add_game_file_root(&first).unwrap();
        let second = library.add_game_file_root(&second).unwrap();

        let error = library
            .relink_game_file_root(&first.id, &second.path)
            .unwrap_err();
        assert_eq!(error.details["existing_root_id"], second.id);
    }

    #[test]
    fn adding_requires_an_existing_folder() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let file = temporary.path().join("file.bin");
        std::fs::write(&file, b"fixture").unwrap();

        assert!(library.add_game_file_root(&file).is_err());
        assert!(
            library
                .add_game_file_root(&temporary.path().join("missing"))
                .is_err()
        );
    }
}
