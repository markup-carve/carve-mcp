//! Host-side reference index for Carve 0.2 workspace trees.
use crate::{
    server::{MAX_SOURCE_BYTES, ast_nodes},
    workspace::Workspace,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    path::Path,
};

fn field<'a>(node: &'a Value, name: &str) -> Option<&'a str> {
    node.get(name).and_then(Value::as_str)
}
fn location(path: &str, node: &Value) -> Value {
    json!({"path":path,"line":node.pointer("/pos/startLine").and_then(Value::as_u64).unwrap_or(1),
        "column":node.pointer("/pos/startColumn").and_then(Value::as_u64).unwrap_or(1),
        "start":node.pointer("/pos/startOffset").and_then(Value::as_u64).unwrap_or(0),
        "end":node.pointer("/pos/endOffset").and_then(Value::as_u64).unwrap_or(0)})
}
fn target(from: &str, href: &str) -> Option<(String, Option<String>)> {
    let lower = href.to_ascii_lowercase();
    if href.starts_with('/')
        || href.starts_with("//")
        || lower.split(':').next().is_some_and(|prefix| {
            !prefix.is_empty()
                && lower.contains(':')
                && prefix
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && prefix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
    {
        return None;
    }
    let (raw, id) = href
        .split_once('#')
        .map_or((href, None), |(raw, id)| (raw, Some(id.to_string())));
    if raw.is_empty() {
        return Some((from.to_string(), id));
    }
    let mut components = Vec::new();
    for part in Path::new(from)
        .parent()
        .unwrap_or(Path::new(""))
        .iter()
        .chain(Path::new(raw).iter())
    {
        let part = part.to_string_lossy();
        match part.as_ref() {
            "." | "" => {}
            ".." => {
                components.pop()?;
            }
            _ => components.push(part.to_string()),
        }
    }
    Some((components.join("/"), id))
}
fn key(kind: &str, path: &str, id: &str) -> String {
    format!("{kind}\0{path}\0{id}")
}
fn sort_location(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        a["path"]
            .as_str()
            .cmp(&b["path"].as_str())
            .then(a["start"].as_u64().cmp(&b["start"].as_u64()))
            .then(a["end"].as_u64().cmp(&b["end"].as_u64()))
    });
}
pub(crate) fn build(
    workspace: &Workspace,
    root_index: usize,
    depth: usize,
    limit: usize,
) -> Result<Value, String> {
    let listed = workspace.list(root_index, depth, limit)?;
    let files: Vec<String> = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let file_set: HashSet<_> = files.iter().cloned().collect();
    let mut parsed = BTreeSet::new();
    let mut definitions = Vec::new();
    let mut references = Vec::new();
    let mut errors = Vec::new();
    let mut total_bytes = 0usize;
    let mut size_truncated = false;
    for path in files.iter().filter(|path| {
        matches!(
            Path::new(path).extension().and_then(|v| v.to_str()),
            Some("crv" | "carve")
        )
    }) {
        let read = match workspace.read(root_index, path) {
            Ok(read) => read,
            Err(error) => {
                errors.push(json!({"path":path,"message":error}));
                continue;
            }
        };
        let bytes = read["bytes"].as_u64().unwrap_or(0) as usize;
        if total_bytes + bytes > 25 * MAX_SOURCE_BYTES {
            size_truncated = true;
            break;
        }
        total_bytes += bytes;
        let tree = match crate::engine2::parse(read["content"].as_str().unwrap_or(""), true) {
            Ok(tree) => tree,
            Err(error) => {
                errors.push(json!({"path":path,"message":error}));
                continue;
            }
        };
        parsed.insert(path.to_string());
        for (_, node) in ast_nodes(&tree) {
            let node = Value::Object(node.clone());
            let Some(kind) = field(&node, "type") else {
                continue;
            };
            let at = location(path, &node);
            let add_definition = match kind {
                "heading" => node
                    .pointer("/attrs/id")
                    .and_then(Value::as_str)
                    .or_else(|| field(&node, "generatedId"))
                    .map(|id| ("heading", id)),
                "footnote" => field(&node, "key").map(|id| ("footnote", id)),
                "abbreviation_def" => field(&node, "key").map(|id| ("abbreviation", id)),
                _ => None,
            };
            if let Some((kind, id)) = add_definition {
                let mut row = at.clone();
                row["kind"] = json!(kind);
                row["id"] = json!(id);
                definitions.push(row);
            }
            let reference =
                match kind {
                    "xref" if field(&node, "namespace") == Some("heading") => field(&node, "key")
                        .map(|id| {
                            (
                                "heading",
                                id.to_string(),
                                path.to_string(),
                                Some(id.to_string()),
                            )
                        }),
                    "footnote_ref" => field(&node, "key").map(|id| {
                        (
                            "footnote",
                            id.to_string(),
                            path.to_string(),
                            Some(id.to_string()),
                        )
                    }),
                    "link" | "image" => field(&node, if kind == "link" { "href" } else { "src" })
                        .map(|id| {
                            let resolved = target(path, id);
                            (
                                kind,
                                id.to_string(),
                                resolved
                                    .as_ref()
                                    .map(|t| t.0.clone())
                                    .unwrap_or_else(|| id.to_string()),
                                resolved.and_then(|t| t.1),
                            )
                        }),
                    _ => None,
                };
            if let Some((kind, id, target_path, target_id)) = reference {
                let mut row = at;
                row["kind"] = json!(kind);
                row["id"] = json!(id);
                row["targetPath"] = json!(target_path);
                if let Some(target_id) = target_id {
                    row["targetId"] = json!(target_id);
                }
                references.push(row);
            }
        }
    }
    sort_location(&mut definitions);
    sort_location(&mut references);
    let keys: HashSet<_> = definitions
        .iter()
        .map(|d| {
            key(
                d["kind"].as_str().unwrap(),
                d["path"].as_str().unwrap(),
                d["id"].as_str().unwrap(),
            )
        })
        .collect();
    let mut edges = Vec::new();
    let mut broken = Vec::new();
    let mut used = HashSet::new();
    for mut row in references {
        let kind = row["kind"].as_str().unwrap().to_string();
        let id = row["id"].as_str().unwrap().to_string();
        let path = row["targetPath"].as_str().unwrap().to_string();
        let target_id = row["targetId"].as_str().unwrap_or(&id).to_string();
        let resolved: Option<bool> = match kind.as_str() {
            "heading" | "footnote" => Some(keys.contains(&key(&kind, &path, &target_id))),
            "link" => {
                if target(&path, &id).is_none() {
                    Some(true)
                } else if !file_set.contains(&path) {
                    Some(false)
                } else if row.get("targetId").is_none() {
                    Some(true)
                } else if matches!(
                    Path::new(&path).extension().and_then(|v| v.to_str()),
                    Some("crv" | "carve")
                ) && parsed.contains(&path)
                {
                    Some(keys.contains(&key("heading", &path, &target_id)))
                } else {
                    None
                }
            }
            "image" => {
                if target(&path, &id).is_none() {
                    Some(true)
                } else {
                    None
                }
            }
            _ => None,
        };
        row["resolved"] = json!(resolved);
        if resolved == Some(true) {
            used.insert(key(&kind, &path, &target_id));
        }
        if resolved == Some(false) {
            broken.push(row.clone());
        }
        edges.push(row);
    }
    let orphans: Vec<_> = definitions
        .iter()
        .filter(|d| {
            d["kind"] == "footnote"
                && !used.contains(&key(
                    "footnote",
                    d["path"].as_str().unwrap(),
                    d["id"].as_str().unwrap(),
                ))
        })
        .cloned()
        .collect();
    Ok(
        json!({"rootIndex":root_index,"counts":{"definitions":definitions.len(),"references":edges.len(),"broken":broken.len(),"orphans":orphans.len()},
        "definitions":definitions,"references":edges,"brokenReferences":broken,"orphans":orphans,"errors":errors,
        "truncated":listed["truncated"].as_bool().unwrap_or(false)||size_truncated,"totalBytes":total_bytes}),
    )
}
