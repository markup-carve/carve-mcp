use carve::{HtmlImportOptions, html_to_carve, lint_carve, markdown_to_carve};
use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router,
};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_SOURCE_BYTES: usize = 1_000_000;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SourceInput {
    source: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LintInput {
    source: String,
    #[serde(default)]
    platforms: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RenderInput {
    source: String,
    target: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct MigrateInput {
    source: String,
    format: String,
}

#[derive(Debug, Clone)]
struct CarveServer {
    tools: ToolRouter<Self>,
}

impl CarveServer {
    fn new() -> Self {
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
}

#[tool_router]
impl CarveServer {
    #[tool(
        name = "carve_lint",
        description = "Check Carve source for author-facing problems and silent degradation."
    )]
    fn lint(&self, Parameters(input): Parameters<LintInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        let _ = input.platforms;
        let warnings: Vec<Value> = lint_carve(&input.source)
            .into_iter()
            .map(|warning| {
                json!({
                    "line": warning.line, "column": warning.column, "rule": warning.rule,
                    "message": warning.message, "start": warning.start, "end": warning.end,
                })
            })
            .collect();
        Self::output(
            json!({"valid": warnings.is_empty(), "warningCount": warnings.len(), "warnings": warnings}),
        )
    }

    #[tool(
        name = "carve_format",
        description = "Format Carve source canonically."
    )]
    fn format(&self, Parameters(input): Parameters<SourceInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        Self::output(json!({"value": carve::to_carve(&input.source)}))
    }

    #[tool(
        name = "carve_render",
        description = "Render Carve to HTML, Markdown, plain text, or ANSI terminal text."
    )]
    fn render(&self, Parameters(input): Parameters<RenderInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        let output = match input.target.as_str() {
            "html" => carve::to_html_with_options(
                &input.source,
                &carve::Options::default().with_raw_html(false),
            ),
            "markdown" => carve::to_markdown(&input.source),
            "plain" => carve::to_plain_text(&input.source),
            "ansi" => carve::to_ansi(&input.source),
            _ => {
                return Self::error("target must be html, markdown, plain, or ansi");
            }
        };
        Self::output(json!({"value": output}))
    }

    #[tool(
        name = "carve_parse",
        description = "Parse and resolve Carve into its position-aware interchange AST."
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
        description = "Migrate HTML, Markdown, or Djot source to Carve."
    )]
    fn migrate(&self, Parameters(input): Parameters<MigrateInput>) -> CallToolResult {
        if let Err(error) = Self::checked(&input.source) {
            return Self::error(error);
        }
        let output = match input.format.as_str() {
            "html" => match html_to_carve(&input.source, &HtmlImportOptions::default()) {
                Ok(result) => result.value,
                Err(error) => {
                    return Self::error(format!("HTML migration failed: {error:?}"));
                }
            },
            "markdown" => markdown_to_carve(&input.source),
            "djot" => carve::djot_to_carve(&input.source),
            _ => return Self::error("format must be html, markdown, or djot"),
        };
        Self::output(json!({"value": output}))
    }
}

#[tool_handler(router = self.tools)]
impl ServerHandler for CarveServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("carve-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions("Parse, lint, format, render, and migrate Carve documents.")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = CarveServer::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
