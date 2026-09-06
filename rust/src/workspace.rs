use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

use atomic_write_file::OpenOptions as AtomicOpenOptions;
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::server::{MAX_SOURCE_BYTES, lint_values};

const EXTENSIONS: &[&str] = &[
    "crv", "carve", "md", "markdown", "txt", "html", "htm", "djot",
];

#[derive(Debug, Clone)]
struct Root(PathBuf);

#[derive(Debug, Clone)]
pub struct Workspace {
    roots: Vec<Root>,
    allow_write: bool,
    review: ReviewConfiguration,
}

#[derive(Debug, Clone, Default)]
pub struct ReviewConfiguration {
    pub max_depth: Option<usize>,
    pub limit: Option<usize>,
    pub github: bool,
    pub exclude: Vec<String>,
    pub check_links: Option<bool>,
    pub check_anchors: Option<bool>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn relative_string(path: &Path) -> String {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
}

impl Workspace {
    pub fn new(
        roots: &[PathBuf],
        allow_write: bool,
        review: ReviewConfiguration,
    ) -> Result<Self, String> {
        let mut canonical = Vec::new();
        for root in roots {
            let root = fs::canonicalize(root).map_err(|error| {
                format!("Cannot open workspace root {}: {error}", root.display())
            })?;
            if !root.is_dir() {
                return Err("A configured workspace root is not a directory.".into());
            }
            if !canonical.iter().any(|existing: &Root| existing.0 == root) {
                canonical.push(Root(root));
            }
        }
        Ok(Self {
            roots: canonical,
            allow_write,
            review,
        })
    }

    pub fn root_count(&self) -> usize {
        self.roots.len()
    }
    pub fn allow_write(&self) -> bool {
        self.allow_write
    }
    pub fn review_max_depth(&self) -> usize {
        self.review.max_depth.unwrap_or(10)
    }
    pub fn review_limit(&self) -> usize {
        self.review.limit.unwrap_or(500)
    }
    pub fn review_github(&self) -> bool {
        self.review.github
    }
    pub fn check_links(&self) -> bool {
        self.review.check_links.unwrap_or(true)
    }
    pub fn check_anchors(&self) -> bool {
        self.review.check_anchors.unwrap_or(true)
    }

    fn requested(&self, root_index: usize, path: &str) -> Result<(&Root, PathBuf), String> {
        let root = self.roots.get(root_index).ok_or_else(|| {
            format!("Unknown root index {root_index}. Configure a root when starting carve-mcp.")
        })?;
        let relative = Path::new(path);
        if relative.is_absolute()
            || relative.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("Workspace path escapes the configured root.".into());
        }
        if relative.components().any(|part| {
            let value = part.as_os_str().to_string_lossy();
            value.starts_with('.') || matches!(value.as_ref(), "node_modules" | "vendor" | "target")
        }) {
            return Err(
                "Hidden paths and dependency directories are not readable workspace documents."
                    .into(),
            );
        }
        if !supported(relative) {
            return Err("Unsupported document extension.".into());
        }
        Ok((root, root.0.join(relative)))
    }

