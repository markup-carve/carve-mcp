//! The Carve 0.2 boundary used by the MCP host. All document operations go
//! through the public API, with the host retaining its own tool wire shapes.

use carve2::api;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::{Path, PathBuf}, sync::Arc};

pub(crate) struct Included {
    pub(crate) tree: api::Tree,
    pub(crate) report: Value,
    host: api::Carve,
    options: api::Options,
}

impl Included {
    pub(crate) fn render(&self, target: &str) -> Result<Value, String> {
        if target == "html" {
            let rendered = self.host.render_tree_with_diagnostics(&self.tree, &self.options)
                .map_err(|error| error.to_string())?;
            return Ok(json!({"html":rendered.html,"diagnostics":rendered.diagnostics,
                "suppressedDiagnostics":rendered.suppressed_diagnostics}));
        }
        let written = self.host.write_to(target, &self.tree,
            &api::WriteOptions { render: self.options.clone(), ..Default::default() })
            .map_err(|error| error.to_string())?;
        Ok(json!({"output":written.output,"diagnostics":written.diagnostics}))
    }
}

fn include_resolver(root: PathBuf) -> api::Resolver {
    Arc::new(move |request: &api::Request<'_>| {
        use api::Cause;
        if Path::new(request.path).is_absolute() {
            return Err(Cause::OutsideRoot);
        }
        let base = request.from.and_then(|from| Path::new(from).parent()).unwrap_or(Path::new(""));
        let requested = root.join(base).join(request.path);
        let canonical = std::fs::canonicalize(&requested).map_err(|_| Cause::NotFound)?;
        let lexical = requested.strip_prefix(&root).map_err(|_| Cause::OutsideRoot)?;
        let resolved = canonical.strip_prefix(&root).map_err(|_| Cause::OutsideRoot)?;
        if crate::workspace::hidden_path_refusal(lexical).is_some()
            || crate::workspace::hidden_path_refusal(resolved).is_some() {
            return Err(Cause::OutsideRoot);
        }
        let code = request.options.get("code").is_some();
        if !code && (crate::workspace::document_path_refusal(lexical).is_some()
            || crate::workspace::document_path_refusal(resolved).is_some()) {
            return Err(Cause::OutsideRoot);
        }
        if !std::fs::metadata(&canonical).is_ok_and(|metadata| metadata.is_file()) {
            return Err(Cause::Unreadable);
        }
        let bytes = std::fs::read(&canonical).map_err(|_| Cause::Unreadable)?;
        let id = resolved.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        Ok((bytes, id))
    })
}

pub(crate) fn parse_included(source: &str, root: &Path, root_index: usize,
    source_path: Option<&str>, extensions: &[&str], settings: &Value) -> Result<Included, String> {
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    let mut includes = api::Includes::new(include_resolver(root.clone()));
    includes.file = source_path.map(str::to_string);
    let mut options = api::Options { includes: Some(includes), ..api::Options::default() };
    if let Some(heading_ids) = settings["headingIds"].as_str() {
        options.heading_ids = api::HeadingIds::from_name(heading_ids)
            .ok_or_else(|| format!("Unknown headingIds option {heading_ids}"))?;
    }
    options.raw_html = settings["rawHtml"].as_bool().unwrap_or(false);
    options.strict_losses = settings["strictLosses"].as_bool().unwrap_or(false);
    options.smart_typography = settings["smartTypography"].as_bool().unwrap_or(true);
    options.mode = if settings["mode"] == "static" { api::Mode::Static }
        else { api::Mode::Interactive };
    let mut host = api::Carve::default();
    for name in extensions {
        host.enable_standard(name, true).map_err(|error| error.to_string())?;
    }
    let parsed = host.parse_with_diagnostics(source, &options).map_err(|error| error.to_string())?;
    let warnings: Vec<Value> = parsed.diagnostics.iter()
        .filter(|entry| entry.code.starts_with("include"))
        .map(|entry| {
            let text = entry.file.as_deref().and_then(|file| std::fs::read_to_string(root.join(file)).ok());
            let content = text.as_deref().unwrap_or(source);
            let offset = entry.range.map_or(0, |range| range.start_offset);
            let position = api::position_of(content, offset).ok();
            let mut warning = json!({"rule":entry.code,"message":entry.message,
                "line":position.as_ref().map_or(1, |p| p.line),
                "column":position.as_ref().map_or(1, |p| p.column)});
            if let Some(file) = &entry.file { warning["file"] = json!(file); }
            warning
        }).collect();
    let mut dependencies: Vec<Value> = Vec::new();
    for dependency in api::include_dependencies(&parsed.tree) {
        let path = dependency.file.as_deref().unwrap_or(&dependency.path);
        if !dependencies.iter().any(|seen| seen["path"] == path) {
            dependencies.push(json!({"path":path,"resolved":dependency.file.is_some()}));
        }
    }
    Ok(Included { tree: parsed.tree, host, options,
        report: json!({"rootIndex":root_index,"warnings":warnings,
            "dependencies":dependencies,"suppressedWarnings":parsed.suppressed_diagnostics}) })
}

