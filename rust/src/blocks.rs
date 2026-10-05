use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::server::{
    AstSelectorInput, AstSelectorKind, MAX_AST_SELECTOR_MATCHES, MAX_SOURCE_BYTES, ast_identity,
    ast_nodes, selector_matches,
};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BlockScope {
    Node,
    Section,
}

pub(crate) fn sha256_text(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

pub(crate) fn validate_selector(selector: &AstSelectorInput) -> Result<(), String> {
    if selector.value.is_empty() {
        return Err("Selector value must not be empty.".into());
    }
    let maximum = if matches!(selector.kind, AstSelectorKind::AstPath) {
        4096
    } else {
        256
    };
    if selector.value.chars().count() > maximum {
        return Err(format!(
            "Selector value may contain at most {maximum} characters."
        ));
    }
    Ok(())
}

/// Engine positions count Unicode code points over the source as given, with
/// CRLF and a leading BOM intact; this maps them to UTF-8 byte offsets.
pub(crate) struct SourceOffsets<'a> {
    source: &'a str,
    bytes: Vec<usize>,
}

impl<'a> SourceOffsets<'a> {
    pub(crate) fn new(source: &'a str) -> Self {
        let mut bytes = source
            .char_indices()
            .map(|(byte, _)| byte)
            .collect::<Vec<_>>();
        bytes.push(source.len());
        Self { source, bytes }
    }

    pub(crate) fn code_points(&self) -> usize {
        self.bytes.len() - 1
    }

    pub(crate) fn byte(&self, point: u64) -> Result<usize, String> {
        usize::try_from(point)
            .ok()
            .and_then(|point| self.bytes.get(point).copied())
            .ok_or_else(|| "AST position lies outside the source.".into())
    }

    pub(crate) fn slice(&self, start: u64, end: u64) -> Result<&'a str, String> {
        Ok(&self.source[self.byte(start)?..self.byte(end)?])
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SourceRange {
    pub start: u64,
    pub end: u64,
    pub start_line: u64,
    pub end_line: u64,
}

fn position(node: &Map<String, Value>) -> Option<SourceRange> {
    let pos = node.get("pos")?.as_object()?;
    Some(SourceRange {
        start: pos.get("startOffset")?.as_u64()?,
        end: pos.get("endOffset")?.as_u64()?,
        start_line: pos.get("startLine").and_then(Value::as_u64).unwrap_or(0),
        end_line: pos.get("endLine").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn parent_array<'a>(ast: &'a Value, path: &str) -> Option<&'a Vec<Value>> {
    let separator = path.rfind('/')?;
    let part = &path[separator + 1..];
    if part.is_empty()
        || !part.bytes().all(|byte| byte.is_ascii_digit())
        || (part.len() > 1 && part.starts_with('0'))
    {
        return None;
    }
    let parent = if separator == 0 {
        ast
    } else {
        ast.pointer(&path[..separator])?
    };
    let parent = parent.as_array()?;
    (part.parse::<usize>().ok()? < parent.len()).then_some(parent)
}

/// A section runs from its heading to the last node before the next heading of
/// the same or a higher level in the same container.
pub(crate) fn node_range(
    ast: &Value,
    path: &str,
    node: &Map<String, Value>,
    scope: BlockScope,
) -> Result<SourceRange, String> {
    let own = position(node).ok_or_else(|| {
        format!(
            "The selected {} has no source position.",
            node.get("type").and_then(Value::as_str).unwrap_or_default()
        )
    })?;
    if scope == BlockScope::Node {
        return Ok(own);
    }
    if node.get("type").and_then(Value::as_str) != Some("heading") {
        return Err("scope \"section\" requires a heading.".into());
    }
    let siblings = parent_array(ast, path)
        .ok_or("The selected heading is not inside a container.")?
        .iter()
        .filter_map(|value| {
            let record = value.as_object()?;
            position(record).map(|pos| (record, pos))
        })
        .collect::<Vec<_>>();
    let level = node.get("level").and_then(Value::as_u64).unwrap_or(0);
    let boundary = siblings
        .iter()
        .filter(|(record, pos)| {
            record.get("type").and_then(Value::as_str) == Some("heading")
                && record.get("level").and_then(Value::as_u64).unwrap_or(0) <= level
                && pos.start > own.start
        })
        .map(|(_, pos)| pos.start)
        .min()
        .unwrap_or(u64::MAX);
    let mut last = own;
    for (_, pos) in &siblings {
        if pos.start >= own.start && pos.start < boundary && pos.end > last.end {
            last = *pos;
        }
    }
    Ok(SourceRange {
        start: own.start,
        end: last.end,
        start_line: own.start_line,
        end_line: last.end_line,
    })
}

pub(crate) fn positioned_ast(source: &str) -> Result<Value, String> {
    let options = carve::Options::default().with_positions(true);
    serde_json::from_str(&carve::to_json_with_options(source, &options))
        .map_err(|error| format!("AST serialization failed: {error}"))
}

pub(crate) fn get_blocks(
    source: &str,
    selector: &AstSelectorInput,
    scope: BlockScope,
    include_ast: bool,
    sha256: Option<&str>,
) -> Result<Value, String> {
    let ast = positioned_ast(source)?;
    validate_selector(selector)?;
    let offsets = SourceOffsets::new(source);
    let selected = ast_nodes(&ast)
        .into_iter()
        .filter(|(path, node)| selector_matches(path, node, selector))
        .collect::<Vec<_>>();
    let mut blocks = Vec::new();
    for (path, node) in selected.iter().take(MAX_AST_SELECTOR_MATCHES) {
        let range = node_range(&ast, path, node, scope)?;
        let mut block = json!({
            "path": path,
            "type": node.get("type").and_then(Value::as_str).unwrap_or_default(),
            "start": offsets.byte(range.start)?,
            "end": offsets.byte(range.end)?,
            "startLine": range.start_line,
            "endLine": range.end_line,
            "source": offsets.slice(range.start, range.end)?,
        });
        if let Some(identity) = ast_identity(node) {
            block["identity"] = json!(identity);
        }
        if include_ast {
            block["node"] = Value::Object((*node).clone());
        }
        blocks.push(block);
    }
    let output = json!({
        "sha256": sha256.map_or_else(|| sha256_text(source), str::to_owned),
        "sourceBytes": offsets.byte(offsets.code_points() as u64)?,
        "matchCount": selected.len(),
        "blocks": blocks,
        "truncated": selected.len() > MAX_AST_SELECTOR_MATCHES,
    });
    let bytes = serde_json::to_vec(&output)
        .map_err(|error| error.to_string())?
        .len();
    if bytes > MAX_SOURCE_BYTES {
        return Err(format!(
            "Block result is {bytes} bytes; the limit is {MAX_SOURCE_BYTES} bytes."
        ));
    }
    Ok(output)
}
