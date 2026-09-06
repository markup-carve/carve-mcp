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
        ErrorData, Implementation, ListResourceTemplatesResult, ListResourcesResult,
        PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse,
        ReadResourceResult, Resource, ResourceContents, ResourceTemplate, ServerCapabilities,
        ServerInfo,
    },
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::resources;

const MAX_SOURCE_BYTES: usize = 1_000_000;

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
enum LintPlatform {
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

fn lint_values(source: &str, platforms: &[LintPlatform]) -> Vec<Value> {
    let mut warnings: Vec<Value> = lint_carve(source)
        .into_iter()
        .map(|warning| {
            json!({
                "line": warning.line, "column": warning.column, "rule": warning.rule,
                "message": warning.message, "start": utf16_offset(source, warning.start),
                "end": utf16_offset(source, warning.end),
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
                        "start": start, "end": start + found.as_str().encode_utf16().count(),
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
                    "start": utf16_offset(source, index), "end": utf16_offset(source, index + 3),
                }));
    }
    warnings.sort_by_key(|warning| warning["start"].as_u64().unwrap_or(0));
    warnings
}

#[derive(Debug, Clone)]
pub struct CarveServer {
    tools: ToolRouter<Self>,
}

impl CarveServer {
    pub fn new() -> Self {
        Self {
            tools: Self::tool_router(),
        }
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
        CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&value).expect("JSON values always serialize"),
        )])
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
    #[tool(
        name = "carve_lint",
        title = "Lint Carve",
        description = "Check Carve source for author-facing problems and silent degradation.",
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
        description = "Format Carve source canonically and report any lossy raw-format nodes.",
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
        description = "Render Carve to HTML, Markdown, plain text, or ANSI terminal text, with loss reporting.",
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
        description = "Parse and resolve Carve into its position-aware interchange AST.",
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
        description = "Migrate HTML, Markdown, or Djot source to Carve with fidelity diagnostics.",
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
                .build(),
        )
            .with_server_info(Implementation::new("carve-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Parse, lint, format, render, and migrate Carve documents, with authoring and rule guidance.",
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
}
