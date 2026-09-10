use carve::extensions::SemanticSpan;
use carve::{
    AsciiHeadingIds, Autolink, CheckedRenderOptions, HtmlImportOptions, LinkPolicy,
    MigrationConfidence, MigrationFidelity, Mode, Options, Profile, RenderLoss,
    RenderTarget as CarveRenderTarget, SmartTypographyMode, Wikilinks, lint_carve, migrate_djot,
    migrate_html, migrate_markdown, with_render_loss_report,
};
use regex::Regex;
use rmcp::{
    RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, CompleteRequestParams, CompleteResult, CompletionInfo, ContentBlock,
        ErrorData, GetPromptRequestParams, GetPromptResponse, GetPromptResult, Implementation,
        ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult,
        PaginatedRequestParams, Prompt, PromptMessage, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
        Role, ServerCapabilities, ServerInfo,
    },
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{resources, workspace::Workspace};

pub(crate) const MAX_SOURCE_BYTES: usize = 1_000_000;
const MAX_AST_PATCH_OPERATIONS: usize = 1_000;
const MAX_AST_SELECTOR_MATCHES: usize = 100;
const MAX_SEMANTIC_EDIT_STEPS: usize = 100;
const AST_CHILD_FIELDS: [&str; 9] = [
    "children",
    "items",
    "rows",
    "cells",
    "inline",
    "content",
    "caption",
    "shortCaption",
    "title",
];

fn ast_patch_path(operation: &carve::AstPatchOperation) -> &str {
    match operation {
        carve::AstPatchOperation::Add { path, .. }
        | carve::AstPatchOperation::Replace { path, .. }
        | carve::AstPatchOperation::Remove { path } => path,
    }
}

fn pointer(path: &str, part: &str) -> String {
    format!("{path}/{}", part.replace('~', "~0").replace('/', "~1"))
}

fn node_text(value: &Value) -> String {
    fn append(output: &mut String, value: &str) {
        let remaining = 121usize.saturating_sub(output.chars().count());
        output.extend(value.chars().take(remaining));
    }
    fn visit(value: &Value, output: &mut String) {
        if output.chars().count() >= 121 {
            return;
        }
        if let Some(values) = value.as_array() {
            for (index, child) in values.iter().enumerate() {
                if index > 0 {
                    append(output, " ");
                }
                visit(child, output);
            }
            return;
        }
        let Some(record) = value.as_object() else {
            return;
        };
        if record.get("type").and_then(Value::as_str) == Some("text")
            && let Some(value) = record.get("value").and_then(Value::as_str)
        {
            append(output, value);
        }
        for field in AST_CHILD_FIELDS {
            if let Some(child) = record.get(field) {
                visit(child, output);
            }
        }
    }
    let mut output = String::new();
    visit(value, &mut output);
    output
}

fn human_text(value: &str, maximum: usize) -> String {
    let mut output = String::new();
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() || character.is_control() || character == '\u{feff}' {
            pending_space = !output.is_empty();
            continue;
        }
        if pending_space {
            output.push(' ');
            pending_space = false;
        }
        output.push(character);
    }
    output.chars().take(maximum).collect()
}

fn node_identity(record: &serde_json::Map<String, Value>) -> Option<&str> {
    match record.get("type").and_then(Value::as_str) {
        Some("heading") => record.get("attrs")?.as_object()?.get("id")?.as_str(),
        Some("footnote") => record.get("label")?.as_str(),
        _ => None,
    }
}

fn ast_nodes<'a>(value: &'a Value) -> Vec<(String, &'a serde_json::Map<String, Value>)> {
    fn visit<'a>(
        value: &'a Value,
        path: String,
        nodes: &mut Vec<(String, &'a serde_json::Map<String, Value>)>,
    ) {
        if let Some(values) = value.as_array() {
            for (index, child) in values.iter().enumerate() {
                visit(child, pointer(&path, &index.to_string()), nodes);
            }
            return;
        }
        let Some(record) = value.as_object() else {
            return;
        };
        if record.get("type").and_then(Value::as_str).is_some() {
            nodes.push((path.clone(), record));
        }
        for key in AST_CHILD_FIELDS {
            if let Some(child) = record.get(key) {
                visit(child, pointer(&path, key), nodes);
            }
        }
    }
    let mut nodes = Vec::new();
    visit(value, String::new(), &mut nodes);
    nodes
}

fn selector_matches(
    path: &str,
    node: &serde_json::Map<String, Value>,
    selector: &AstSelectorInput,
) -> bool {
    match selector.kind {
        AstSelectorKind::AstPath => path == selector.value,
        AstSelectorKind::HeadingId => {
            node.get("type").and_then(Value::as_str) == Some("heading")
                && node_identity(node) == Some(selector.value.as_str())
        }
        AstSelectorKind::FootnoteLabel => {
            node.get("type").and_then(Value::as_str) == Some("footnote")
                && node_identity(node) == Some(selector.value.as_str())
        }
        AstSelectorKind::NodeType => {
            node.get("type").and_then(Value::as_str) == Some(selector.value.as_str())
        }
    }
}

fn ast_match(path: String, node: &serde_json::Map<String, Value>) -> Value {
    let full_preview = human_text(&node_text(&Value::Object(node.clone())), 121);
    let identity = node_identity(node)
        .map(|value| human_text(value, 80))
        .filter(|value| !value.is_empty());
    serde_json::to_value(AstSelectorMatchOutputSchema {
        path,
        r#type: node
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        identity,
        preview: full_preview.chars().take(120).collect(),
        preview_truncated: full_preview.chars().count() > 120,
    })
    .expect("AST match output is serializable")
}

fn apply_semantic_ast_edit(
    ast: &mut Value,
    path: &str,
    edit: &SemanticAstEditInput,
) -> Result<(), String> {
    let selected_type = ast
        .pointer(path)
        .and_then(Value::as_object)
        .and_then(|node| node.get("type"))
        .and_then(Value::as_str)
        .ok_or("Selected AST node no longer exists.")?;
    match edit.kind {
        SemanticAstEditKind::ReplaceText if !matches!(selected_type, "heading" | "paragraph") => {
            return Err("replace-text supports heading and paragraph nodes.".into());
        }
        SemanticAstEditKind::RenameHeadingId if selected_type != "heading" => {
            return Err("rename-heading-id requires a heading node.".into());
        }
        _ => {}
    }
    if matches!(edit.kind, SemanticAstEditKind::RenameHeadingId) {
        let id = edit.id.as_deref().ok_or("rename-heading-id requires id.")?;
        if id.is_empty() || id.chars().count() > 256 {
            return Err("Heading ID must contain 1 to 256 characters.".into());
        }
        if human_text(id, 257) != id {
            return Err("Heading ID must not contain control characters or surrounding or repeated whitespace.".into());
        }
    }

    if matches!(
        edit.kind,
        SemanticAstEditKind::ReplaceText | SemanticAstEditKind::RenameHeadingId
    ) {
        let node = ast
            .pointer_mut(path)
            .and_then(Value::as_object_mut)
            .ok_or("Selected AST node no longer exists.")?;
        match edit.kind {
            SemanticAstEditKind::ReplaceText => {
                let text = edit.text.as_deref().ok_or("replace-text requires text.")?;
                if text.len() > MAX_SOURCE_BYTES {
                    return Err(format!(
                        "Replacement text exceeds the {MAX_SOURCE_BYTES}-byte limit."
                    ));
                }
                if text
                    .chars()
                    .any(|character| matches!(character, '\r' | '\n' | '\u{2028}' | '\u{2029}'))
                {
                    return Err(
                        "replace-text accepts one text block and must not contain line breaks."
                            .into(),
                    );
                }
                node.insert(
                    "children".into(),
                    Value::Array(vec![json!({"type": "text", "value": text})]),
                );
            }
            SemanticAstEditKind::RenameHeadingId => {
                let attrs = node
                    .entry("attrs")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or("Heading attrs must be an object.")?;
                attrs.insert("id".into(), Value::String(edit.id.clone().unwrap()));
            }
            _ => unreachable!(),
        }
        return Ok(());
    }

    let (parent_path, raw_index) = path.rsplit_once('/').ok_or_else(|| {
        format!(
            "{} requires a node contained in an AST array.",
            edit.kind.name()
        )
    })?;
    if !(raw_index == "0"
        || (!raw_index.starts_with('0') && raw_index.bytes().all(|byte| byte.is_ascii_digit())))
    {
        return Err(format!(
            "{} requires a node contained in an AST array.",
            edit.kind.name()
        ));
    }
    let index = raw_index.parse::<usize>().map_err(|_| {
        format!(
            "{} requires a node contained in an AST array.",
            edit.kind.name()
        )
    })?;
    if !ast
        .pointer(parent_path)
        .and_then(Value::as_array)
        .is_some_and(|values| index < values.len())
    {
        return Err(format!(
            "{} requires a node contained in an AST array.",
            edit.kind.name()
        ));
    }
    if matches!(
        edit.kind,
        SemanticAstEditKind::ReplaceNode
            | SemanticAstEditKind::InsertBefore
            | SemanticAstEditKind::InsertAfter
    ) {
        let node = edit.node.as_ref().ok_or_else(|| {
            format!(
                "{} requires node.",
                if matches!(edit.kind, SemanticAstEditKind::ReplaceNode) {
                    "replace-node"
                } else {
                    edit.kind.name()
                }
            )
        })?;
        let bytes = serde_json::to_vec(node)
            .map_err(|error| error.to_string())?
            .len();
        if bytes > MAX_SOURCE_BYTES {
            return Err(format!(
                "{} node is {bytes} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                if matches!(edit.kind, SemanticAstEditKind::ReplaceNode) {
                    "Replacement"
                } else {
                    "Inserted"
                }
            ));
        }
    }
    let parent = ast
        .pointer_mut(parent_path)
        .and_then(Value::as_array_mut)
        .expect("validated AST array location");
    match edit.kind {
        SemanticAstEditKind::DeleteNode => {
            parent.remove(index);
        }
        SemanticAstEditKind::ReplaceNode => {
            parent[index] = edit.node.clone().ok_or("replace-node requires node.")?;
        }
        SemanticAstEditKind::InsertBefore | SemanticAstEditKind::InsertAfter => {
            let node = edit
                .node
                .clone()
                .ok_or_else(|| format!("{} requires node.", edit.kind.name()))?;
            let offset = usize::from(matches!(edit.kind, SemanticAstEditKind::InsertAfter));
            parent.insert(index + offset, node);
        }
        _ => unreachable!(),
    }
    Ok(())
}

impl SemanticAstEditKind {
    fn name(self) -> &'static str {
        match self {
            Self::ReplaceText => "replace-text",
            Self::RenameHeadingId => "rename-heading-id",
            Self::DeleteNode => "delete-node",
            Self::ReplaceNode => "replace-node",
            Self::InsertBefore => "insert-before",
            Self::InsertAfter => "insert-after",
        }
    }
}

fn validate_semantic_edit_shape(edit: &SemanticAstEditInput) -> Result<(), String> {
    let mut unexpected = Vec::new();
    if edit.text.is_some() && !matches!(edit.kind, SemanticAstEditKind::ReplaceText) {
        unexpected.push("text");
    }
    if edit.id.is_some() && !matches!(edit.kind, SemanticAstEditKind::RenameHeadingId) {
        unexpected.push("id");
    }
    if edit.node.is_some()
        && !matches!(
            edit.kind,
            SemanticAstEditKind::ReplaceNode
                | SemanticAstEditKind::InsertBefore
                | SemanticAstEditKind::InsertAfter
        )
    {
        unexpected.push("node");
    }
    if unexpected.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} does not accept {}.",
            edit.kind.name(),
            unexpected.join(", ")
        ))
    }
}

fn semantic_edit_notices(
    node: &serde_json::Map<String, Value>,
    edit: &SemanticAstEditInput,
) -> Vec<String> {
    if !matches!(edit.kind, SemanticAstEditKind::ReplaceText) {
        return Vec::new();
    }
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("node");
    let formatting = format!("replace-text replaces inline formatting inside the {node_type}.");
    node_identity(node)
        .map(|identity| human_text(identity, 80))
        .filter(|identity| !identity.is_empty())
        .map(|identity| {
            vec![
                format!("Preserved heading ID “{identity}”."),
                formatting.clone(),
            ]
        })
        .unwrap_or_else(|| vec![formatting])
}

fn semantic_edit_is_structural(edit: &SemanticAstEditInput) -> bool {
    !matches!(
        edit.kind,
        SemanticAstEditKind::ReplaceText | SemanticAstEditKind::RenameHeadingId
    )
}

