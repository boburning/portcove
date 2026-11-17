use rusqlite::Connection;

use crate::{
    Catalog, InstallRecord, Library, OriginalBinding, ProfileRecipe, Result, profile,
    source_instances,
};

use super::{RecipeInputPlan, RecipeInputStatus, RecipeOriginal};

pub(super) fn plan(
    library: &Library,
    connection: &Connection,
    catalog: &Catalog,
    install: Option<&InstallRecord>,
    recipe: &ProfileRecipe,
    holds: &mut Vec<String>,
) -> Result<(Vec<RecipeInputPlan>, Vec<OriginalBinding>)> {
    let port = catalog.port(&recipe.port_id)?;
    let requirements = [
        port.source_profile.as_deref(),
        port.bios_source_profile.as_deref(),
    ];
    let mut inputs = Vec::new();
    let mut bindings = Vec::new();
    for original in &recipe.originals {
        let name = &original.requirement_id;
        if !requirements.contains(&Some(name.as_str())) {
            holds.push(format!("original {name} is not an input this game uses"));
            inputs.push(unavailable(name, "this game does not use this original"));
            continue;
        }
        match resolve(connection, catalog, original)? {
            Ok(binding) => {
                bindings.push(binding);
                inputs.push(RecipeInputPlan {
                    name: name.clone(),
                    status: RecipeInputStatus::Available,
                    detail: "the exact registered original matches its saved bytes".into(),
                });
            }
            Err(reason) => {
                holds.push(format!("original {name}: {reason}"));
                inputs.push(unavailable(name, reason));
            }
        }
    }
    if let Some(install) = install {
        let game_source_required = !port.optional_game_source
            && !crate::preparation::self_contained_launch(library, port, install);
        let required = [
            (
                requirements[0].filter(|_| game_source_required),
                "the recipe does not identify the original game files this installation needs",
            ),
            (
                requirements[1],
                "the recipe does not identify the BIOS this installation needs",
            ),
        ];
        for (name, reason) in required {
            if let Some(name) = name
                && !recipe
                    .originals
                    .iter()
                    .any(|original| original.requirement_id == name)
            {
                holds.push(format!("original {name}: {reason}"));
                inputs.push(unavailable(name, reason));
            }
        }
    }
    Ok((inputs, bindings))
}

fn unavailable(name: &str, detail: &str) -> RecipeInputPlan {
    RecipeInputPlan {
        name: name.into(),
        status: RecipeInputStatus::Unavailable,
        detail: detail.into(),
    }
}

fn resolve(
    connection: &Connection,
    catalog: &Catalog,
    original: &RecipeOriginal,
) -> Result<std::result::Result<OriginalBinding, &'static str>> {
    let requirement = &original.requirement_id;
    let source = if let Some(storage) = &original.storage
        && storage.observed_identity_sha256.is_some()
    {
        let expected = OriginalBinding {
            requirement_id: requirement.clone(),
            sha256: original.sha256.clone(),
            size: original.size,
            storage_sha256: storage.sha256.clone(),
            storage_size: storage.size,
            observed_identity_sha256: storage.observed_identity_sha256.clone(),
        };
        source_instances::find(
            connection,
            requirement,
            &source_instances::identity(&expected)?,
        )?
    } else {
        let mut matches = source_instances::list(connection, requirement)?
            .into_iter()
            .map(|(_, source)| source)
            .filter(|source| {
                source.sha256 == original.sha256
                    && source.size == original.size
                    && original.storage.as_ref().is_none_or(|storage| {
                        source.storage_sha256 == storage.sha256
                            && source.storage_size == storage.size
                    })
            });
        let first = matches.next();
        if matches.next().is_some() {
            return Ok(Err(if original.storage.is_some() {
                "the recipe leaves the original's observed identity unspecified and matches more than one saved instance. Ask for a recipe with the exact original identity"
            } else {
                "this older recipe matches more than one saved representation. Ask for a recipe with the exact original identity"
            }));
        }
        first
    };
    let Some(source) = source else {
        return Ok(Err(
            "the original game files named by the recipe are not registered. Register the matching files before importing",
        ));
    };
    if crate::source_inspection::verify_registered(catalog, &source).is_err() {
        return Ok(Err(
            "the saved original is missing, changed or no longer accepted for this installation. Find the matching game files and review the recipe again",
        ));
    }
    Ok(Ok(profile::bind_original(requirement, &source)))
}
