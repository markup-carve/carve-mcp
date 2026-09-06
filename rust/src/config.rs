use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::workspace::ReviewConfiguration;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfiguration {
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    review: ReviewFileConfiguration,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewFileConfiguration {
    max_depth: Option<usize>,
    limit: Option<usize>,
    #[serde(default)]
    platforms: Vec<String>,
    #[serde(default)]
    exclude: Vec<String>,
    check_links: Option<bool>,
    check_anchors: Option<bool>,
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !Path::new(value).is_absolute()
        && !Path::new(value).components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

pub fn load(path: &Path) -> Result<(Vec<PathBuf>, ReviewConfiguration), String> {
    let absolute = std::fs::canonicalize(path).map_err(|error| {
        format!(
            "Cannot read Carve MCP configuration {}: {error}",
            path.display()
        )
    })?;
    let content = std::fs::read_to_string(&absolute).map_err(|error| {
        format!(
            "Cannot read Carve MCP configuration {}: {error}",
            absolute.display()
        )
    })?;
    let config: FileConfiguration = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Invalid Carve MCP configuration {}: {error}",
            absolute.display()
        )
    })?;
    if config
        .roots
        .iter()
        .chain(&config.review.exclude)
        .any(|value| !safe_relative(value))
    {
        return Err(
            "Configuration roots and review exclusions must be safe relative paths.".into(),
        );
    }
    if config.review.max_depth.is_some_and(|value| value > 25) {
        return Err("review.maxDepth must be an integer from 0 to 25.".into());
    }
    if config
        .review
        .limit
        .is_some_and(|value| !(1..=2_000).contains(&value))
    {
        return Err("review.limit must be an integer from 1 to 2000.".into());
    }
    if config
        .review
        .platforms
        .iter()
        .any(|value| value != "github")
    {
        return Err("review.platforms may contain only github.".into());
    }
    let base = absolute.parent().expect("configuration has a parent");
    let roots = config
        .roots
        .into_iter()
        .map(|root| base.join(root))
        .collect();
    Ok((
        roots,
        ReviewConfiguration {
            max_depth: config.review.max_depth,
            limit: config.review.limit,
            github: config
                .review
                .platforms
                .iter()
                .any(|value| value == "github"),
            exclude: config
                .review
                .exclude
                .into_iter()
                .map(|value| value.replace('\\', "/").trim_end_matches('/').to_owned())
                .collect(),
            check_links: config.review.check_links,
            check_anchors: config.review.check_anchors,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn loads_relative_roots_and_review_settings() {
        let path = std::env::temp_dir().join(format!(
            "carve-mcp-config-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, r#"{"roots":["docs"],"review":{"platforms":["github"],"exclude":["archive"],"checkAnchors":false}}"#).unwrap();
        let (roots, review) = load(&path).unwrap();
        assert_eq!(roots, vec![path.parent().unwrap().join("docs")]);
        assert!(review.github);
        assert_eq!(review.check_anchors, Some(false));
        std::fs::remove_file(path).unwrap();
    }
}