fn ast_paths_overlap(left: &str, right: &str) -> bool {
    left == right
        || left.is_empty()
        || right.is_empty()
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn compare_structural_paths(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = left.split('/').collect::<Vec<_>>();
    let right_parts = right.split('/').collect::<Vec<_>>();
    right_parts.len().cmp(&left_parts.len()).then_with(|| {
        let left_parent = left.rsplit_once('/').map(|value| value.0).unwrap_or("");
        let right_parent = right.rsplit_once('/').map(|value| value.0).unwrap_or("");
        if left_parent == right_parent {
            let left_index = left_parts
                .last()
                .and_then(|value| value.parse::<usize>().ok());
            let right_index = right_parts
                .last()
                .and_then(|value| value.parse::<usize>().ok());
            right_index.cmp(&left_index)
        } else {
            right.cmp(left)
        }
    })
}

fn heading_id_counts(ast: &Value) -> std::collections::BTreeMap<String, usize> {
    let mut counts = std::collections::BTreeMap::new();
    for (_, node) in ast_nodes(ast) {
        if node.get("type").and_then(Value::as_str) != Some("heading") {
            continue;
        }
        let Some(id) = node_identity(node).filter(|id| !id.is_empty()) else {
            continue;
        };
        *counts.entry(id.to_owned()).or_insert(0) += 1;
    }
    counts
}

fn validate_no_new_heading_id_collisions(before: &Value, after: &Value) -> Result<(), String> {
    let before_counts = heading_id_counts(before);
    for (id, count) in heading_id_counts(after) {
        if count > 1 && count > before_counts.get(&id).copied().unwrap_or(0) {
            return Err(format!(
                "Heading ID “{}” is already in use.",
                human_text(&id, 80)
            ));
        }
    }
    Ok(())
}

fn semantic_ast(value: &Value, strip_metadata: bool) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| semantic_ast(value, strip_metadata))
                .collect(),
        ),
        Value::Object(record) => Value::Object(
            record
                .iter()
                .filter(|(key, _)| {
                    !strip_metadata || (key.as_str() != "pos" && key.as_str() != "srcByteLength")
                })
                .map(|(key, value)| {
                    (
                        key.clone(),
                        semantic_ast(value, strip_metadata && key != "keyValues"),
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn explain_ast_operations(
    ast: &Value,
    operations: &[carve::AstPatchOperation],
) -> Vec<PatchChangeOutputSchema> {
    let mut nodes = ast_nodes(ast);
    nodes.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
    operations
        .iter()
        .map(|operation| {
            let path = ast_patch_path(operation);
            let ancestors = nodes.iter().filter(|(node_path, _)| {
                node_path.is_empty()
                    || path == node_path
                    || path
                        .strip_prefix(node_path)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            });
            let owner = ancestors
                .clone()
                .find(|(_, node)| node_identity(node).is_some())
                .or_else(|| {
                    ancestors
                        .clone()
                        .find(|(_, node)| node.get("type").and_then(Value::as_str) != Some("text"))
                })
                .or_else(|| ancestors.into_iter().next());
            let (owner_type, identity) = owner
                .map(|(_, node)| {
                    (
                        node.get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("document"),
                        node_identity(node),
                    )
                })
                .unwrap_or(("document", None));
            let identity = identity
                .map(|identity| human_text(identity, 80))
                .filter(|identity| !identity.is_empty());
            let target = identity
                .map(|identity| format!("{owner_type} “{identity}”"))
                .unwrap_or_else(|| owner_type.into());
            let field = path
                .rsplit('/')
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or("document")
                .replace("~1", "/")
                .replace("~0", "~");
            let (mut kind, verb) = match operation {
                carve::AstPatchOperation::Add { .. } => (PatchChangeKind::Add, "Added"),
                carve::AstPatchOperation::Remove { .. } => (PatchChangeKind::Remove, "Removed"),
                carve::AstPatchOperation::Replace { .. } => (PatchChangeKind::Replace, "Changed"),
            };
            let mut summary = if field == "value" && owner.is_some() {
                format!("Changed text in {target}.")
            } else {
                format!("{verb} {field} on {target}.")
            };
            if let carve::AstPatchOperation::Replace { value, .. } = operation
                && let Ok(after_value) = serde_json::from_str::<Value>(value)
                && let (Some(before), Some(after)) = (
                    value_at_pointer(ast, path).and_then(Value::as_array),
                    after_value.as_array(),
                )
                && before.len() != after.len()
                && (is_subsequence(before, after) || is_subsequence(after, before))
            {
                let count = before.len().abs_diff(after.len());
                let noun = if count == 1 { "item" } else { "items" };
                if after.len() > before.len() {
                    kind = PatchChangeKind::Add;
                    summary = format!("Added {count} {noun} in {target}.");
                } else {
                    kind = PatchChangeKind::Remove;
                    summary = format!("Removed {count} {noun} in {target}.");
                }
            }
            PatchChangeOutputSchema {
                kind,
                path: path.into(),
                target,
                summary,
                extra: std::collections::BTreeMap::new(),
            }
        })
        .collect()
}

fn value_at_pointer<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(value);
    }
    value.pointer(path)
}

fn is_subsequence(shorter: &[Value], longer: &[Value]) -> bool {
    if shorter.len() > longer.len() {
        return false;
    }
    let mut index = 0;
    for value in longer {
        if index < shorter.len() && semantic_ast_equal(&shorter[index], value) {
            index += 1;
        }
    }
    index == shorter.len()
}

fn semantic_ast_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| semantic_ast_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            let relevant = |key: &&String| key.as_str() != "pos" && key.as_str() != "srcByteLength";
            left.keys().filter(relevant).count() == right.keys().filter(relevant).count()
                && left
                    .iter()
                    .filter(|(key, _)| relevant(key))
                    .all(|(key, value)| {
                        right
                            .get(key)
                            .is_some_and(|other| semantic_ast_equal(value, other))
                    })
        }
        _ => left == right,
    }
}