pub(crate) fn call(request: Value) -> Result<Value, String> {
    let response_text = api::json::call(&request.to_string());
    let mut decoder = serde_json::Deserializer::from_str(&response_text);
    decoder.disable_recursion_limit();
    let response: Value = Value::deserialize(&mut decoder)
        .map_err(|error| format!("Carve 0.2 response was invalid: {error}"))?;
    match response.get("ok") {
        Some(value) => Ok(value.clone()),
        None => Err(response["error"]["message"]
            .as_str()
            .unwrap_or("Carve 0.2 call failed")
            .to_string()),
    }
}

pub(crate) fn parse(source: &str, positions: bool) -> Result<Value, String> {
    parse_with_options(source, positions, json!({}))
}

pub(crate) fn parse_with_options(source: &str, positions: bool, options: Value) -> Result<Value, String> {
    Ok(call(json!({"call":"parse", "source":source, "positions":positions,
        "options":options}))?["tree"].clone())
}

pub(crate) fn format(source: &str, align_tables: bool) -> Result<Value, String> {
    call(json!({"call":"formatWithDiagnostics", "source":source,
        "options":{"alignTables":align_tables}}))
}

pub(crate) fn render(source: &str, options: Value) -> Result<Value, String> {
    call(json!({"call":"renderWithDiagnostics", "source":source, "options":options}))
}

pub(crate) fn write(tree: Value, target: &str, options: Value) -> Result<Value, String> {
    call(json!({"call":"writeWithDiagnostics", "tree":tree,
        "target":target, "options":options}))
}

pub(crate) fn render_source(source: &str, target: &str) -> Result<Value, String> {
    if target == "html" {
        render(source, json!({})).map(|result| render_result(&result, "html", None))
    } else {
        let tree = parse(source, false)?;
        write(tree, target, json!({})).map(|result| render_result(&result, "output", None))
    }
}

pub(crate) fn lint(source: &str, platforms: &[&str]) -> Result<Value, String> {
    call(json!({"call":"lint", "source":source, "options":{"platforms":platforms}}))
}

fn utf16_at(source: &str, byte: usize) -> usize {
    source.get(..byte.min(source.len())).unwrap_or("").encode_utf16().count()
}

pub(crate) fn lint_warnings(source: &str, platforms: &[&str],
    scope: Option<(&Path, Option<&str>)>) -> Result<Vec<Value>, String> {
    let mut options = api::LintOptions {
        platforms: platforms.iter().map(|platform| (*platform).to_string()).collect(),
        ..Default::default()
    };
    let root = if let Some((root, source_path)) = scope {
        let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
        let mut includes = api::Includes::new(include_resolver(root.clone()));
        includes.file = source_path.map(str::to_string);
        options.includes = Some(includes);
        Some(root)
    } else { None };
    let entries = api::lint(source, &options).map_err(|error| error.to_string())?;
    Ok(entries.iter().map(|entry| {
        let text = match (&root, &entry.file) {
            (Some(root), Some(file)) => std::fs::read_to_string(root.join(file)).ok(),
            _ => None,
        };
        let content = text.as_deref().unwrap_or(source);
        let start = entry.range.map_or(0, |range| range.start_offset);
        let end = entry.range.map_or(0, |range| range.end_offset);
        let position = api::position_of(content, start).ok();
        let mut warning = json!({
            "rule":entry.code,"message":entry.message,"severity":entry.severity,
            "channel":entry.channel,"start":utf16_at(content,start),"end":utf16_at(content,end),
            "line":position.as_ref().map_or(1, |p| p.line),
            "column":position.as_ref().map_or(1, |p| p.column),
            "resourceUri":format!("carve://lint-rules/{}",entry.code),
        });
        if let Some(path) = &entry.path { warning["path"] = json!(path); }
        if let Some(file) = &entry.file { warning["file"] = json!(file); }
        warning
    }).collect())
}

pub(crate) fn import(source: &str, from: &str) -> Result<Value, String> {
    call(json!({"call":"importDocument", "source":source, "from":from}))
}

pub(crate) fn migration(source: &str, from: &str) -> Result<Value, String> {
    let result = import(source, from)?;
    let diagnostics = result["diagnostics"].as_array().cloned().unwrap_or_default();
    let diagnostics: Vec<Value> = diagnostics.iter().map(|entry| {
        let severity = if entry["severity"] == "hint" { "info" }
            else { entry["severity"].as_str().unwrap_or("warning") };
        let mut row = json!({"code":entry["code"],"message":entry["message"],
            "severity":severity});
        if let Some(path) = entry["path"].as_str() { row["path"] = json!(path); }
        if from != "html" {
            if let Some(start) = entry.pointer("/range/startOffset").and_then(Value::as_u64) {
                if let Ok(pos) = api::position_of(source, start as usize) {
                    row["line"] = json!(pos.line);
                    row["column"] = json!(pos.column);
                }
            }
        }
        row
    }).collect();
    Ok(json!({"value":result["source"],"report":{"schemaVersion":3,
        "sourceFormat":from,"diagnostics":diagnostics}}))
}

