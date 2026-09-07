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
struct RenderOutputSchema {
    value: String,
    losses: Vec<Value>,
    total_losses: i64,
    truncated: bool,
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
    losses: Vec<Value>,
    total_losses: i64,
    truncated: bool,
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
struct LintInput {
    #[schemars(description = "Document source (maximum 1000000 UTF-8 bytes)")]
    source: String,
    #[serde(default)]
    #[schemars(default = "empty_platforms")]
    platforms: Vec<LintPlatform>,
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

    #[tool(name = "carve_prepare_edit", title = "Preview canonical Carve formatting", description = "Read and canonically format a Carve workspace file, returning a hash-guarded proposal without writing.", output_schema = rmcp::handler::server::tool::schema_for_type::<EditOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
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
                Self::output(
                    json!({"rootIndex":input.root_index,"path":input.path,"expectedSha256":read["sha256"],"changed":result.value != source,"proposedContent":result.value,"unifiedDiff":diff,"diffTruncated":diff_truncated,"losses":result.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),"totalLosses":result.total_losses,"truncated":result.truncated}),
                )
            }
            Err(error) => Self::error(error.to_string()),
        }
    }

    #[tool(name = "carve_prepare_workspace_edits", title = "Preview canonical formatting across a workspace", description = "Prepare bounded, hash-guarded formatting proposals and unified diffs for selected or discovered Carve files without writing.", output_schema = rmcp::handler::server::tool::schema_for_type::<BatchEditOutputSchema>(), annotations(read_only_hint = true, destructive_hint = false, open_world_hint = false))]
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
                    let mut item = json!({"path":path,"status":"ready","expectedSha256":read["sha256"],"changed":changed,"mode":if result.total_losses == 0 { "automatic-format" } else { "writer-review" },"unifiedDiff":diff,"diffTruncated":diff_truncated,"losses":result.losses.into_iter().map(Self::loss).collect::<Vec<_>>(),"totalLosses":result.total_losses,"lossesTruncated":result.truncated});
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