#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LintOutputSchema {
    valid: bool,
    warning_count: i64,
    warnings: Vec<Value>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DiagnosticFixOutputSchema {
    valid: bool,
    warning_count: i64,
    warnings: Vec<Value>,
    fixes: Vec<Value>,
    applied_fix_ids: Vec<String>,
    value: String,
    remaining_warning_count: i64,
    remaining_valid: bool,
    patch: SourcePatchOutputSchema,
    undo_patch: SourcePatchOutputSchema,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenderOutputSchema {
    value: String,
    losses: Vec<Value>,
    total_losses: i64,
    truncated: bool,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CompatibilityOutputSchema {
    compatible: bool,
    target_count: i64,
    summary: CompatibilitySummarySchema,
    targets: Vec<Value>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CompatibilitySummarySchema {
    compatible: i64,
    warning: i64,
    lossy: i64,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ParseOutputSchema {
    r#type: String,
    children: Vec<Value>,
    src_byte_length: i64,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AstPatchCreateOutputSchema {
    operations: Vec<Value>,
    operation_count: i64,
    changes: Vec<PatchChangeOutputSchema>,
    change_count: i64,
}
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum PatchChangeKind {
    Add,
    Remove,
    Replace,
}
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
struct PatchChangeOutputSchema {
    kind: PatchChangeKind,
    path: String,
    target: String,
    summary: String,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, Value>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct AstPatchApplyOutputSchema {
    ast: Value,
    source: String,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReversibleAstPatchOutputSchema {
    version: i64,
    forward: Vec<Value>,
    inverse: Vec<Value>,
    before_fingerprint: String,
    after_fingerprint: String,
    changes: Vec<PatchChangeOutputSchema>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AstSelectionOutputSchema {
    selector: AstSelectorInput,
    match_count: i64,
    matches: Vec<AstSelectorMatchOutputSchema>,
    truncated: bool,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct AstSelectorMatchOutputSchema {
    path: String,
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    preview: String,
    #[serde(rename = "previewTruncated")]
    preview_truncated: bool,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SemanticAstEditPlanOutputSchema {
    selector: AstSelectorInput,
    edit: SemanticAstEditSummaryOutputSchema,
    r#match: AstSelectorMatchOutputSchema,
    notices: Vec<String>,
    edit_count: i64,
    steps: Vec<SemanticAstEditStepOutputSchema>,
    reversible_patch: ReversibleAstPatchOutputSchema,
    source_patch: SourcePatchOutputSchema,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct SemanticAstEditSummaryOutputSchema {
    kind: SemanticAstEditKind,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct SemanticAstEditStepOutputSchema {
    selector: AstSelectorInput,
    edit: SemanticAstEditSummaryOutputSchema,
    r#match: AstSelectorMatchOutputSchema,
    notices: Vec<String>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReversibleAstPatchApplyOutputSchema {
    direction: String,
    ast: Value,
    source: String,
    source_patch: SourcePatchOutputSchema,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct MigrateOutputSchema {
    value: String,
    report: MigrationReportOutputSchema,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MigrationReportOutputSchema {
    schema_version: i64,
    source_format: String,
    diagnostics: Vec<Value>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadOutputSchema {
    root_index: i64,
    path: String,
    content: String,
    sha256: String,
    bytes: i64,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListOutputSchema {
    root_index: i64,
    files: Vec<String>,
    truncated: bool,
    max_depth: i64,
    limit: i64,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfoOutputSchema {
    roots: Vec<Value>,
    allow_write: bool,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WriteOutputSchema {
    root_index: i64,
    path: String,
    dry_run: bool,
    created: bool,
    current_sha256: Option<String>,
    sha256: String,
    bytes: i64,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EditOutputSchema {
    root_index: i64,
    path: String,
    expected_sha256: String,
    changed: bool,
    proposed_content: String,
    unified_diff: String,
    diff_truncated: bool,
    patch: Option<SourcePatchOutputSchema>,
    losses: Vec<Value>,
    total_losses: i64,
    truncated: bool,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SourcePatchOutputSchema {
    version: i64,
    source_fingerprint: String,
    source_bytes: i64,
    edits: Vec<SourceEditOutputSchema>,
    unresolved: Vec<SourceSuggestionOutputSchema>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SourceEditOutputSchema {
    start: i64,
    end: i64,
    replacement: String,
    kind: SourceEditKindOutputSchema,
    code: String,
}
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum SourceEditKindOutputSchema {
    Formatting,
    SyntaxMigration,
    QuickFix,
    Refactor,
}

fn source_patch(source: &str, replacement: &str) -> SourcePatchOutputSchema {
    source_patch_with_kind(
        source,
        replacement,
        SourceEditKindOutputSchema::Formatting,
        "canonical-format",
    )
}

fn source_patch_with_kind(
    source: &str,
    replacement: &str,
    kind: SourceEditKindOutputSchema,
    code: &str,
) -> SourcePatchOutputSchema {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in source.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let before = source.as_bytes();
    let after = replacement.as_bytes();
    let mut start = before.iter().zip(after).take_while(|(a, b)| a == b).count();
    while start > 0 && (!source.is_char_boundary(start) || !replacement.is_char_boundary(start)) {
        start -= 1;
    }
    let (mut old_end, mut new_end) = (before.len(), after.len());
    while old_end > start && new_end > start && before[old_end - 1] == after[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    while !source.is_char_boundary(old_end) || !replacement.is_char_boundary(new_end) {
        old_end += 1;
        new_end += 1;
    }
    let edits = if source == replacement {
        Vec::new()
    } else {
        vec![SourceEditOutputSchema {
            start: start as i64,
            end: old_end as i64,
            replacement: replacement[start..new_end].into(),
            kind,
            code: code.into(),
        }]
    };
    SourcePatchOutputSchema {
        version: 1,
        source_fingerprint: format!("fnv1a64:{hash:016x}"),
        source_bytes: source.len() as i64,
        edits,
        unresolved: Vec::new(),
    }
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SourceSuggestionOutputSchema {
    start: i64,
    end: i64,
    replacement: String,
    kind: SourceEditKindOutputSchema,
    code: String,
    message: String,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BatchEditOutputSchema {
    root_index: i64,
    files_discovered: i64,
    files_prepared: i64,
    files_changed: i64,
    error_count: i64,
    items: Vec<Value>,
    truncated: bool,
    total_bytes: i64,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReviewOutputSchema {
    root_index: i64,
    valid: bool,
    files_discovered: i64,
    files_checked: i64,
    warning_count: i64,
    rule_counts: std::collections::BTreeMap<String, i64>,
    summary: Value,
    fix_plan: Value,
    files: Vec<Value>,
    project_warnings: Vec<Value>,
    truncated: bool,
    total_bytes: i64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathInput {
    root_index: usize,
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceListInput {
    root_index: usize,
    #[serde(default = "default_max_depth")]
    max_depth: usize,
    #[serde(default = "default_file_limit")]
    limit: usize,
}
fn default_max_depth() -> usize {
    10
}
fn default_file_limit() -> usize {
    500
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceReviewInput {
    root_index: usize,
    #[serde(default)]
    max_depth: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    platforms: Option<Vec<LintPlatform>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBatchEditInput {
    root_index: usize,
    #[serde(default)]
    #[schemars(length(max = 100))]
    paths: Option<Vec<String>>,
    #[serde(default = "default_max_depth")]
    #[schemars(range(max = 25))]
    max_depth: usize,
    #[serde(default = "default_batch_limit")]
    #[schemars(range(min = 1, max = 100))]
    limit: usize,
    #[serde(default = "default_diff_bytes")]
    #[schemars(range(min = 1000, max = 200000))]
    max_diff_bytes: usize,
    #[serde(default)]
    include_content: bool,
}

fn default_batch_limit() -> usize {
    100
}
fn default_diff_bytes() -> usize {
    100_000
}

fn diff_path(path: &str) -> String {
    path.chars()
        .map(|value| if !value.is_control() { value } else { '?' })
        .collect()
}

fn unified_diff(path: &str, before: &str, after: &str, maximum_bytes: usize) -> (String, bool) {
    if before == after {
        return (String::new(), false);
    }
    let diff = similar::TextDiff::from_lines(before, after);
    let value = diff
        .unified_diff()
        .context_radius(3)
        .header(
            &format!("a/{}", diff_path(path)),
            &format!("b/{}", diff_path(path)),
        )
        .to_string();
    if value.len() <= maximum_bytes {
        return (value, false);
    }
    let mut end = maximum_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}\n... diff truncated ...\n", &value[..end]), true)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWriteInput {
    root_index: usize,
    path: String,
    content: String,
    #[serde(default)]
    expected_sha256: Option<String>,
    #[serde(default = "default_true")]
    dry_run: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SourceInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AstPatchCreateInput {
    #[schemars(description = "PART 12 AST before the edit (maximum 1000000 JSON bytes)")]
    before: Value,
    #[schemars(description = "PART 12 AST after the edit (maximum 1000000 JSON bytes)")]
    after: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AstPatchApplyInput {
    #[schemars(description = "PART 12 base AST (maximum 1000000 JSON bytes)")]
    ast: Value,
    #[schemars(
        length(max = 1000),
        description = "Structured patch operations (maximum 1000 operations and 1000000 JSON bytes)"
    )]
    operations: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReversibleAstPatchInput {
    version: u8,
    #[schemars(length(max = 1000))]
    forward: Vec<Value>,
    #[schemars(length(max = 1000))]
    inverse: Vec<Value>,
    before_fingerprint: String,
    after_fingerprint: String,
    #[serde(default)]
    changes: Option<Vec<PatchChangeOutputSchema>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum AstSelectorKind {
    HeadingId,
    FootnoteLabel,
    NodeType,
    AstPath,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum SemanticAstEditKind {
    ReplaceText,
    RenameHeadingId,
    DeleteNode,
    ReplaceNode,
    InsertBefore,
    InsertAfter,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SemanticAstEditInput {
    kind: SemanticAstEditKind,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    node: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SemanticAstEditStepInput {
    selector: AstSelectorInput,
    edit: SemanticAstEditInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AstSelectorInput {
    kind: AstSelectorKind,
    #[schemars(length(min = 1, max = 4096))]
    value: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AstSelectInput {
    #[schemars(description = "PART 12 AST (maximum 1000000 JSON bytes)")]
    ast: Value,
    selector: AstSelectorInput,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SemanticAstEditPlanInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    selector: AstSelectorInput,
    edit: SemanticAstEditInput,
    #[serde(default)]
    #[schemars(
        length(max = 99),
        default,
        description = "Additional atomic edits resolved against the original source (maximum 100 total steps)."
    )]
    then: Vec<SemanticAstEditStepInput>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ReversibleAstPatchApplyInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    #[schemars(
        description = "Version 1 reversible AST patch (maximum 1000000 JSON bytes and 1000 operations per direction)"
    )]
    patch: ReversibleAstPatchInput,
    #[serde(default)]
    #[schemars(default, description = "Apply inverse operations to undo the patch.")]
    inverse: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LintInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    #[serde(default)]
    #[schemars(default = "empty_platforms")]
    platforms: Vec<LintPlatform>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct DiagnosticFixInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    #[serde(default)]
    #[schemars(default = "empty_platforms")]
    platforms: Vec<LintPlatform>,
    #[serde(default)]
    #[schemars(default, length(max = 100))]
    apply_fix_ids: Vec<String>,
}

fn empty_platforms() -> Vec<LintPlatform> {
    Vec::new()
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LintPlatform {
    Github,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum RenderTarget {
    Html,
    Markdown,
    Plain,
    Ansi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum CompatibilityTarget {
    Html,
    Markdown,
    Plain,
    Ansi,
    Github,
    Wordpress,
    Pdf,
}

fn default_compatibility_targets() -> Vec<CompatibilityTarget> {
    vec![
        CompatibilityTarget::Html,
        CompatibilityTarget::Markdown,
        CompatibilityTarget::Github,
        CompatibilityTarget::Wordpress,
        CompatibilityTarget::Pdf,
    ]
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct CompatibilityInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    #[serde(default = "default_compatibility_targets")]
    #[schemars(default = "default_compatibility_targets", length(min = 1, max = 7))]
    targets: Vec<CompatibilityTarget>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum RenderPreset {
    #[default]
    Default,
    Portable,
    StaticHtml,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum AsciiMode {
    Off,
    Fold,
    Strict,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum TypographyMode {
    Glyph,
    Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
enum ExtensionName {
    Autolink,
    SemanticSpans,
    Wikilinks,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum SourceFormat {
    Html,
    Markdown,
    Djot,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenderInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    target: RenderTarget,
    #[serde(default)]
    #[schemars(
        default = "default_render_preset",
        description = "portable lowercases IDs and transliterates where possible; static-html is HTML-only."
    )]
    preset: RenderPreset,
    #[serde(default)]
    #[schemars(description = "Heading ID policy; explicit values override the preset.")]
    ascii_heading_ids: Option<AsciiMode>,
    #[serde(default)]
    #[schemars(
        description = "Lowercase generated heading IDs; explicit values override the preset."
    )]
    lowercase_heading_ids: Option<bool>,
    #[serde(default)]
    #[schemars(
        default,
        description = "Fail instead of returning output when a raw-format node would be dropped."
    )]
    strict_losses: bool,
    #[serde(default)]
    #[schemars(
        range(min = 0, max = 10000),
        description = "Maximum detailed losses to return."
    )]
    max_render_losses: Option<usize>,
    #[serde(default)]
    #[schemars(description = "Render typographic glyphs or the punctuation the author typed.")]
    smart_typography: Option<TypographyMode>,
    #[serde(default)]
    #[schemars(
        default = "empty_extensions",
        length(max = 3),
        description = "Opt-in extensions; semantic-spans is HTML-only."
    )]
    extensions: Vec<ExtensionName>,
    #[serde(default)]
    #[schemars(
        default,
        description = "Pass trusted raw HTML through on HTML output. Disabled by default."
    )]
    allow_raw_html: bool,
    #[serde(default = "default_true")]
    #[schemars(
        default = "default_true",
        description = "Block dangerous authored URL schemes. Keep enabled for untrusted input."
    )]
    sanitize_urls: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MigrateInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    format: SourceFormat,
    #[serde(default)]
    #[schemars(description = "Opt-in Markdown flavor constructs; valid only for Markdown input.")]
    markdown_dialect: Option<MarkdownDialect>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkdownDialect {
    #[serde(default)]
    highlight: bool,
    #[serde(default)]
    superscript: bool,
    #[serde(default)]
    math: bool,
    #[serde(default)]
    inline_footnotes: bool,
    #[serde(default)]
    abbreviations: bool,
    #[serde(default)]
    fenced_divs: bool,
    #[serde(default)]
    attributes: bool,
}

fn default_true() -> bool {
    true
}

fn default_render_preset() -> RenderPreset {
    RenderPreset::Default
}

fn empty_extensions() -> Vec<ExtensionName> {
    Vec::new()
}

fn writer_prompts() -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    vec![
        (
            "review-document",
            "Review a Carve document",
            "Review a Carve document for clear, correct, human-focused writing.",
            "Review the supplied Carve document. Run carve_lint first. Explain issues in plain language, distinguish safe formatting from changes that require author judgment, preserve the author's voice, and do not write without showing the proposed result first.",
        ),
        (
            "convert-markdown",
            "Convert Markdown safely",
            "Convert Markdown to Carve while explaining fidelity warnings.",
            "Convert the supplied Markdown with carve_migrate. Explain fidelity diagnostics in plain language, preserve meaning and structure, then lint the converted Carve. Do not hide dropped or degraded content.",
        ),
        (
            "prepare-for-github",
            "Prepare writing for GitHub",
            "Check a Carve document for GitHub-specific publishing surprises.",
            "Prepare the supplied Carve document for GitHub. Lint with the github platform enabled, explain anything GitHub may relink or render unexpectedly, and show proposed changes before applying them.",
        ),
        (
            "explain-warnings",
            "Explain Carve warnings",
            "Turn Carve diagnostics into concise, actionable writing guidance.",
            "Explain the supplied Carve warnings for a human writer. Use each carve://lint-rules/{ruleName} resource when useful. Say what readers would experience, identify safe fixes, and present ambiguous choices without silently choosing one.",
        ),
        (
            "preview-document",
            "Preview a Carve document",
            "Render and assess a document without changing its source.",
            "Preview the supplied Carve document in the requested target. Report rendering losses and important accessibility or readability concerns. Do not modify the source.",
        ),
        (
            "review-workspace",
            "Review a documentation folder",
            "Review an authorized documentation workspace as a bounded project.",
            "Review the authorized documentation workspace with carve_review_workspace. Prioritize problems that affect readers, group repeated diagnostics, call out broken local links and anchors, and propose a small ordered change set. Do not write files without previewing and receiving approval.",
        ),
    ]
}

fn migration_json(result: carve::MigrationResult, format: SourceFormat) -> Value {
    let format = match format {
        SourceFormat::Html => "html",
        SourceFormat::Markdown => "markdown",
        SourceFormat::Djot => "djot",
    };
    json!({
        "value": result.value,
        "report": {
            "schemaVersion": result.report.schema_version,
            "sourceFormat": format,
            "diagnostics": result.report.diagnostics.into_iter().map(|item| json!({
                "code": item.code, "message": item.message,
                "severity": item.severity.as_str(),
                "fidelity": match item.fidelity {
                    MigrationFidelity::Carried => "carried",
                    MigrationFidelity::Degraded => "degraded",
                    MigrationFidelity::Dropped => "dropped",
                },
                "confidence": match item.confidence {
                    MigrationConfidence::Exact => "exact",
                    MigrationConfidence::Inferred => "inferred",
                    MigrationConfidence::Fallback => "fallback",
                },
                "path": item.path,
            })).collect::<Vec<_>>(),
        }
    })
}

fn migrate_markdown_dialect(
    source: &str,
    dialect: Option<&MarkdownDialect>,
) -> carve::MigrationResult {
    let default = MarkdownDialect::default();
    let dialect = dialect.unwrap_or(&default);
    let mut value = source.to_owned();
    let mut replacements: Vec<String> = Vec::new();
    let mut token_prefix = "CARVEMCPDIALECTTOKEN".to_owned();
    while source.contains(&token_prefix) {
        token_prefix.push('_');
    }
    let mut protect = |pattern: &str, replacement: &dyn Fn(&regex::Captures<'_>) -> String| {
        value = Regex::new(pattern)
            .unwrap()
            .replace_all(&value, |caps: &regex::Captures<'_>| {
                let token = format!("{token_prefix}{}X", replacements.len());
                replacements.push(replacement(caps));
                token
            })
            .into_owned();
    };
    // Dialect extensions are prose syntax. Keep literal code opaque while the
    // standard Markdown migration and extension rewrites run.
    protect(r"(?ms)^(```+|~~~+)[^\n]*\n.*?^(?:```+|~~~+)[ \t]*$", &|c| {
        c[0].to_owned()
    });
    protect(r"`+[^`\n]*`+", &|c| c[0].to_owned());
    if dialect.highlight {
        protect(r"==([^=\n]+)==", &|c| format!("={}=", &c[1]));
    }
    if dialect.superscript {
        protect(r"\^([^\^\n]+)\^", &|c| format!("{{^{0}^}}", &c[1]));
    }
    if dialect.math {
        protect(r"\$([^$\n]+)\$", &|c| format!("$`{}`", &c[1]));
    }
    if dialect.inline_footnotes {
        protect(r"\^\[([^\]\n]+)\]", &|c| format!("^[{}]", &c[1]));
    } else {
        protect(r"\^\[([^\]\n]+)\]", &|c| format!("\\^[{}]", &c[1]));
    }
    if dialect.abbreviations {
        protect(r"(?m)^\*\[([^\]]+)\]:(.*)$", &|c| c[0].to_owned());
    } else {
        protect(r"(?m)^\*\[([^\]]+)\]:(.*)$", &|c| format!("\\{}", &c[0]));
    }
    if dialect.fenced_divs {
        protect(r"(?m)^:::(.*)$", &|c| c[0].to_owned());
    } else {
        protect(r"(?m)^:::(.*)$", &|c| format!("\\{}", &c[0]));
    }
    if dialect.attributes {
        protect(r"(\[[^\]\n]+\])\{([^{}\n]+)\}", &|c| c[0].to_owned());
    } else {
        protect(r"(\[[^\]\n]+\])\{([^{}\n]+)\}", &|c| {
            format!("{}\\{{{}}}", &c[1], &c[2])
        });
    }
    let mut result = migrate_markdown(&value);
    for (index, replacement) in replacements.into_iter().enumerate() {
        result.value = result
            .value
            .replace(&format!("{token_prefix}{index}X"), &replacement);
    }
    if result.value.ends_with('\n') {
        result.value.pop();
    }
    result
}

fn utf16_offset(source: &str, byte: usize) -> usize {
    let mut boundary = byte.min(source.len());
    while !source.is_char_boundary(boundary) {
        boundary -= 1;
    }
    source[..boundary].encode_utf16().count()
}

fn byte_offset_from_utf16(source: &str, offset: usize) -> usize {
    let mut units = 0;
    for (byte, character) in source.char_indices() {
        if units >= offset {
            return byte;
        }
        units += character.len_utf16();
    }
    source.len()
}

pub(crate) fn lint_values(source: &str, platforms: &[LintPlatform]) -> Vec<Value> {
    let mut warnings: Vec<Value> = lint_carve(source)
        .into_iter()
        .map(|warning| {
            json!({
                "line": warning.line, "column": warning.column, "rule": warning.rule,
                "message": warning.message, "start": utf16_offset(source, warning.start),
                "end": utf16_offset(source, warning.end), "resourceUri": format!("carve://lint-rules/{}", warning.rule),
            })
        })
        .collect();
    if !platforms.is_empty() {
        let mention = Regex::new(r"@[A-Za-z0-9_][A-Za-z0-9_.-]*").unwrap();
        let issue = Regex::new(r"#[0-9]+").unwrap();
        let mut offset = 0usize;
        let mut fenced: Option<char> = None;
        for (line_index, line) in source.split('\n').enumerate() {
            let trimmed = line.trim_start();
            if let Some(marker) = fenced {
                if trimmed.starts_with(&marker.to_string().repeat(3)) {
                    fenced = None;
                }
                offset += line.encode_utf16().count() + 1;
                continue;
            }
            if trimmed.starts_with("```") {
                fenced = Some('`');
                offset += line.encode_utf16().count() + 1;
                continue;
            }
            if trimmed.starts_with("~~~") {
                fenced = Some('~');
                offset += line.encode_utf16().count() + 1;
                continue;
            }
            for (regex, rule, what, fix) in [
                (
                    &mention,
                    "platform-mention-token",
                    "an at-prefixed word",
                    "move the example into a fenced code block, or strip the sigil and rephrase",
                ),
                (
                    &issue,
                    "platform-issue-reference",
                    "a hash-number",
                    "move the example into a fenced code block, or rewrite it as \"item 1\" / \"point 1\"",
                ),
            ] {
                for found in regex.find_iter(line) {
                    let before = line[..found.start()].chars().next_back();
                    if before.is_some_and(|ch| ch.is_alphanumeric() || "@._-/#".contains(ch)) {
                        continue;
                    }
                    let start = offset + line[..found.start()].encode_utf16().count();
                    warnings.push(json!({
                        "line": line_index + 1, "column": line[..found.start()].encode_utf16().count() + 1,
                        "rule": rule,
                        "message": format!("GitHub re-linkifies {what} in published output, so \"{}\" becomes a link that notifies or references something unrelated; {fix}.", found.as_str()),
                        "start": start, "end": start + found.as_str().encode_utf16().count(), "resourceUri": format!("carve://lint-rules/{rule}"),
                    }));
                }
            }
            offset += line.encode_utf16().count() + 1;
        }
    }
    if let Some((index, _)) = source.match_indices(":::").next()
        && !source[index + 3..].lines().any(|line| line.trim() == ":::")
    {
        warnings.push(json!({
                    "line": source[..index].matches('\n').count() + 1, "column": 1,
                    "rule": "unclosed-container-fence",
                    "message": "This 3-colon div has no closer; it runs to the end of the document. Add a bare fence of 3 colons to close it.",
                    "start": utf16_offset(source, index), "end": utf16_offset(source, index + 3), "resourceUri": "carve://lint-rules/unclosed-container-fence",
                }));
    }
    warnings.sort_by_key(|warning| warning["start"].as_u64().unwrap_or(0));
    warnings
}

#[derive(Debug, Clone)]
pub struct CarveServer {
    tools: ToolRouter<Self>,
    workspace: Option<Workspace>,
}

impl CarveServer {
    pub fn new() -> Self {
        Self::with_workspace(None)
    }

    pub fn with_workspace(workspace: Option<Workspace>) -> Self {
        let mut tools = Self::tool_router();
        if workspace.is_none() {
            for name in [
                "carve_workspace_info",
                "carve_read_file",
                "carve_list_files",
                "carve_review_workspace",
                "carve_prepare_edit",
                "carve_prepare_workspace_edits",
                "carve_write_file",
            ] {
                tools.remove_route(name);
            }
        } else if !workspace.as_ref().is_some_and(Workspace::allow_write) {
            tools.remove_route("carve_write_file");
        }
        Self { tools, workspace }
    }

    fn checked(source: &str) -> Result<(), String> {
        let bytes = source.len();
        if bytes > MAX_SOURCE_BYTES {
            Err(format!(
                "Source is {bytes} bytes; the limit is {MAX_SOURCE_BYTES} bytes."
            ))
        } else {
            Ok(())
        }
    }

    fn output(value: Value) -> CallToolResult {
        let summary = value
            .get("warningCount")
            .and_then(Value::as_u64)
            .map(|count| {
                if count == 0 {
                    "No issues found.".into()
                } else {
                    format!("Found {count} issue{}.", if count == 1 { "" } else { "s" })
                }
            })
            .or_else(|| {
                value
                    .get("filesPrepared")
                    .and_then(Value::as_u64)
                    .map(|count| {
                        let changed = value
                            .get("filesChanged")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        format!(
                            "Prepared {count} file preview{}; {changed} would change.",
                            if count == 1 { "" } else { "s" }
                        )
                    })
            })
            .or_else(|| {
                value.get("files").and_then(Value::as_array).map(|files| {
                    format!(
                        "Found {} document file{}.",
                        files.len(),
                        if files.len() == 1 { "" } else { "s" }
                    )
                })
            })
            .or_else(|| {
                value
                    .get("proposedContent")
                    .and_then(Value::as_str)
                    .map(|_| {
                        if value["changed"].as_bool().unwrap_or(false) {
                            format!(
                                "Formatting would change {}.",
                                value["path"].as_str().unwrap_or("the file")
                            )
                        } else {
                            format!(
                                "{} is already canonical.",
                                value["path"].as_str().unwrap_or("The file")
                            )
                        }
                    })
            })
            .or_else(|| {
                value
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|_| format!("Read {}.", value["path"].as_str().unwrap_or("the file")))
            })
            .or_else(|| {
                value.get("dryRun").and_then(Value::as_bool).map(|dry_run| {
                    if dry_run {
                        format!(
                            "Previewed the write to {}; no file changed.",
                            value["path"].as_str().unwrap_or("the file")
                        )
                    } else {
                        format!("Wrote {}.", value["path"].as_str().unwrap_or("the file"))
                    }
                })
            })
            .or_else(|| {
                (value.get("type").and_then(Value::as_str) == Some("document"))
                    .then(|| "Parsed the document successfully.".into())
            })
            .or_else(|| {
                value.get("matchCount").and_then(Value::as_u64).map(|count| format!("Found {count} matching AST node{}.", if count == 1 { "" } else { "s" }))
            })
            .or_else(|| {
                (value.get("sourcePatch").is_some()
                    && value.get("match").is_some()
                    && value.get("edit").is_some())
                .then(|| {
                    if let Some(count) = value.get("editCount").and_then(Value::as_u64)
                        && count > 1
                    {
                        return format!(
                            "Planned {count} atomic semantic edits; no file was changed."
                        );
                    }
                    let kind = value["edit"]["kind"].as_str().unwrap_or("semantic edit");
                    format!("Planned {kind} for one matching AST node; no file was changed.")
                })
            })
            .or_else(|| {
                value
                    .get("operationCount")
                    .and_then(Value::as_u64)
                    .map(|count| {
                        format!(
                            "Created {count} AST patch operation{}.",
                            if count == 1 { "" } else { "s" }
                        )
                    })
            })
            .or_else(|| {
                value.get("forward").and_then(Value::as_array).and_then(|forward| {
                    value.get("inverse").and_then(Value::as_array).map(|inverse| {
                        format!("Created a reversible AST patch with {} forward and {} inverse operations.", forward.len(), inverse.len())
                    })
                })
            })
            .or_else(|| {
                (value.get("sourcePatch").is_some() && value.get("direction").is_some()).then(|| {
                    if value.get("direction").and_then(Value::as_str) == Some("inverse") {
                        "Reverted the AST patch and prepared a stale-guarded source edit.".into()
                    } else {
                        "Applied the AST patch and prepared a stale-guarded source edit.".into()
                    }
                })
            })
            .or_else(|| {
                (value.get("ast").is_some()
                    && value.get("source").and_then(Value::as_str).is_some())
                .then(|| "Applied the AST patch and produced canonical Carve source.".into())
            })
            .or_else(|| {
                value
                    .get("value")
                    .and_then(Value::as_str)
                    .map(|_| "Produced the requested output.".into())
            })
            .unwrap_or_else(|| "Completed successfully.".into());
        let mut result = CallToolResult::structured(value);
        result.content = vec![ContentBlock::text(summary)];
        result
    }

    fn error(message: impl Into<String>) -> CallToolResult {
        CallToolResult::error(vec![ContentBlock::text(
            serde_json::to_string_pretty(&json!({"error": message.into()}))
                .expect("JSON values always serialize"),
        )])
    }

    fn loss(loss: RenderLoss) -> Value {
        json!({
            "code": loss.code, "format": loss.format, "target": loss.target.as_str(),
            "nodeType": loss.node_type.as_str(), "message": loss.message,
            "pos": loss.pos.map(|pos| json!({
                "startLine": pos.start_line, "endLine": pos.end_line,
                "startColumn": pos.start_column, "endColumn": pos.end_column,
                "startOffset": pos.start_offset, "endOffset": pos.end_offset,
            })),
        })
    }

    fn render_result(result: carve::RenderResult<String>) -> CallToolResult {
        Self::output(json!({
            "value": result.value,
            "losses": result.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),
            "totalLosses": result.total_losses,
            "truncated": result.truncated,
        }))
    }
}

impl Default for CarveServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router]
impl CarveServer {
    #[tool(name = "carve_workspace_info", title = "List configured Carve workspace roots", description = "List root indexes and whether writes are enabled. Paths are intentionally not exposed.", output_schema = rmcp::handler::server::tool::schema_for_type::<WorkspaceInfoOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
    fn workspace_info(&self) -> CallToolResult {
        let Some(workspace) = &self.workspace else {
            return Self::error("No workspace roots are configured.");
        };
        Self::output(
            json!({"roots": (0..workspace.root_count()).map(|root_index| json!({"rootIndex":root_index})).collect::<Vec<_>>(), "allowWrite":workspace.allow_write()}),
        )
    }

    #[tool(name = "carve_read_file", title = "Read Carve workspace file", description = "Read a UTF-8 text file inside an explicitly configured workspace root.", output_schema = rmcp::handler::server::tool::schema_for_type::<ReadOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
    fn read_file(&self, Parameters(input): Parameters<WorkspacePathInput>) -> CallToolResult {
        match self
            .workspace
            .as_ref()
            .ok_or_else(|| "No workspace roots are configured.".to_owned())
            .and_then(|workspace| workspace.read(input.root_index, &input.path))
        {
            Ok(value) => Self::output(value),
            Err(error) => Self::error(error),
        }
    }

    #[tool(name = "carve_list_files", title = "List Carve workspace files", description = "List supported document files inside an explicitly configured root, with bounded recursion and no host paths.", output_schema = rmcp::handler::server::tool::schema_for_type::<ListOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
    fn list_files(&self, Parameters(input): Parameters<WorkspaceListInput>) -> CallToolResult {
        match self
            .workspace
            .as_ref()
            .ok_or_else(|| "No workspace roots are configured.".to_owned())
            .and_then(|workspace| workspace.list(input.root_index, input.max_depth, input.limit))
        {
            Ok(value) => Self::output(value),
            Err(error) => Self::error(error),
        }
    }

    #[tool(name = "carve_review_workspace", title = "Review Carve workspace", description = "Lint Carve files and validate explicit local document links and anchors across a bounded workspace scan.", output_schema = rmcp::handler::server::tool::schema_for_type::<ReviewOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
    fn review_workspace(
        &self,
        Parameters(input): Parameters<WorkspaceReviewInput>,
    ) -> CallToolResult {
        match self
            .workspace
            .as_ref()
            .ok_or_else(|| "No workspace roots are configured.".to_owned())
            .and_then(|workspace| {
                workspace.review(
                    input.root_index,
                    input
                        .max_depth
                        .unwrap_or_else(|| workspace.review_max_depth()),
                    input.limit.unwrap_or_else(|| workspace.review_limit()),
                    input.platforms.as_ref().map_or_else(
                        || workspace.review_github(),
                        |platforms| {
                            platforms
                                .iter()
                                .any(|platform| matches!(platform, LintPlatform::Github))
                        },
                    ),
                    workspace.check_links(),
                    workspace.check_anchors(),
                )
            }) {
            Ok(value) => Self::output(value),
            Err(error) => Self::error(error),
        }
    }

    #[tool(name = "carve_prepare_edit", title = "Preview canonical Carve formatting", description = "Read and canonically format a Carve workspace file without writing. A lossless result includes a stale-guarded patch with UTF-8 byte ranges; a lossy writer-review result has patch: null.", output_schema = rmcp::handler::server::tool::schema_for_type::<EditOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
    fn prepare_edit(&self, Parameters(input): Parameters<WorkspacePathInput>) -> CallToolResult {
        if !input.path.to_ascii_lowercase().ends_with(".crv")
            && !input.path.to_ascii_lowercase().ends_with(".carve")
        {
            return Self::error("Edit previews require a .crv or .carve file.");
        }
        let read = match self
            .workspace
            .as_ref()
            .ok_or_else(|| "No workspace roots are configured.".to_owned())
            .and_then(|workspace| workspace.read(input.root_index, &input.path))
        {
            Ok(value) => value,
            Err(error) => return Self::error(error),
        };
        let source = read["content"].as_str().unwrap();
        match carve::to_carve_with_report(source, CheckedRenderOptions::default()) {
            Ok(result) => {
                let (diff, diff_truncated) =
                    unified_diff(&input.path, source, &result.value, 100_000);
                let patch = if result.total_losses == 0 {
                    Some(source_patch(source, &result.value))
                } else {
                    None
                };
                Self::output(
                    json!({"rootIndex":input.root_index,"path":input.path,"expectedSha256":read["sha256"],"changed":result.value != source,"proposedContent":result.value,"unifiedDiff":diff,"diffTruncated":diff_truncated,"patch":patch,"losses":result.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),"totalLosses":result.total_losses,"truncated":result.truncated}),
                )
            }
            Err(error) => Self::error(error.to_string()),
        }
    }

    #[tool(name = "carve_prepare_workspace_edits", title = "Preview canonical formatting across a workspace", description = "Prepare bounded formatting proposals and unified diffs without writing. Lossless items include stale-guarded UTF-8 byte patches; lossy writer-review items have patch: null.", output_schema = rmcp::handler::server::tool::schema_for_type::<BatchEditOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
    fn prepare_workspace_edits(
        &self,
        Parameters(input): Parameters<WorkspaceBatchEditInput>,
    ) -> CallToolResult {
        let Some(workspace) = self.workspace.as_ref() else {
            return Self::error("No workspace roots are configured.");
        };
        if input.max_depth > 25 || !(1..=100).contains(&input.limit) {
            return Self::error("maxDepth must be at most 25 and limit must be between 1 and 100.");
        }
        if !(1_000..=200_000).contains(&input.max_diff_bytes) {
            return Self::error("maxDiffBytes must be between 1000 and 200000.");
        }
        if input.paths.as_ref().is_some_and(|paths| paths.len() > 100) {
            return Self::error("Batch previews support at most 100 files.");
        }
        let (paths, files_discovered, list_truncated) = if let Some(paths) = input.paths {
            let paths = paths
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            if paths.len() > 100 {
                return Self::error("Batch previews support at most 100 files.");
            }
            if paths.iter().any(|path| {
                !matches!(
                    std::path::Path::new(path)
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(str::to_ascii_lowercase)
                        .as_deref(),
                    Some("crv" | "carve")
                )
            }) {
                return Self::error(
                    "Explicit batch preview paths must use .crv or .carve extensions.",
                );
            }
            let count = paths.len();
            (paths, count, false)
        } else {
            let listing = match workspace.list(input.root_index, input.max_depth, input.limit) {
                Ok(value) => value,
                Err(error) => return Self::error(error),
            };
            let paths = listing["files"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let count = paths.len();
            (
                paths,
                count,
                listing["truncated"].as_bool().unwrap_or(false),
            )
        };
        let maximum_diff_bytes = input.max_diff_bytes;
        let mut items = Vec::new();
        let mut total_bytes = 0usize;
        let mut size_truncated = false;
        for path in paths.into_iter().filter(|path| {
            matches!(
                std::path::Path::new(path)
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("crv" | "carve")
            )
        }) {
            let read = match workspace.read(input.root_index, &path) {
                Ok(value) => value,
                Err(error) => {
                    items.push(json!({"path":path,"status":"error","message":error}));
                    continue;
                }
            };
            let bytes = read["bytes"].as_u64().unwrap() as usize;
            if total_bytes + bytes > 25_000_000 {
                size_truncated = true;
                break;
            }
            total_bytes += bytes;
            let source = read["content"].as_str().unwrap();
            match carve::to_carve_with_report(source, CheckedRenderOptions::default()) {
                Ok(result) => {
                    let changed = result.value != source;
                    let (diff, diff_truncated) =
                        unified_diff(&path, source, &result.value, maximum_diff_bytes);
                    let patch = if result.total_losses == 0 {
                        Some(source_patch(source, &result.value))
                    } else {
                        None
                    };
                    let mut item = json!({"path":path,"status":"ready","expectedSha256":read["sha256"],"changed":changed,"mode":if result.total_losses == 0 { "automatic-format" } else { "writer-review" },"unifiedDiff":diff,"diffTruncated":diff_truncated,"patch":patch,"losses":result.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),"totalLosses":result.total_losses,"lossesTruncated":result.truncated});
                    if changed && input.include_content {
                        item["proposedContent"] = Value::String(result.value);
                    }
                    items.push(item);
                }
                Err(error) => {
                    items.push(json!({"path":path,"status":"error","message":error.to_string()}))
                }
            }
        }
        let files_prepared = items
            .iter()
            .filter(|item| item["status"] == "ready")
            .count();
        let files_changed = items
            .iter()
            .filter(|item| item["status"] == "ready" && item["changed"] == true)
            .count();
        let error_count = items
            .iter()
            .filter(|item| item["status"] == "error")
            .count();
        Self::output(
            json!({"rootIndex":input.root_index,"filesDiscovered":files_discovered,"filesPrepared":files_prepared,"filesChanged":files_changed,"errorCount":error_count,"items":items,"truncated":list_truncated || size_truncated,"totalBytes":total_bytes}),
        )
    }

    #[tool(name = "carve_write_file", title = "Write Carve workspace file", description = "Dry-run by default; atomically write UTF-8 text only when dryRun is false. Overwrites require the hash returned by carve_read_file.", output_schema = rmcp::handler::server::tool::schema_for_type::<WriteOutputSchema>(), annotations(read_only_hint = false, destructive_hint = true, open_world_hint = false))]
    fn write_file(&self, Parameters(input): Parameters<WorkspaceWriteInput>) -> CallToolResult {
        match self
            .workspace
            .as_ref()
            .ok_or_else(|| "No workspace roots are configured.".to_owned())
            .and_then(|workspace| {
                workspace.write(
                    input.root_index,
                    &input.path,
                    &input.content,
                    input.expected_sha256.as_deref(),
                    input.dry_run,
                )
            }) {
            Ok(value) => Self::output(value),
            Err(error) => Self::error(error),
        }
    }

    #[tool(
        name = "carve_lint",
        title = "Lint Carve",
        description = "Check Carve source for author-facing problems and silent degradation.", output_schema = rmcp::handler::server::tool::schema_for_type::<LintOutputSchema>(),
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    fn lint(&self, Parameters(input): Parameters<LintInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        let warnings = lint_values(&input.source, &input.platforms);
        Self::output(
            json!({"valid": warnings.is_empty(), "warningCount": warnings.len(), "warnings": warnings}),
        )
    }

    #[tool(
        name = "carve_diagnose_and_fix",
        title = "Diagnose and fix Carve",
        description = "Diagnose Carve source, propose bounded fixes, and optionally apply selected safe fix IDs with forward and undo patches. Writer-review fixes are never applied automatically.", output_schema = rmcp::handler::server::tool::schema_for_type::<DiagnosticFixOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn diagnose_and_fix(
        &self,
        Parameters(input): Parameters<DiagnosticFixInput>,
    ) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        if input.apply_fix_ids.len() > 100 {
            return Self::error("applyFixIds must contain at most 100 items.");
        }
        let warnings = lint_values(&input.source, &input.platforms);
        let unclosed_count = warnings
            .iter()
            .filter(|warning| warning["rule"] == "unclosed-container-fence")
            .count();
        let mut fixes = Vec::new();
        let mut automatic =
            std::collections::BTreeMap::<String, (usize, usize, String, String)>::new();
        for (index, warning) in warnings.iter().enumerate() {
            let rule = warning["rule"].as_str().unwrap_or_default();
            let start_utf16 = warning["start"].as_u64().unwrap_or(0) as usize;
            let end_utf16 = warning["end"].as_u64().unwrap_or(0) as usize;
            let id = format!("{rule}:{start_utf16}:{end_utf16}:{index}");
            let edit = if rule == "bidi-control-in-source" {
                Some((
                    byte_offset_from_utf16(&input.source, start_utf16),
                    byte_offset_from_utf16(&input.source, end_utf16),
                    String::new(),
                    rule.to_owned(),
                ))
            } else if rule == "unclosed-container-fence" && unclosed_count == 1 {
                let marker = input.source[byte_offset_from_utf16(&input.source, start_utf16)..]
                    .chars()
                    .take_while(|character| *character == ':')
                    .collect::<String>();
                let prefix = if input.source.ends_with('\n') {
                    ""
                } else {
                    "\n"
                };
                (!marker.is_empty()).then(|| {
                    (
                        input.source.len(),
                        input.source.len(),
                        format!("{prefix}{marker}\n"),
                        rule.to_owned(),
                    )
                })
            } else {
                None
            };
            if let Some(edit) = edit.as_ref() {
                automatic.insert(id.clone(), edit.clone());
            }
            fixes.push(json!({"id":id,"rule":rule,"message":warning["message"],"applicability":if edit.is_some(){"automatic"}else{"writer-review"},"edit":edit.map(|(start,end,replacement,code)|json!({"start":start,"end":end,"replacement":replacement,"kind":"quick-fix","code":code}))}));
        }
        let requested = input
            .apply_fix_ids
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        for id in &input.apply_fix_ids {
            if !fixes.iter().any(|fix| fix["id"] == *id) {
                return Self::error(format!("Unknown fix id: {id}"));
            }
            if !automatic.contains_key(id) {
                return Self::error(format!(
                    "Fix {id} requires writer review and cannot be applied automatically."
                ));
            }
        }
        let applied_fix_ids = fixes
            .iter()
            .filter_map(|fix| fix["id"].as_str())
            .filter(|id| requested.contains(*id))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut selected = applied_fix_ids
            .iter()
            .filter_map(|id| automatic.get(id).cloned())
            .collect::<Vec<_>>();
        selected.sort_by(|left, right| right.0.cmp(&left.0).then(right.1.cmp(&left.1)));
        for pair in selected.windows(2) {
            if pair[1].1 > pair[0].0 {
                return Self::error("Selected quick fixes overlap.");
            }
        }
        let mut value = input.source.clone();
        for (start, end, replacement, _) in &selected {
            value.replace_range(*start..*end, replacement);
        }
        let remaining = lint_values(&value, &input.platforms);
        if !selected.is_empty() && remaining.len() > warnings.len() {
            return Self::error("Selected quick fixes made diagnostics worse; refusing the patch.");
        }
        let patch = source_patch_with_kind(
            &input.source,
            &value,
            SourceEditKindOutputSchema::QuickFix,
            "diagnostic-fixes",
        );
        let undo_patch = source_patch_with_kind(
            &value,
            &input.source,
            SourceEditKindOutputSchema::QuickFix,
            "undo-diagnostic-fixes",
        );
        Self::output(
            json!({"valid":warnings.is_empty(),"warningCount":warnings.len(),"warnings":warnings,"fixes":fixes,"appliedFixIds":applied_fix_ids,"value":value,"remainingWarningCount":remaining.len(),"remainingValid":remaining.is_empty(),"patch":patch,"undoPatch":undo_patch}),
        )
    }

    #[tool(
        name = "carve_format",
        title = "Format Carve",
        description = "Format Carve source canonically and report any lossy raw-format nodes.", output_schema = rmcp::handler::server::tool::schema_for_type::<RenderOutputSchema>(),
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    fn format(&self, Parameters(input): Parameters<SourceInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        match carve::to_carve_with_report(&input.source, CheckedRenderOptions::default()) {
            Ok(result) => Self::render_result(result),
            Err(error) => Self::error(error.to_string()),
        }
    }

    #[tool(
        name = "carve_render",
        title = "Render Carve",
        description = "Render Carve to HTML, Markdown, plain text, or ANSI terminal text, with loss reporting.", output_schema = rmcp::handler::server::tool::schema_for_type::<RenderOutputSchema>(),
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    fn render(&self, Parameters(input): Parameters<RenderInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        if input.preset == RenderPreset::StaticHtml && !matches!(input.target, RenderTarget::Html) {
            return Self::error("The static-html preset is only valid for the HTML target.");
        }
        if input.extensions.contains(&ExtensionName::SemanticSpans)
            && !matches!(input.target, RenderTarget::Html)
        {
            return Self::error("The semantic-spans extension is only valid for the HTML target.");
        }
        let autolink = Autolink::new();
        let semantic = SemanticSpan;
        let wikilinks = Wikilinks::new();
        let mut options = Options::default()
            .with_raw_html(input.allow_raw_html)
            .with_positions(true);
        if input.sanitize_urls {
            options =
                options.with_profile(Profile::full().set_link_policy(Some(LinkPolicy::default())));
        }
        if input.preset == RenderPreset::StaticHtml {
            options = options.with_mode(Mode::Static);
        }
        let portable = input.preset == RenderPreset::Portable;
        options =
            options.with_lowercase_heading_ids(input.lowercase_heading_ids.unwrap_or(portable));
        options = options.with_ascii_heading_ids(match input.ascii_heading_ids {
            None if portable => AsciiHeadingIds::Fold,
            None | Some(AsciiMode::Off) => AsciiHeadingIds::Off,
            Some(AsciiMode::Fold) => AsciiHeadingIds::Fold,
            Some(AsciiMode::Strict) => AsciiHeadingIds::Strict,
        });
        options.smart_typography = match input.smart_typography {
            None | Some(TypographyMode::Glyph) => SmartTypographyMode::Glyph,
            Some(TypographyMode::Source) => SmartTypographyMode::Source,
        };
        for extension in &input.extensions {
            options = match extension {
                ExtensionName::Autolink => options.with_extension(&autolink),
                ExtensionName::SemanticSpans => options.with_extension(&semantic),
                ExtensionName::Wikilinks => options.with_extension(&wikilinks),
            };
        }
        let target = match input.target {
            RenderTarget::Html => CarveRenderTarget::Html,
            RenderTarget::Markdown => CarveRenderTarget::Markdown,
            RenderTarget::Plain => CarveRenderTarget::Plain,
            RenderTarget::Ansi => CarveRenderTarget::Ansi,
        };
        let checked_options = CheckedRenderOptions {
            strict: input.strict_losses,
            max_losses: input
                .max_render_losses
                .unwrap_or(carve::DEFAULT_MAX_RENDER_LOSSES)
                .min(10_000),
        };
        let checked = with_render_loss_report(target, checked_options, || match target {
            CarveRenderTarget::Html => carve::try_to_html_with_options(&input.source, &options),
            CarveRenderTarget::Markdown => {
                carve::try_to_markdown_with_options(&input.source, &options)
            }
            CarveRenderTarget::Plain => {
                carve::try_to_plain_text_with_options(&input.source, &options)
            }
            CarveRenderTarget::Ansi => carve::try_to_ansi_with_options(&input.source, &options),
            CarveRenderTarget::Carve => unreachable!(),
        });
        match checked {
            Ok(result) => match result.value {
                Ok(value) => Self::render_result(carve::RenderResult {
                    value,
                    losses: result.losses,
                    total_losses: result.total_losses,
                    truncated: result.truncated,
                }),
                Err(error) => Self::error(error.to_string()),
            },
            Err(error) => CallToolResult::error(vec![ContentBlock::text(
                serde_json::to_string_pretty(&json!({
                    "error": format!(
                        "render would drop {} raw format node{}",
                        error.total_losses,
                        if error.total_losses == 1 { "" } else { "s" }
                    ),
                    "losses": error.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),
                    "totalLosses": error.total_losses, "truncated": error.truncated,
                }))
                .expect("JSON values always serialize"),
            )]),
        }
    }

    #[tool(
        name = "carve_check_targets",
        title = "Check Carve publishing targets",
        description = "Compare one Carve document across HTML, Markdown, plain text, ANSI, GitHub, WordPress, and PDF-stage profiles, returning target-specific warnings, losses, and fallbacks.", output_schema = rmcp::handler::server::tool::schema_for_type::<CompatibilityOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn check_targets(&self, Parameters(input): Parameters<CompatibilityInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        if input.targets.is_empty() || input.targets.len() > 7 {
            return Self::error("targets must contain between 1 and 7 items.");
        }
        let mut selected = Vec::new();
        for target in input.targets {
            if !selected.contains(&target) {
                selected.push(target);
            }
        }
        let mut results = Vec::new();
        for target in selected {
            let (name, render_target, github, note) = match target {
                CompatibilityTarget::Html => (
                    "html",
                    CarveRenderTarget::Html,
                    false,
                    "Generic sanitized HTML.",
                ),
                CompatibilityTarget::Markdown => (
                    "markdown",
                    CarveRenderTarget::Markdown,
                    false,
                    "Portable Markdown output.",
                ),
                CompatibilityTarget::Plain => (
                    "plain",
                    CarveRenderTarget::Plain,
                    false,
                    "Plain-text projection.",
                ),
                CompatibilityTarget::Ansi => (
                    "ansi",
                    CarveRenderTarget::Ansi,
                    false,
                    "Terminal-oriented ANSI text.",
                ),
                CompatibilityTarget::Github => (
                    "github",
                    CarveRenderTarget::Markdown,
                    true,
                    "Markdown plus GitHub relinking diagnostics.",
                ),
                CompatibilityTarget::Wordpress => (
                    "wordpress",
                    CarveRenderTarget::Html,
                    false,
                    "Sanitized HTML suitable for the WordPress integration; host extensions remain host-dependent.",
                ),
                CompatibilityTarget::Pdf => (
                    "pdf",
                    CarveRenderTarget::Html,
                    false,
                    "HTML-stage compatibility for a print/PDF pipeline; pagination and fonts remain renderer-dependent.",
                ),
            };
            let options = Options::default()
                .with_raw_html(false)
                .with_positions(true)
                .with_profile(Profile::full().set_link_policy(Some(LinkPolicy::default())));
            let rendered =
                with_render_loss_report(render_target, CheckedRenderOptions::default(), || {
                    match render_target {
                        CarveRenderTarget::Html => {
                            carve::try_to_html_with_options(&input.source, &options)
                        }
                        CarveRenderTarget::Markdown => {
                            carve::try_to_markdown_with_options(&input.source, &options)
                        }
                        CarveRenderTarget::Plain => {
                            carve::try_to_plain_text_with_options(&input.source, &options)
                        }
                        CarveRenderTarget::Ansi => {
                            carve::try_to_ansi_with_options(&input.source, &options)
                        }
                        CarveRenderTarget::Carve => unreachable!(),
                    }
                });
            let rendered = match rendered {
                Ok(result) => result,
                Err(error) => return Self::error(error.to_string()),
            };
            if let Err(error) = rendered.value {
                return Self::error(error.to_string());
            }
            let warnings = lint_values(
                &input.source,
                if github { &[LintPlatform::Github] } else { &[] },
            );
            let loss_count = rendered.total_losses;
            let status = if loss_count > 0 {
                "lossy"
            } else if warnings.is_empty() {
                "compatible"
            } else {
                "warning"
            };
            let mut suggestions = Vec::new();
            if loss_count > 0 {
                suggestions.push(
                    "Inspect the reported render losses and choose a target-specific fallback.",
                );
            }
            if !warnings.is_empty() {
                suggestions.push(if github {
                    "Resolve the target-specific lint warnings before publishing."
                } else {
                    "Resolve the general lint warnings before publishing."
                });
            }
            results.push(json!({"target":name,"renderTarget":render_target.as_str(),"status":status,"note":note,"warningCount":warnings.len(),"warnings":warnings,"lossCount":loss_count,"losses":rendered.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),"lossesTruncated":rendered.truncated,"suggestions":suggestions}));
        }
        let compatible = results
            .iter()
            .filter(|item| item["status"] == "compatible")
            .count();
        let warning = results
            .iter()
            .filter(|item| item["status"] == "warning")
            .count();
        let lossy = results
            .iter()
            .filter(|item| item["status"] == "lossy")
            .count();
        Self::output(
            json!({"compatible":warning == 0 && lossy == 0,"targetCount":results.len(),"summary":{"compatible":compatible,"warning":warning,"lossy":lossy},"targets":results}),
        )
    }

    #[tool(
        name = "carve_parse",
        title = "Parse Carve",
        description = "Parse and resolve Carve into its position-aware interchange AST.", output_schema = rmcp::handler::server::tool::schema_for_type::<ParseOutputSchema>(),
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    fn parse(&self, Parameters(input): Parameters<SourceInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        let value = carve::to_json_with_options(
            &input.source,
            &carve::Options::default().with_positions(true),
        );
        match serde_json::from_str(&value) {
            Ok(value) => Self::output(value),
            Err(error) => Self::error(format!("AST serialization failed: {error}")),
        }
    }

    #[tool(
        name = "carve_create_ast_patch",
        title = "Create structured AST patch",
        description = "Compare two PART 12 Carve ASTs and return position-independent add, replace, and remove operations.", output_schema = rmcp::handler::server::tool::schema_for_type::<AstPatchCreateOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn create_ast_patch(
        &self,
        Parameters(input): Parameters<AstPatchCreateInput>,
    ) -> CallToolResult {
        let before_json = match serde_json::to_string(&input.before) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "Before AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => {
                return Self::error(format!("Before AST must be JSON-serializable: {error}"));
            }
        };
        let after_json = match serde_json::to_string(&input.after) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "After AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => {
                return Self::error(format!("After AST must be JSON-serializable: {error}"));
            }
        };
        let result = carve::from_json(&before_json)
            .and_then(|before| carve::from_json(&after_json).map(|after| (before, after)))
            .map_err(|error| error.to_string())
            .and_then(|(before, after)| {
                carve::create_ast_patch(&before, &after).map_err(|error| error.to_string())
            })
            .and_then(|mut operations| {
                operations.sort_by(|left, right| ast_patch_path(left).cmp(ast_patch_path(right)));
                let count = operations.len();
                if count > MAX_AST_PATCH_OPERATIONS {
                    return Err(format!(
                        "Patch has {count} operations; the limit is {MAX_AST_PATCH_OPERATIONS}."
                    ));
                }
                let changes = explain_ast_operations(&input.before, &operations);
                carve::ast_patch_to_json(&operations)
                    .map_err(|error| error.to_string())
                    .and_then(|value| {
                        if value.len() > MAX_SOURCE_BYTES {
                            Err(format!(
                                "Patch operations is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                                value.len()
                            ))
                        } else {
                            Ok((value, count, changes))
                        }
                    })
            });
        match result {
            Ok((operations, count, changes)) => match serde_json::from_str::<Value>(&operations) {
                Ok(operations) => {
                    let change_count = changes.len();
                    let value = json!({"operations": operations, "operationCount": count, "changes": changes, "changeCount": change_count});
                    match serde_json::to_vec(&value) {
                        Ok(bytes) if bytes.len() <= MAX_SOURCE_BYTES => Self::output(value),
                        Ok(bytes) => Self::error(format!(
                            "AST patch result is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                            bytes.len()
                        )),
                        Err(error) => {
                            Self::error(format!("AST patch serialization failed: {error}"))
                        }
                    }
                }
                Err(error) => Self::error(format!("AST patch serialization failed: {error}")),
            },
            Err(error) => Self::error(error),
        }
    }

    #[tool(
        name = "carve_apply_ast_patch",
        title = "Apply structured AST patch",
        description = "Validate and apply structured operations to a PART 12 Carve AST, returning the patched AST and canonical Carve source.", output_schema = rmcp::handler::server::tool::schema_for_type::<AstPatchApplyOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn apply_ast_patch(&self, Parameters(input): Parameters<AstPatchApplyInput>) -> CallToolResult {
        if input.operations.len() > MAX_AST_PATCH_OPERATIONS {
            return Self::error(format!(
                "Patch has {} operations; the limit is {MAX_AST_PATCH_OPERATIONS}.",
                input.operations.len()
            ));
        }
        let operations_json = match serde_json::to_string(&input.operations) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "Patch operations is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => {
                return Self::error(format!(
                    "Patch operations must be JSON-serializable: {error}"
                ));
            }
        };
        let operations = match carve::ast_patch_from_json(&operations_json) {
            Ok(operations) => operations,
            Err(error) => return Self::error(error.to_string()),
        };
        let ast_json = match serde_json::to_string(&input.ast) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => return Self::error(format!("AST must be JSON-serializable: {error}")),
        };
        let result = carve::from_json(&ast_json)
            .map(|ast| (ast, operations))
            .map_err(|error| error.to_string())
            .and_then(|(ast, operations)| {
                carve::apply_ast_patch(&ast, &operations).map_err(|error| error.to_string())
            })
            .and_then(|patched| {
                let source = carve::render_carve(&patched).map_err(|error| error.to_string())?;
                let ast = carve::try_to_json(&patched).map_err(|error| error.to_string())?;
                Ok((ast, source))
            });
        match result {
            Ok((ast, source)) => match serde_json::from_str::<Value>(&ast) {
                Ok(ast) => Self::output(json!({"ast": ast, "source": source})),
                Err(error) => Self::error(format!("AST serialization failed: {error}")),
            },
            Err(error) => Self::error(error),
        }
    }

    #[tool(
        name = "carve_select_ast_nodes",
        title = "Find AST nodes by semantic selector",
        description = "Resolve a heading ID, footnote label, node type, or current AST path to reviewable PART 12 AST paths without silently choosing among multiple matches.", output_schema = rmcp::handler::server::tool::schema_for_type::<AstSelectionOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn select_ast_nodes(&self, Parameters(input): Parameters<AstSelectInput>) -> CallToolResult {
        if input.selector.value.is_empty() {
            return Self::error("Selector value must not be empty.");
        }
        let selector_maximum = if matches!(input.selector.kind, AstSelectorKind::AstPath) {
            4096
        } else {
            256
        };
        if input.selector.value.chars().count() > selector_maximum {
            return Self::error(format!(
                "Selector value may contain at most {selector_maximum} characters."
            ));
        }
        let ast_json = match serde_json::to_string(&input.ast) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => return Self::error(format!("AST must be JSON-serializable: {error}")),
        };
        if let Err(error) = carve::from_json(&ast_json) {
            return Self::error(error.to_string());
        }
        let selected = ast_nodes(&input.ast)
            .into_iter()
            .filter(|(path, node)| selector_matches(path, node, &input.selector))
            .collect::<Vec<_>>();
        let match_count = selected.len();
        let matches = selected
            .into_iter()
            .take(MAX_AST_SELECTOR_MATCHES)
            .map(|(path, node)| {
                let full_preview = human_text(&node_text(&Value::Object(node.clone())), 121);
                let preview_truncated = full_preview.chars().count() > 120;
                let preview = full_preview.chars().take(120).collect();
                AstSelectorMatchOutputSchema {
                    path,
                    r#type: node
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    identity: node_identity(node)
                        .map(|value| human_text(value, 80))
                        .filter(|value| !value.is_empty()),
                    preview,
                    preview_truncated,
                }
            })
            .collect::<Vec<_>>();
        let value = json!({"selector": input.selector, "matchCount": match_count, "matches": matches, "truncated": match_count > MAX_AST_SELECTOR_MATCHES});
        match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= MAX_SOURCE_BYTES => Self::output(value),
            Ok(bytes) => Self::error(format!(
                "AST selector result is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                bytes.len()
            )),
            Err(error) => Self::error(format!("AST selector result serialization failed: {error}")),
        }
    }

    #[tool(
        name = "carve_plan_ast_edit",
        title = "Plan a semantic AST edit",
        description = "Plan one or more atomic semantic AST edits and return a human-readable, reversible, stale-guarded source patch without writing the document.", output_schema = rmcp::handler::server::tool::schema_for_type::<SemanticAstEditPlanOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn plan_ast_edit(
        &self,
        Parameters(input): Parameters<SemanticAstEditPlanInput>,
    ) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        if input.then.len() > MAX_SEMANTIC_EDIT_STEPS - 1 {
            return Self::error(format!(
                "Semantic edit plan may contain at most {MAX_SEMANTIC_EDIT_STEPS} steps."
            ));
        }
        let before_document = carve::parse(&input.source);
        let before_json = match carve::try_to_json(&before_document) {
            Ok(value) => value,
            Err(error) => return Self::error(error.to_string()),
        };
        let before = match serde_json::from_str::<Value>(&before_json) {
            Ok(value) => value,
            Err(error) => return Self::error(format!("AST serialization failed: {error}")),
        };
        let requests = std::iter::once(SemanticAstEditStepInput {
            selector: input.selector.clone(),
            edit: input.edit.clone(),
        })
        .chain(input.then.iter().cloned())
        .collect::<Vec<_>>();
        match serde_json::to_vec(&requests) {
            Ok(bytes) if bytes.len() <= MAX_SOURCE_BYTES => {}
            Ok(bytes) => {
                return Self::error(format!(
                    "Semantic edit steps is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    bytes.len()
                ));
            }
            Err(error) => {
                return Self::error(format!("Semantic edit steps serialization failed: {error}"));
            }
        }
        let mut resolved = Vec::with_capacity(requests.len());
        for (index, request) in requests.into_iter().enumerate() {
            if let Err(error) = validate_semantic_edit_shape(&request.edit) {
                return Self::error(error);
            }
            if request.selector.value.is_empty() {
                return Self::error("Selector value must not be empty.");
            }
            let selector_maximum = if matches!(request.selector.kind, AstSelectorKind::AstPath) {
                4096
            } else {
                256
            };
            if request.selector.value.chars().count() > selector_maximum {
                return Self::error(format!(
                    "Selector value may contain at most {selector_maximum} characters."
                ));
            }
            let matches = ast_nodes(&before)
                .into_iter()
                .filter(|(path, node)| selector_matches(path, node, &request.selector))
                .map(|(path, node)| (path, node.clone()))
                .collect::<Vec<_>>();
            let label = if input.then.is_empty() {
                "Semantic selector".into()
            } else {
                format!("Semantic edit step {}", index + 1)
            };
            if matches.is_empty() {
                return Self::error(format!("{label} did not match any AST node."));
            }
            if matches.len() > 1 {
                return Self::error(format!(
                    "{label} matched {} AST nodes; refine it before editing.",
                    matches.len()
                ));
            }
            let (path, node) = matches.into_iter().next().unwrap();
            resolved.push((request.selector, request.edit, path, node));
        }
        for left in 0..resolved.len() {
            for right in left + 1..resolved.len() {
                if ast_paths_overlap(&resolved[left].2, &resolved[right].2) {
                    return Self::error(format!(
                        "Semantic edit steps {} and {} target overlapping AST nodes.",
                        left + 1,
                        right + 1
                    ));
                }
            }
        }
        let mut after = before.clone();
        let mut order = (0..resolved.len()).collect::<Vec<_>>();
        order.sort_by(|left, right| {
            let left_structural = semantic_edit_is_structural(&resolved[*left].1);
            let right_structural = semantic_edit_is_structural(&resolved[*right].1);
            match (left_structural, right_structural) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                (false, false) => left.cmp(right),
                (true, true) => compare_structural_paths(&resolved[*left].2, &resolved[*right].2),
            }
        });
        for index in order {
            if let Err(error) =
                apply_semantic_ast_edit(&mut after, &resolved[index].2, &resolved[index].1)
            {
                return Self::error(error);
            }
        }
        if let Err(error) = validate_no_new_heading_id_collisions(&before, &after) {
            return Self::error(error);
        }
        if semantic_ast_equal(&before, &after) {
            return Self::error("The requested semantic edit would not change the document.");
        }
        for (_, _, _, matched_node) in resolved.iter().filter(|(_, edit, _, node)| {
            matches!(edit.kind, SemanticAstEditKind::DeleteNode)
                && node.get("type").and_then(Value::as_str) == Some("footnote")
        }) {
            let label = node_identity(matched_node);
            let referenced = ast_nodes(&after).into_iter().any(|(_, node)| {
                node.get("type").and_then(Value::as_str) == Some("footnote_ref")
                    && node.get("id").and_then(Value::as_str) == label
            });
            if referenced {
                return Self::error(format!(
                    "Cannot delete footnote “{}” while references remain.",
                    human_text(label.unwrap_or(""), 80)
                ));
            }
        }
        let mut semantic_after = semantic_ast(&after, true);
        if let Some(root) = semantic_after.as_object_mut() {
            root.insert("srcByteLength".into(), Value::from(0));
        }
        let after_json = match serde_json::to_string(&semantic_after) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "Edited AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => return Self::error(format!("Edited AST must be JSON: {error}")),
        };
        let edited_document = match carve::from_json(&after_json) {
            Ok(value) => value,
            Err(error) => return Self::error(error.to_string()),
        };
        let rendered = match carve::render_carve(&edited_document) {
            Ok(value) => value,
            Err(error) => return Self::error(error.to_string()),
        };
        let after_document = carve::parse(&rendered);
        let mut patch = match carve::create_reversible_ast_patch(&before_document, &after_document)
        {
            Ok(value) => value,
            Err(error) => return Self::error(error.to_string()),
        };
        patch
            .forward
            .sort_by(|left, right| ast_patch_path(left).cmp(ast_patch_path(right)));
        patch
            .inverse
            .sort_by(|left, right| ast_patch_path(left).cmp(ast_patch_path(right)));
        if patch.forward.is_empty() {
            return Self::error("The requested semantic edit would not change the document.");
        }
        let forward_document =
            match carve::apply_reversible_ast_patch(&before_document, &patch, false) {
                Ok(value) => value,
                Err(error) => return Self::error(error.to_string()),
            };
        match carve::render_carve(&forward_document) {
            Ok(value) if value == rendered => {}
            Ok(_) => return Self::error("Semantic edit source did not match its AST patch."),
            Err(error) => return Self::error(error.to_string()),
        }
        if let Err(error) =
            carve::apply_reversible_ast_patch(&carve::parse(&rendered), &patch, true)
        {
            return Self::error(format!("Semantic edit source is not reversible: {error}"));
        }
        for operations in [&patch.forward, &patch.inverse] {
            if operations.len() > MAX_AST_PATCH_OPERATIONS {
                return Self::error(format!(
                    "Patch has {} operations; the limit is {MAX_AST_PATCH_OPERATIONS}.",
                    operations.len()
                ));
            }
        }
        let encode_operations = |operations| -> Result<Value, String> {
            let json = carve::ast_patch_to_json(operations).map_err(|error| error.to_string())?;
            serde_json::from_str(&json).map_err(|error| error.to_string())
        };
        let forward = match encode_operations(&patch.forward) {
            Ok(value) => value,
            Err(error) => return Self::error(error),
        };
        let inverse = match encode_operations(&patch.inverse) {
            Ok(value) => value,
            Err(error) => return Self::error(error),
        };
        let changes = explain_ast_operations(&before, &patch.forward);
        let steps = resolved
            .iter()
            .map(|(selector, edit, path, node)| {
                json!({
                    "selector": selector,
                    "edit": {"kind": edit.kind},
                    "match": ast_match(path.clone(), node),
                    "notices": semantic_edit_notices(node, edit),
                })
            })
            .collect::<Vec<_>>();
        let mut notices = Vec::new();
        for notice in steps
            .iter()
            .filter_map(|step| step.get("notices").and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
        {
            if !notices.iter().any(|existing| existing == notice) {
                notices.push(notice.to_owned());
            }
        }
        let match_value = steps[0]["match"].clone();
        let reversible_patch = json!({
            "version": 1,
            "forward": forward,
            "inverse": inverse,
            "beforeFingerprint": patch.before_fingerprint,
            "afterFingerprint": patch.after_fingerprint,
            "changes": changes,
        });
        let value = json!({
            "selector": input.selector,
            "edit": {"kind": input.edit.kind},
            "match": match_value,
            "notices": notices,
            "editCount": steps.len(),
            "steps": steps,
            "reversiblePatch": reversible_patch,
            "sourcePatch": source_patch_with_kind(
                &input.source,
                &rendered,
                SourceEditKindOutputSchema::Refactor,
                "semantic-ast-edit",
            ),
        });
        match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= MAX_SOURCE_BYTES => Self::output(value),
            Ok(bytes) => Self::error(format!(
                "Semantic edit plan is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                bytes.len()
            )),
            Err(error) => Self::error(format!("Semantic edit plan serialization failed: {error}")),
        }
    }

    #[tool(
        name = "carve_create_reversible_ast_patch",
        title = "Create reversible AST patch",
        description = "Compare two PART 12 ASTs and return forward and inverse operations with semantic stale-edit fingerprints.", output_schema = rmcp::handler::server::tool::schema_for_type::<ReversibleAstPatchOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn create_reversible_ast_patch(
        &self,
        Parameters(input): Parameters<AstPatchCreateInput>,
    ) -> CallToolResult {
        let before_json = match serde_json::to_string(&input.before) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "Before AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => {
                return Self::error(format!("Before AST must be JSON-serializable: {error}"));
            }
        };
        let after_json = match serde_json::to_string(&input.after) {
            Ok(value) if value.len() <= MAX_SOURCE_BYTES => value,
            Ok(value) => {
                return Self::error(format!(
                    "After AST is {} bytes; the limit is {MAX_SOURCE_BYTES} bytes.",
                    value.len()
                ));
            }
            Err(error) => {
                return Self::error(format!("After AST must be JSON-serializable: {error}"));
            }
        };
        let result = carve::from_json(&before_json)
            .and_then(|before| carve::from_json(&after_json).map(|after| (before, after)))
            .map_err(|error| error.to_string())
            .and_then(|(before, after)| carve::create_reversible_ast_patch(&before, &after).map_err(|error| error.to_string()))
            .and_then(|mut patch| {
                patch.forward.sort_by(|left, right| ast_patch_path(left).cmp(ast_patch_path(right)));
                patch.inverse.sort_by(|left, right| ast_patch_path(left).cmp(ast_patch_path(right)));
                for operations in [&patch.forward, &patch.inverse] {
                    if operations.len() > MAX_AST_PATCH_OPERATIONS {
                        return Err(format!("Patch has {} operations; the limit is {MAX_AST_PATCH_OPERATIONS}.", operations.len()));
                    }
                }
                let forward = carve::ast_patch_to_json(&patch.forward).map_err(|error| error.to_string())?;
                let inverse = carve::ast_patch_to_json(&patch.inverse).map_err(|error| error.to_string())?;
                let changes = explain_ast_operations(&input.before, &patch.forward);
                let value = json!({
                    "version": 1,
                    "forward": serde_json::from_str::<Value>(&forward).map_err(|error| error.to_string())?,
                    "inverse": serde_json::from_str::<Value>(&inverse).map_err(|error| error.to_string())?,
                    "beforeFingerprint": patch.before_fingerprint,
                    "afterFingerprint": patch.after_fingerprint,
                    "changes": changes,
                });
                let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?.len();
                if bytes > MAX_SOURCE_BYTES { return Err(format!("Reversible patch is {bytes} bytes; the limit is {MAX_SOURCE_BYTES} bytes.")); }
                Ok(value)
            });
        match result {
            Ok(value) => Self::output(value),
            Err(error) => Self::error(error),
        }
    }

    #[tool(
        name = "carve_apply_reversible_ast_patch",
        title = "Preview reversible AST patch as source edits",
        description = "Verify a reversible AST patch against source, apply or undo it, and return a minimal stale-guarded UTF-8 source edit without writing files.", output_schema = rmcp::handler::server::tool::schema_for_type::<ReversibleAstPatchApplyOutputSchema>(),
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false)
    )]
    fn apply_reversible_ast_patch(
        &self,
        Parameters(input): Parameters<ReversibleAstPatchApplyInput>,
    ) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        if input.patch.version != 1 {
            return Self::error("Unsupported reversible patch version.");
        }
        for operations in [&input.patch.forward, &input.patch.inverse] {
            if operations.len() > MAX_AST_PATCH_OPERATIONS {
                return Self::error(format!(
                    "Patch has {} operations; the limit is {MAX_AST_PATCH_OPERATIONS}.",
                    operations.len()
                ));
            }
        }
        let patch_bytes = serde_json::to_vec(&input.patch)
            .map(|value| value.len())
            .unwrap_or(MAX_SOURCE_BYTES + 1);
        if patch_bytes > MAX_SOURCE_BYTES {
            return Self::error(format!(
                "Reversible patch is {patch_bytes} bytes; the limit is {MAX_SOURCE_BYTES} bytes."
            ));
        }
        let decode = |operations: &[Value]| -> Result<Vec<carve::AstPatchOperation>, String> {
            let value = serde_json::to_string(operations).map_err(|error| error.to_string())?;
            carve::ast_patch_from_json(&value).map_err(|error| error.to_string())
        };
        let forward = match decode(&input.patch.forward) {
            Ok(value) => value,
            Err(error) => return Self::error(error),
        };
        let inverse = match decode(&input.patch.inverse) {
            Ok(value) => value,
            Err(error) => return Self::error(error),
        };
        let fingerprint_valid = |value: &str| {
            value.len() == 24
                && value.starts_with("fnv1a64:")
                && value[8..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        };
        if !fingerprint_valid(&input.patch.before_fingerprint)
            || !fingerprint_valid(&input.patch.after_fingerprint)
        {
            return Self::error("Reversible patch requires valid before and after fingerprints.");
        }
        let patch = carve::ReversibleAstPatch {
            forward,
            inverse,
            before_fingerprint: input.patch.before_fingerprint,
            after_fingerprint: input.patch.after_fingerprint,
        };
        let expected_result = if input.inverse {
            patch.before_fingerprint.clone()
        } else {
            patch.after_fingerprint.clone()
        };
        let result =
            carve::apply_reversible_ast_patch(&carve::parse(&input.source), &patch, input.inverse)
                .map_err(|error| error.to_string())
                .and_then(|document| {
                    let actual = carve::create_reversible_ast_patch(&document, &document)
                        .map_err(|error| error.to_string())?
                        .before_fingerprint;
                    if actual != expected_result {
                        return Err("patch postcondition does not match the document".into());
                    }
                    let restored = carve::apply_ast_patch(
                        &document,
                        if input.inverse {
                            &patch.forward
                        } else {
                            &patch.inverse
                        },
                    )
                    .map_err(|error| error.to_string())?;
                    let restored_fingerprint =
                        carve::create_reversible_ast_patch(&restored, &restored)
                            .map_err(|error| error.to_string())?
                            .before_fingerprint;
                    let expected_restored = if input.inverse {
                        &patch.after_fingerprint
                    } else {
                        &patch.before_fingerprint
                    };
                    if &restored_fingerprint != expected_restored {
                        return Err("patch reverse direction does not restore the document".into());
                    }
                    let source =
                        carve::render_carve(&document).map_err(|error| error.to_string())?;
                    let ast = carve::try_to_json(&document).map_err(|error| error.to_string())?;
                    Ok((ast, source))
                });
        match result {
            Ok((ast, source)) => match serde_json::from_str::<Value>(&ast) {
                Ok(ast) => {
                    let direction = if input.inverse { "inverse" } else { "forward" };
                    let code = if input.inverse {
                        "revert-structured-ast-patch"
                    } else {
                        "apply-structured-ast-patch"
                    };
                    let source_patch = source_patch_with_kind(
                        &input.source,
                        &source,
                        SourceEditKindOutputSchema::Refactor,
                        code,
                    );
                    Self::output(
                        json!({"direction": direction, "ast": ast, "source": source, "sourcePatch": source_patch}),
                    )
                }
                Err(error) => Self::error(format!("AST serialization failed: {error}")),
            },
            Err(error) => Self::error(error),
        }
    }

    #[tool(
        name = "carve_migrate",
        title = "Migrate to Carve",
        description = "Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.", output_schema = rmcp::handler::server::tool::schema_for_type::<MigrateOutputSchema>(),
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            open_world_hint = false
        )
    )]
    fn migrate(&self, Parameters(input): Parameters<MigrateInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        if input.markdown_dialect.is_some() && input.format != SourceFormat::Markdown {
            return Self::error("markdownDialect is only valid when format is markdown.");
        }
        let result = match input.format {
            SourceFormat::Html => {
                match migrate_html(&input.source, &HtmlImportOptions::default()) {
                    Ok(result) => result,
                    Err(error) => return Self::error(format!("HTML migration failed: {error:?}")),
                }
            }
            SourceFormat::Markdown => {
                migrate_markdown_dialect(&input.source, input.markdown_dialect.as_ref())
            }
            SourceFormat::Djot => {
                let mut result = migrate_djot(&input.source);
                if result.value.ends_with('\n') {
                    result.value.pop();
                }
                result
            }
        };
        Self::output(migration_json(result, input.format))
    }
}