    pub fn read(&self, root_index: usize, path: &str) -> Result<Value, String> {
        let (root, requested) = self.requested(root_index, path)?;
        let canonical = fs::canonicalize(&requested)
            .map_err(|_| format!("Workspace file not found: {path}"))?;
        if !canonical.starts_with(&root.0) {
            return Err("Resolved path escapes the configured workspace root.".into());
        }
        let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Path is not a regular file.".into());
        }
        if metadata.len() > MAX_SOURCE_BYTES as u64 {
            return Err(format!("File exceeds the {MAX_SOURCE_BYTES}-byte limit."));
        }
        let bytes = fs::read(canonical).map_err(|error| error.to_string())?;
        if bytes.contains(&0) {
            return Err("Binary files are not supported.".into());
        }
        let content = String::from_utf8(bytes.clone())
            .map_err(|_| format!("Workspace file is not valid UTF-8: {path}"))?;
        Ok(
            json!({"rootIndex": root_index, "path": path, "content": content, "sha256": digest(&bytes), "bytes": bytes.len()}),
        )
    }

    pub fn list(&self, root_index: usize, max_depth: usize, limit: usize) -> Result<Value, String> {
        let root = self.roots.get(root_index).ok_or_else(|| {
            format!("Unknown root index {root_index}. Configure a root when starting carve-mcp.")
        })?;
        let max_depth = max_depth.min(25);
        let limit = limit.clamp(1, 2_000);
        let mut files = Vec::new();
        let mut truncated = false;
        fn visit(
            base: &Path,
            directory: &Path,
            depth: usize,
            bounds: (usize, usize),
            files: &mut Vec<String>,
            truncated: &mut bool,
            excluded: &[String],
        ) -> Result<(), String> {
            let mut entries = fs::read_dir(directory)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                let relative = relative_string(
                    entry
                        .path()
                        .strip_prefix(base)
                        .expect("entry remains below root"),
                );
                if excluded
                    .iter()
                    .any(|value| relative == *value || relative.starts_with(&format!("{value}/")))
                {
                    continue;
                }
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir()
                    && depth < bounds.0
                    && !matches!(name.as_str(), "node_modules" | "vendor" | "target")
                {
                    visit(
                        base,
                        &entry.path(),
                        depth + 1,
                        bounds,
                        files,
                        truncated,
                        excluded,
                    )?;
                } else if kind.is_file() && supported(&entry.path()) {
                    if files.len() == bounds.1 {
                        *truncated = true;
                        return Ok(());
                    }
                    files.push(relative_string(
                        entry
                            .path()
                            .strip_prefix(base)
                            .expect("entry remains below root"),
                    ));
                }
                if *truncated {
                    return Ok(());
                }
            }
            Ok(())
        }
        visit(
            &root.0,
            &root.0,
            0,
            (max_depth, limit),
            &mut files,
            &mut truncated,
            &self.review.exclude,
        )?;
        Ok(
            json!({"rootIndex": root_index, "files": files, "truncated": truncated, "maxDepth": max_depth, "limit": limit}),
        )
    }

    pub fn write(
        &self,
        root_index: usize,
        path: &str,
        content: &str,
        expected: Option<&str>,
        dry_run: bool,
    ) -> Result<Value, String> {
        if !self.allow_write {
            return Err(
                "Workspace writes are disabled. Start carve-mcp with --allow-write to enable them."
                    .into(),
            );
        }
        if content.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "Content exceeds the {MAX_SOURCE_BYTES}-byte limit."
            ));
        }
        let (root, target) = self.requested(root_index, path)?;
        let parent = fs::canonicalize(target.parent().ok_or("Workspace path has no parent.")?)
            .map_err(|error| error.to_string())?;
        if !parent.starts_with(&root.0) {
            return Err("Resolved parent escapes the configured workspace root.".into());
        }
        let existing = fs::read(&target).ok();
        let current = existing.as_deref().map(digest);
        if !dry_run && existing.is_some() && expected.is_none() {
            return Err("expectedSha256 is required when overwriting a file.".into());
        }
        if expected.is_some_and(|value| Some(value) != current.as_deref()) {
            return Err("File changed since it was read; expectedSha256 does not match.".into());
        }
        let next = digest(content.as_bytes());
        if !dry_run {
            let mut options = AtomicOpenOptions::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&target).map_err(|error| error.to_string())?;
            file.write_all(content.as_bytes())
                .map_err(|error| error.to_string())?;
            if let Some(before) = current.as_deref() {
                let latest = fs::read(&target).map_err(|error| error.to_string())?;
                if digest(&latest) != before {
                    return Err("File changed during the write; refusing to replace it.".into());
                }
            }
            file.commit().map_err(|error| error.to_string())?;
        }
        Ok(
            json!({"rootIndex": root_index, "path": path, "dryRun": dry_run, "created": existing.is_none(), "currentSha256": current, "sha256": next, "bytes": content.len()}),
        )
    }

    pub fn review(
        &self,
        root_index: usize,
        max_depth: usize,
        limit: usize,
        github: bool,
        check_links: bool,
        check_anchors: bool,
    ) -> Result<Value, String> {
        let listing = self.list(root_index, max_depth, limit)?;
        let paths = listing["files"].as_array().expect("files array");
        let discovered = paths
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let mut sources = BTreeMap::new();
        let mut project_warnings = Vec::new();
        let mut total_bytes = 0usize;
        let mut size_truncated = false;
        for path in paths {
            let path = path.as_str().expect("string path");
            let read = match self.read(root_index, path) {
                Ok(read) => read,
                Err(error) => {
                    project_warnings.push(json!({"rule":"unreadable-document","code":"CARVE_PROJECT_UNREADABLE_DOCUMENT","severity":"warning","suggestion":"Make the file readable UTF-8 text or exclude it from the review.","message":format!("Document could not be reviewed: {error}"),"path":path,"line":1,"column":1}));
                    continue;
                }
            };
            let bytes = read["bytes"].as_u64().unwrap() as usize;
            if total_bytes + bytes > 25_000_000 {
                size_truncated = true;
                break;
            }
            total_bytes += bytes;
            sources.insert(
                path.to_owned(),
                read["content"].as_str().unwrap().to_owned(),
            );
        }
        let mut files = Vec::new();
        let mut counts = BTreeMap::<String, usize>::new();
        let mut warning_count = 0;
        for (path, source) in &sources {
            if !matches!(
                Path::new(path).extension().and_then(|v| v.to_str()),
                Some("crv" | "carve")
            ) {
                continue;
            }
            let platforms = if github {
                vec![crate::server::LintPlatform::Github]
            } else {
                vec![]
            };
            let warnings = lint_values(source, &platforms);
            for warning in &warnings {
                if let Some(rule) = warning["rule"].as_str() {
                    *counts.entry(rule.into()).or_default() += 1;
                }
            }
            warning_count += warnings.len();
            files.push(json!({"path": path, "valid": warnings.is_empty(), "warningCount": warnings.len(), "warnings": warnings}));
        }
        let mut anchors = BTreeMap::<String, BTreeSet<String>>::new();
        if check_links && check_anchors {
            for (path, source) in &sources {
                if !matches!(
                    Path::new(path).extension().and_then(|value| value.to_str()),
                    Some("crv" | "carve" | "md" | "markdown" | "djot")
                ) {
                    continue;
                }
                let ast = carve::to_json_with_options(
                    source,
                    &carve::Options::default().with_positions(true),
                );
                let value: Value = serde_json::from_str(&ast).map_err(|error| error.to_string())?;
                let mut ids = BTreeSet::new();
                collect_heading_ids(&value, &mut ids);
                anchors.insert(path.clone(), ids);
            }
        }
        let link = Regex::new(r#"!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)"#).unwrap();
        let scheme = Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:").unwrap();
        for (path, source) in &sources {
            if !check_links {
                break;
            }
            let opaque = opaque_ranges(source);
            for capture in link.captures_iter(source) {
                let capture_start = capture.get(0).unwrap().start();
                if opaque
                    .iter()
                    .any(|(start, end)| capture_start >= *start && capture_start < *end)
                {
                    continue;
                }
                if capture.get(0).unwrap().as_str().starts_with('!') {
                    continue;
                }
                let raw = &capture[1];
                if raw.starts_with('#')
                    || raw.starts_with('/')
                    || raw.contains('%')
                    || scheme.is_match(raw)
                {
                    continue;
                }
                let mut target_parts = raw.splitn(2, '#');
                let target_part = target_parts.next().unwrap();
                let fragment = target_parts.next();
                let parent = Path::new(path).parent().unwrap_or(Path::new(""));
                let target = parent.join(target_part);
                if target
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
                    && !rooted_normalize(&target).is_some()
                {
                    continue;
                }
                let Some(target) = rooted_normalize(&target) else {
                    continue;
                };
                if !supported(&target) {
                    continue;
                }
                let normalized = relative_string(&target);
                if !discovered.contains(&normalized) {
                    let start = capture.get(1).unwrap().start();
                    let before = &source[..start];
                    let line_no = before.matches('\n').count() + 1;
                    let column = before
                        .rsplit('\n')
                        .next()
                        .unwrap_or("")
                        .encode_utf16()
                        .count()
                        + 1;
                    project_warnings.push(json!({"rule":"missing-local-file","code":"CARVE_PROJECT_MISSING_FILE","severity":"error","suggestion":"Fix the destination or add the missing document.","message":format!("Local link target does not exist in this workspace review: {normalized}"),"path":path,"target":raw,"line":line_no,"column":column}));
                } else if check_anchors
                    && let Some(fragment) = fragment
                    && anchors.contains_key(&normalized)
                    && !anchors
                        .get(&normalized)
                        .is_some_and(|ids| ids.contains(&fragment.to_lowercase()))
                {
                    let start = capture.get(1).unwrap().start();
                    let before = &source[..start];
                    let line_no = before.matches('\n').count() + 1;
                    let column = before
                        .rsplit('\n')
                        .next()
                        .unwrap_or("")
                        .encode_utf16()
                        .count()
                        + 1;
                    project_warnings.push(json!({"rule":"broken-local-anchor","code":"CARVE_PROJECT_BROKEN_ANCHOR","severity":"error","suggestion":"Update the fragment to match a heading ID in the destination document.","message":format!("Local link anchor does not exist in {normalized}: #{fragment}"),"path":path,"target":raw,"line":line_no,"column":column}));
                }
            }
        }
        project_warnings.sort_by(|left, right| {
            left["path"]
                .as_str()
                .cmp(&right["path"].as_str())
                .then_with(|| left["line"].as_u64().cmp(&right["line"].as_u64()))
                .then_with(|| left["column"].as_u64().cmp(&right["column"].as_u64()))
        });
        for warning in &project_warnings {
            if let Some(rule) = warning["rule"].as_str() {
                *counts.entry(rule.into()).or_default() += 1;
            }
        }
        let errors = project_warnings
            .iter()
            .filter(|warning| warning["severity"] == "error")
            .count();
        let warnings = warning_count
            + project_warnings
                .iter()
                .filter(|warning| warning["severity"] == "warning")
                .count();
        let mut next_actions = Vec::new();
        if warning_count > 0 {
            next_actions.push("Review the reported Carve lint diagnostics, starting with reader-visible problems.".to_owned());
        }
        for warning in &project_warnings {
            if let Some(suggestion) = warning["suggestion"].as_str()
                && !next_actions.iter().any(|value| value == suggestion)
                && next_actions.len() < 5
            {
                next_actions.push(suggestion.to_owned());
            }
        }
        warning_count += project_warnings.len();
        Ok(
            json!({"rootIndex":root_index,"valid":warning_count==0,"filesDiscovered":paths.len(),"filesChecked":files.len(),"warningCount":warning_count,"ruleCounts":counts,"summary":{"bySeverity":{"error":errors,"warning":warnings},"nextActions":next_actions},"files":files,"projectWarnings":project_warnings,"truncated":listing["truncated"].as_bool().unwrap_or(false) || size_truncated,"totalBytes":total_bytes}),
        )
    }
}