pub(crate) fn render_result(result: &Value, field: &str, max_losses: Option<usize>) -> Value {
    let diagnostics = result["diagnostics"].as_array().cloned().unwrap_or_default();
    let losses: Vec<_> = diagnostics
        .into_iter()
        .filter(|entry| entry["channel"] == "render-loss")
        .collect();
    let total = losses.len();
    let maximum = max_losses.unwrap_or(total);
    let reported: Vec<_> = losses.into_iter().take(maximum).collect();
    json!({"value": result[field], "losses": reported,
        "totalLosses": total, "truncated": total > maximum ||
        result["suppressedDiagnostics"].as_u64().unwrap_or(0) > 0,
        "diagnostics": result["diagnostics"]})
}

fn validated_tree(value: &Value, label: &str) -> Result<(), String> {
    let bytes = value.to_string().len();
    if bytes > 1_000_000 {
        return Err(format!("{label} is {bytes} bytes; the limit is 1000000 bytes."));
    }
    api::decode_tree(&value.to_string()).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn create_patch(before: &Value, after: &Value) -> Result<Value, String> {
    validated_tree(before, "Before AST")?;
    validated_tree(after, "After AST")?;
    let operations = crate::ast_patch2::diff(before, after)?;
    let mut nodes = crate::server::ast_nodes(before);
    nodes.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
    let changes: Vec<Value> = operations.iter().map(|operation| {
        let path = operation["path"].as_str().unwrap_or("");
        let owner = nodes.iter().filter(|(node_path, _)| node_path.is_empty()
            || path == node_path || path.starts_with(&format!("{node_path}/")))
            .find(|(_, node)| crate::server::ast_identity(node).is_some())
            .or_else(|| nodes.iter().filter(|(node_path, _)| node_path.is_empty()
                || path == node_path || path.starts_with(&format!("{node_path}/")))
                .find(|(_, node)| node["type"] != "text"));
        let kind = operation["op"].as_str().unwrap_or("replace");
        let field = path.rsplit('/').next().filter(|field| !field.is_empty()).unwrap_or("document")
            .replace("~1", "/").replace("~0", "~");
        let target = owner.map(|(_, node)| {
            let kind = node["type"].as_str().unwrap_or("document");
            crate::server::ast_identity(node).map_or_else(|| kind.to_string(),
                |id| format!("{kind} “{id}”"))
        }).unwrap_or_else(|| "document".into());
        let verb = match kind { "add" => "Added", "remove" => "Removed", _ => "Changed" };
        let summary = if field == "value" && owner.is_some() {
            format!("Changed text in {target}.")
        } else {
            format!("{verb} {field} on {target}.")
        };
        json!({"kind":kind, "path":path, "target":target, "summary":summary})
    }).collect();
    let output = json!({"operations":operations,"operationCount":operations.len(),
        "changeCount":changes.len(),"changes":changes});
    if output.to_string().len() > 1_000_000 {
        return Err(format!("AST patch result is {} bytes; the limit is 1000000 bytes.", output.to_string().len()));
    }
    Ok(output)
}

pub(crate) fn reversible_patch(before: &Value, after: &Value) -> Result<Value, String> {
    let forward = create_patch(before, after)?;
    let inverse = create_patch(after, before)?;
    Ok(json!({"version":1,"forward":forward["operations"],"inverse":inverse["operations"],
        "beforeFingerprint":crate::ast_patch2::fingerprint(before),
        "afterFingerprint":crate::ast_patch2::fingerprint(after),
        "changes":forward["changes"]}))
}

pub(crate) fn apply_patch(ast: &Value, operations: &[Value]) -> Result<Value, String> {
    validated_tree(ast, "AST")?;
    let patched = crate::ast_patch2::apply(ast, operations)?;
    validated_tree(&patched, "Patched AST")?;
    let written = write(patched, "carve", json!({}))?;
    let source = written["output"].as_str().ok_or("Carve writer returned no source")?;
    let reparsed = parse(source, false)?;
    Ok(json!({"ast":reparsed, "source":source}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_parse_and_render_use_the_public_boundary() {
        let tree = parse("= Title\n", true).unwrap();
        assert_eq!(tree["astVersion"], "2.0");
        assert_eq!(tree["children"][0]["type"], "heading");
        assert_eq!(render("= Title\n", json!({})).unwrap()["html"],
            "<section id=\"Title\">\n  <h1>Title</h1>\n</section>");
    }
}