#[tool_handler(router = self.tools)]
impl ServerHandler for CarveServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_completions()
                .enable_prompts()
                .build(),
        )
            .with_server_info(Implementation::new("carve-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Parse, lint, format, render, and migrate Carve documents, with authoring and rule guidance.",
            )
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        Ok(ListPromptsResult::with_all_items(
            writer_prompts()
                .into_iter()
                .map(|(name, title, description, _)| {
                    Prompt::new(name, Some(description), None).with_title(title)
                })
                .collect(),
        ))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        let (_, _, description, text) = writer_prompts()
            .into_iter()
            .find(|(name, _, _, _)| *name == request.name)
            .ok_or_else(|| {
                ErrorData::invalid_params(format!("Unknown Carve prompt: {}", request.name), None)
            })?;
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description(description)
                .into(),
        )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new("carve://guide", "carve-authoring-guide")
                .with_title("Carve authoring quick start")
                .with_description("Concise, human-facing guidance for common Carve writing tasks.")
                .with_mime_type("text/markdown"),
            Resource::new("carve://rules", "carve-rule-index")
                .with_title("Normative Carve rule index")
                .with_description(
                    "Versioned map of the normative rule categories and lookup resource.",
                )
                .with_mime_type("text/markdown"),
        ]))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new("carve://rules/{ruleId}", "carve-rule")
                .with_title("Carve rule")
                .with_description("A normative rule summary selected by stable rule ID.")
                .with_mime_type("text/markdown"),
            ResourceTemplate::new("carve://lint-rules/{ruleName}", "carve-lint-rule")
                .with_title("Carve lint diagnostic")
                .with_description(
                    "An author-facing explanation selected by the stable diagnostic name returned by carve_lint.",
                )
                .with_mime_type("text/markdown"),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let text = match request.uri.as_str() {
            "carve://guide" => Some(resources::authoring_guide()),
            "carve://rules" => Some(resources::rule_index_markdown()),
            uri if uri.starts_with("carve://rules/") => {
                resources::rule_markdown(&uri["carve://rules/".len()..])
            }
            uri if uri.starts_with("carve://lint-rules/") => {
                resources::lint_rule_markdown(&uri["carve://lint-rules/".len()..])
            }
            _ => None,
        };
        let text = text.ok_or_else(|| {
            let message = if let Some(value) = request.uri.strip_prefix("carve://rules/") {
                format!(
                    "Unknown Carve rule ID: {}",
                    value.chars().take(100).collect::<String>()
                )
            } else if let Some(value) = request.uri.strip_prefix("carve://lint-rules/") {
                format!(
                    "Unknown Carve lint rule: {}",
                    value.chars().take(100).collect::<String>()
                )
            } else {
                format!("Resource not found: {}", request.uri)
            };
            ErrorData::invalid_params(message, None)
        })?;
        Ok(ReadResourceResult::new(vec![ResourceContents::text(text, request.uri)]).into())
    }

    async fn complete(
        &self,
        request: CompleteRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CompleteResult, ErrorData> {
        let value = request.argument.value;
        let values = match (
            request.r#ref.as_resource_uri(),
            request.argument.name.as_str(),
        ) {
            (Some("carve://rules/{ruleId}"), "ruleId") => resources::rule_ids()
                .into_iter()
                .filter(|id| id.starts_with(&value.to_uppercase()))
                .map(str::to_owned)
                .take(CompletionInfo::MAX_VALUES)
                .collect(),
            (Some("carve://lint-rules/{ruleName}"), "ruleName") => resources::lint_rule_names()
                .filter(|name| name.starts_with(&value.to_lowercase()))
                .map(str::to_owned)
                .take(CompletionInfo::MAX_VALUES)
                .collect(),
            _ => Vec::new(),
        };
        Ok(CompleteResult::new(
            CompletionInfo::with_all_values(values)
                .expect("completion results are limited to the protocol maximum"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_dialect_is_explicit() {
        assert_eq!(
            migrate_markdown_dialect("==marked==", None).value,
            "==marked=="
        );
        assert_eq!(
            migrate_markdown_dialect(
                "==marked==",
                Some(&MarkdownDialect {
                    highlight: true,
                    ..Default::default()
                })
            )
            .value,
            "=marked="
        );
        assert_eq!(migrate_markdown_dialect("^[note]", None).value, "\\^[note]");
        assert_eq!(
            migrate_markdown_dialect(
                "^[note]",
                Some(&MarkdownDialect {
                    inline_footnotes: true,
                    ..Default::default()
                })
            )
            .value,
            "^[note]"
        );
    }

    #[test]
    fn lint_offsets_use_utf16() {
        assert_eq!(utf16_offset("😀x", 1), 0);
        let warnings = lint_values("😀 @person", &[LintPlatform::Github]);
        assert_eq!(warnings[0]["start"], 3);
        assert_eq!(warnings[0]["end"], 10);
    }

    #[test]
    fn github_tokens_inside_fences_are_ignored() {
        assert!(lint_values("```\n@person #12\n```", &[LintPlatform::Github]).is_empty());
    }

    #[test]
    fn an_unclosed_container_is_reported() {
        let warnings = lint_values("é\n:::", &[]);
        assert_eq!(warnings[0]["rule"], "unclosed-container-fence");
        assert_eq!(warnings[0]["start"], 2);
    }

    #[test]
    fn an_unclosed_container_is_not_hidden_by_another_warning() {
        let warnings = lint_values("@person\n:::", &[LintPlatform::Github]);
        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[1]["rule"], "unclosed-container-fence");
    }

    #[test]
    fn dialect_placeholder_cannot_collide_with_source_text() {
        let source = "CARVEMCPDIALECTTOKEN0X ==marked==";
        assert_eq!(
            migrate_markdown_dialect(
                source,
                Some(&MarkdownDialect {
                    highlight: true,
                    ..Default::default()
                })
            )
            .value,
            "CARVEMCPDIALECTTOKEN0X =marked="
        );
    }

    #[test]
    fn unified_diffs_have_context_and_preserve_missing_newlines() {
        let (value, truncated) =
            unified_diff("docs/übersicht.crv", "a   \nkeep", "a\nkeep", 10_000);
        assert!(!truncated);
        assert!(value.starts_with("--- a/docs/übersicht.crv\n+++ b/docs/übersicht.crv\n"));
        assert!(value.contains("-a   \n+a\n keep\n\\ No newline at end of file\n"));
    }
}