fn collect_heading_ids(value: &Value, ids: &mut BTreeSet<String>) {
    if value.get("type").and_then(Value::as_str) == Some("heading")
        && let Some(id) = value.pointer("/attrs/id").and_then(Value::as_str)
    {
        ids.insert(id.to_lowercase());
    }
    if let Some(children) = value.get("children").and_then(Value::as_array) {
        for child in children {
            collect_heading_ids(child, ids);
        }
    }
}

fn opaque_ranges(source: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut offset = 0;
    let mut fence = None;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if fence.is_some() || marker.is_some() {
            ranges.push((offset, offset + line.len()));
        }
        if let Some(marker) = marker {
            if fence.is_none() {
                fence = Some(marker);
            } else if fence == Some(marker) {
                fence = None;
            }
        }
        offset += line.len();
    }
    for found in Regex::new(r"`+[^`\n]*`+").unwrap().find_iter(source) {
        ranges.push((found.start(), found.end()));
    }
    ranges
}

fn rooted_normalize(path: &Path) -> Option<PathBuf> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => result.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_root() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("carve-mcp-test-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn lists_reviews_previews_and_guards_writes() {
        let root = temporary_root();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(
            root.join("index.crv"),
            "# Home\n\n[bad](docs/missing.crv)\n[binary](notes.txt)\n:::",
        )
        .unwrap();
        fs::write(root.join("docs/guide.crv"), "# Guide").unwrap();
        fs::write(root.join("notes.txt"), [0, 1]).unwrap();
        let workspace = Workspace::new(
            std::slice::from_ref(&root),
            true,
            ReviewConfiguration::default(),
        )
        .unwrap();
        assert_eq!(
            workspace.list(0, 10, 500).unwrap()["files"],
            json!(["docs/guide.crv", "index.crv", "notes.txt"])
        );
        let review = workspace.review(0, 10, 500, false, true, true).unwrap();
        assert_eq!(review["filesChecked"], 2);
        assert_eq!(review["projectWarnings"][0]["rule"], "missing-local-file");
        assert_eq!(review["projectWarnings"][1]["rule"], "unreadable-document");
        let lint_only = workspace.review(0, 10, 500, false, false, false).unwrap();
        assert!(
            lint_only["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file["warningCount"].as_u64().unwrap() > 0)
        );
        assert!(
            !lint_only["projectWarnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning["rule"] == "missing-local-file")
        );
        let read = workspace.read(0, "index.crv").unwrap();
        let hash = read["sha256"].as_str().unwrap();
        assert_eq!(
            workspace
                .write(0, "index.crv", "# Changed", Some(hash), true)
                .unwrap()["dryRun"],
            true
        );
        workspace
            .write(0, "index.crv", "# Changed", Some(hash), false)
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("index.crv")).unwrap(),
            "# Changed"
        );
        workspace.write(0, "new.crv", "# New", None, false).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("new.crv"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(
            workspace
                .write(0, "../outside.crv", "x", None, false)
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
