use serde_json::{Value, json};

use crate::blocks::{
    BlockScope, SourceOffsets, node_range, positioned_ast, sha256_text, validate_selector,
};
use crate::server::{
    AstSelectorInput, MAX_SOURCE_BYTES, ast_identity, ast_nodes, lint_values, selector_matches,
    utf16_offset,
};

/// A plain error, or a refusal whose details the caller can act on.
pub(crate) enum EditFailure {
    Error(String),
    Refusal(String, Value),
}

impl From<String> for EditFailure {
    fn from(message: String) -> Self {
        Self::Error(message)
    }
}

pub(crate) struct Replacement {
    pub output: Value,
    pub result: String,
}

fn fnv1a64(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn splice_patch(source: &str, start: usize, end: usize, replacement: &str, code: &str) -> Value {
    json!({
        "version": 1,
        "sourceFingerprint": fnv1a64(source.as_bytes()),
        "sourceBytes": source.len(),
        "edits": [{"start": start, "end": end, "replacement": replacement, "kind": "refactor", "code": code}],
        "unresolved": [],
    })
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn sort_findings(findings: &mut [Value]) {
    findings.sort_by(|left, right| {
        number(left, "start")
            .cmp(&number(right, "start"))
            .then_with(|| {
                left["rule"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["rule"].as_str().unwrap_or_default())
            })
    });
}

/// Findings outside the edited range must survive at their shifted UTF-16
/// offsets; findings inside it are compared by rule only.
fn compare_findings(
    before: Vec<Value>,
    after: Vec<Value>,
    start: u64,
    old_end: u64,
    new_end: u64,
) -> (Vec<Value>, Vec<Value>) {
    let slot = |finding: &Value, end: u64, shift: i64| {
        let rule = finding["rule"].as_str().unwrap_or_default();
        let (from, to) = (number(finding, "start"), number(finding, "end"));
        if to <= start {
            format!("out:{rule}:{from}:{to}")
        } else if from >= end {
            format!("out:{rule}:{}:{}", from as i64 + shift, to as i64 + shift)
        } else {
            format!("in:{rule}")
        }
    };
    let delta = new_end as i64 - old_end as i64;
    let mut pending: Vec<(String, Value)> = before
        .into_iter()
        .map(|finding| (slot(&finding, old_end, delta), finding))
        .collect();
    let mut introduced = Vec::new();
    for finding in after {
        let key = slot(&finding, new_end, 0);
        if let Some(index) = pending.iter().position(|(candidate, _)| *candidate == key) {
            pending.remove(index);
        } else {
            introduced.push(finding);
        }
    }
    let mut resolved = pending
        .into_iter()
        .map(|(_, finding)| finding)
        .collect::<Vec<_>>();
    sort_findings(&mut introduced);
    sort_findings(&mut resolved);
    (introduced, resolved)
}

struct Located {
    path: String,
    facts: String,
    kind: String,
    start: u64,
    end: u64,
    line: u64,
}

/// The node's own scalar properties and attributes (list tightness, heading
/// level, ids, ...), so a node that keeps its type and range but changes
/// meaning is still caught.
fn facts(node: &serde_json::Map<String, Value>) -> String {
    let mut entries = node
        .iter()
        .filter(|(key, value)| {
            *key == "attrs" || (*key != "pos" && !value.is_object() && !value.is_array())
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(right.0));
    serde_json::to_string(&entries).unwrap_or_default()
}

fn positioned(ast: &Value) -> Vec<Located> {
    ast_nodes(ast)
        .into_iter()
        .filter_map(|(path, node)| {
            let kind = node.get("type").and_then(Value::as_str)?;
            let pos = node.get("pos")?;
            Some(Located {
                path,
                facts: facts(node),
                kind: kind.to_owned(),
                start: pos.get("startOffset")?.as_u64()?,
                end: pos.get("endOffset")?.as_u64()?,
                line: number(pos, "startLine"),
            })
        })
        .collect()
}

/// Every node outside the replaced range must parse again as the same type at
/// the same place, and every ancestor must still span the range. An ancestor
/// that ended with the range may lose the replacement's trailing whitespace.
/// Untouched text only has to stay inside some text node, because adjacent
/// text merges into one node.
fn check_surroundings(
    before: &Value,
    after: &Value,
    target: &str,
    range: (u64, u64),
    delta: i64,
    trailing_space: i64,
) -> Result<(), EditFailure> {
    let (start, end) = range;
    let after = positioned(after);
    let found = after
        .iter()
        .map(|node| format!("{}:{}:{}:{}", node.kind, node.start, node.end, node.facts))
        .collect::<std::collections::HashSet<_>>();
    let mut texts = after
        .iter()
        .filter(|node| node.kind == "text")
        .map(|node| (node.start as i64, node.end as i64))
        .collect::<Vec<_>>();
    texts.sort_unstable();
    let text_covers = |from: i64, to: i64| {
        let index = texts.partition_point(|(start, _)| *start <= from);
        index > 0 && texts[index - 1].1 >= to
    };
    let mut ends = std::collections::HashMap::<String, Vec<i64>>::new();
    for node in &after {
        ends.entry(format!("{}:{}:{}", node.kind, node.start, node.facts))
            .or_default()
            .push(node.end as i64);
    }
    for node in positioned(before) {
        let ancestor = target.starts_with(&format!("{}/", node.path));
        let outside = node.end <= start || node.start >= end;
        if (!ancestor && !outside) || (node.kind == "text" && !outside) {
            continue;
        }
        let shift = if node.start >= end { delta } else { 0 };
        let highest = node.end as i64 + delta;
        let lowest = if node.end == end {
            highest - trailing_space
        } else {
            highest
        };
        let present = if node.kind == "text" {
            text_covers(node.start as i64 + shift, node.end as i64 + shift)
        } else if ancestor {
            ends.get(&format!("{}:{}:{}", node.kind, node.start, node.facts))
                .is_some_and(|candidates| {
                    candidates.iter().any(|to| *to >= lowest && *to <= highest)
                })
        } else {
            found.contains(&format!(
                "{}:{}:{}:{}",
                node.kind,
                node.start as i64 + shift,
                node.end as i64 + shift,
                node.facts
            ))
        };
        if !present {
            return Err(EditFailure::Refusal(
                format!(
                    "The replacement changes how the rest of the document parses: the {} on line {} would not survive.",
                    node.kind, node.line
                ),
                json!({"reason": "surroundings-changed", "nodeType": node.kind, "line": node.line}),
            ));
        }
    }
    Ok(())
}

pub(crate) struct ReplaceRequest<'a> {
    pub selector: &'a AstSelectorInput,
    pub text: &'a str,
    pub scope: BlockScope,
    pub expected_sha256: Option<&'a str>,
    pub sha256: &'a str,
    pub include_source: bool,
}

pub(crate) fn replace_source(
    source: &str,
    request: ReplaceRequest<'_>,
) -> Result<Replacement, EditFailure> {
    let text = request.text;
    if text.len() > MAX_SOURCE_BYTES {
        return Err(format!("Replacement text exceeds the {MAX_SOURCE_BYTES}-byte limit.").into());
    }
    if request
        .expected_sha256
        .is_some_and(|expected| expected != request.sha256)
    {
        return Err(EditFailure::Refusal(
            "The source changed since it was read; expectedSha256 does not match.".into(),
            json!({"reason": "stale-source", "sha256": request.sha256}),
        ));
    }
    let ast = positioned_ast(source)?;
    validate_selector(request.selector)?;
    let selected = ast_nodes(&ast)
        .into_iter()
        .filter(|(path, node)| selector_matches(path, node, request.selector))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err("Selector did not match any AST node.".to_owned().into());
    }
    if selected.len() > 1 {
        return Err(format!(
            "Selector matched {} AST nodes; refine it before editing.",
            selected.len()
        )
        .into());
    }
    let (path, node) = &selected[0];
    let range = node_range(&ast, path, node, request.scope)?;
    let offsets = SourceOffsets::new(source);
    let start = offsets.byte(range.start)?;
    let end = offsets.byte(range.end)?;
    let original = &source[start..end];
    if original == text {
        return Err(
            "The replacement equals the selected source; nothing would change."
                .to_owned()
                .into(),
        );
    }
    let result = format!("{}{text}{}", &source[..start], &source[end..]);
    if result.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "Source is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
            result.len()
        )
        .into());
    }

    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    let after = positioned_ast(&result)?;
    let replaced = if path.is_empty() {
        Some(&after)
    } else {
        after.pointer(path)
    };
    let replaced_type = replaced
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str);
    let replaced_start = replaced
        .and_then(|value| value.get("pos"))
        .and_then(|pos| pos.get("startOffset"))
        .and_then(Value::as_u64);
    if replaced_type != Some(kind) || replaced_start != Some(range.start) {
        let actual = if replaced_start == Some(range.start) {
            replaced_type.map_or(Value::Null, |value| json!(value))
        } else {
            Value::Null
        };
        return Err(EditFailure::Refusal(
            format!("The replacement no longer parses as the selected {kind}."),
            json!({"reason": "node-kind-changed", "expected": kind, "actual": actual}),
        ));
    }
    let text_points = text.chars().count() as i64;
    let trailing_space = text_points
        - text
            .trim_end_matches([' ', '\t', '\r', '\n'])
            .chars()
            .count() as i64;
    check_surroundings(
        &ast,
        &after,
        path,
        (range.start, range.end),
        text_points - (range.end - range.start) as i64,
        trailing_space,
    )?;

    let unit_start = utf16_offset(source, start) as u64;
    let (introduced, resolved) = compare_findings(
        lint_values(source, &[]),
        lint_values(&result, &[]),
        unit_start,
        utf16_offset(source, end) as u64,
        unit_start + text.encode_utf16().count() as u64,
    );
    if !introduced.is_empty() {
        let listed = introduced
            .iter()
            .map(|finding| {
                format!(
                    "{} (line {})",
                    finding["rule"].as_str().unwrap_or_default(),
                    number(finding, "line")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(EditFailure::Refusal(
            format!("The replacement introduces lint findings: {listed}."),
            json!({"reason": "new-lint-findings", "introduced": introduced}),
        ));
    }

    let mut matched = json!({"path": path, "type": kind});
    if let Some(identity) = ast_identity(node) {
        matched["identity"] = json!(identity);
    }
    let mut output = json!({
        "match": matched,
        "sha256": request.sha256,
        "resultSha256": sha256_text(&result),
        "start": start,
        "end": end,
        "patch": splice_patch(source, start, end, text, "replace-source"),
        "undoPatch": splice_patch(&result, start, start + text.len(), original, "revert-replace-source"),
        "lint": {"introduced": [], "resolved": resolved},
    });
    if request.include_source {
        output["source"] = json!(result);
    }
    let bytes = serde_json::to_vec(&output)
        .map_err(|error| error.to_string())?
        .len();
    if bytes > MAX_SOURCE_BYTES {
        return Err(format!(
            "Source replacement is {bytes} bytes; the limit is {MAX_SOURCE_BYTES} bytes."
        )
        .into());
    }
    Ok(Replacement { output, result })
}
