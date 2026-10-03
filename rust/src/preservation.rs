use serde_json::{Value, json};

use crate::server::AST_CHILD_FIELDS;

fn populated(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => values.values().any(populated),
        _ => true,
    }
}

fn full_header(row: &Value) -> bool {
    row["cells"].as_array().is_some_and(|cells| {
        cells.iter().any(|cell| cell["header"] == true)
            && cells
                .iter()
                .all(|cell| cell["header"] == true || cell.get("span").is_some())
    })
}

fn add(diagnostics: &mut Vec<Value>, total: &mut usize, path: &str, field: &str, message: &str) {
    *total += 1;
    if diagnostics.len() < 100 {
        diagnostics.push(
            json!({"code":"table-field-degraded","path":path,"field":field,"message":message}),
        );
    }
}

/// Keep table-structure-v1 aligned with the JavaScript assessment.
pub(crate) fn assess(ast: &Value, target: &str) -> Value {
    let mut diagnostics = Vec::new();
    let mut total = 0;
    let mut stack = vec![(ast, String::new())];
    while let Some((value, path)) = stack.pop() {
        if let Some(values) = value.as_array() {
            for (index, child) in values.iter().enumerate().rev() {
                stack.push((child, format!("{path}/{index}")));
            }
            continue;
        }
        let Some(object) = value.as_object() else {
            continue;
        };
        if value["type"] == "table" {
            if target == "html" {
                if populated(&value["shortCaption"]) {
                    add(
                        &mut diagnostics,
                        &mut total,
                        &path,
                        "shortCaption",
                        "The short caption is not emitted by the HTML renderer.",
                    );
                }
            } else {
                for (field, message) in [
                    (
                        "caption",
                        "Caption text survives, but its table-caption association is flattened.",
                    ),
                    ("shortCaption", "The short caption is not emitted."),
                ] {
                    if populated(&value[field]) {
                        add(&mut diagnostics, &mut total, &path, field, message);
                    }
                }
                let rows = value["rows"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                let leading_headers = rows.iter().take_while(|row| full_header(row)).count();
                let groups = &value["rowGroups"];
                let bodies = groups["bodies"].as_array();
                let implicit_groups = groups["headRows"].as_u64() == Some(leading_headers as u64)
                    && groups["footRows"] == 0
                    && bodies.is_some_and(|bodies| {
                        bodies.len() == 1 && {
                            let body = &bodies[0];
                            body["headRows"] == 0
                                && body["bodyRows"].as_u64()
                                    == Some((rows.len() - leading_headers) as u64)
                                && (body.get("rowHeadColumns").is_none()
                                    || body["rowHeadColumns"] == 0)
                                && !populated(&body["attrs"])
                                && !populated(&groups["headAttrs"])
                                && !populated(&groups["footAttrs"])
                        }
                    });
                if populated(groups) && !implicit_groups {
                    add(
                        &mut diagnostics,
                        &mut total,
                        &path,
                        "rowGroups",
                        "Explicit table head, body, and foot grouping is not preserved.",
                    );
                }
                for (field, message) in [
                    ("attrs", "Table attributes are not emitted."),
                    ("columns", "Column metadata is not fully preserved."),
                ] {
                    if populated(&value[field]) {
                        add(&mut diagnostics, &mut total, &path, field, message);
                    }
                }
                let mut aligns = Vec::<Option<&Value>>::new();
                let mut saw_header = false;
                for row in rows {
                    let header = full_header(row);
                    if header && !saw_header {
                        aligns.clear();
                    }
                    if let Some(cells) = row["cells"].as_array() {
                        for (column, cell) in cells.iter().enumerate() {
                            if aligns.len() <= column {
                                aligns.resize(column + 1, None);
                            }
                            if let Some(align) = cell.get("align") {
                                if header || (!saw_header && aligns[column].is_none()) {
                                    aligns[column] = Some(align);
                                }
                            }
                        }
                    }
                    if header {
                        saw_header = true;
                    }
                }
                let mut column_aligns = Vec::<Option<&Value>>::new();
                let header_end = groups["headRows"]
                    .as_u64()
                    .map(|count| count as usize)
                    .unwrap_or(leading_headers);
                for row in rows.iter().take(header_end) {
                    if let Some(cells) = row["cells"].as_array() {
                        for (c, cell) in cells.iter().enumerate() {
                            if cell.get("span").is_some() {
                                continue;
                            }
                            if let Some(align) = cell.get("align") {
                                let extent = cell["colspan"].as_u64().unwrap_or(1) as usize;
                                if column_aligns.len() < c + extent {
                                    column_aligns.resize(c + extent, None);
                                }
                                for slot in &mut column_aligns[c..c + extent] {
                                    *slot = Some(align);
                                }
                            }
                        }
                    }
                }
                let mut selected_header = false;
                for (r, row) in rows.iter().enumerate() {
                    let row_path = format!("{path}/rows/{r}");
                    if populated(&row["attrs"]) {
                        add(
                            &mut diagnostics,
                            &mut total,
                            &row_path,
                            "attrs",
                            "Row attributes are not emitted.",
                        );
                    }
                    let cells = row["cells"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    let header = full_header(row);
                    let retains_header = if target == "markdown" {
                        header && !selected_header
                    } else {
                        target == "ansi" && cells.iter().all(|cell| cell["header"] == true)
                    };
                    if header && target == "markdown" && !selected_header && r > 0 {
                        add(
                            &mut diagnostics,
                            &mut total,
                            &row_path,
                            "rowOrder",
                            "The header row moves ahead of preceding data rows.",
                        );
                    }
                    if header && target == "markdown" {
                        selected_header = true;
                    }
                    for (c, cell) in cells.iter().enumerate() {
                        if cell.get("span").is_some() {
                            continue;
                        }
                        let cell_path = format!("{row_path}/cells/{c}");
                        for (field, message) in [
                            ("rowspan", "The merged cell becomes independent rows."),
                            ("colspan", "The merged cell becomes independent columns."),
                        ] {
                            if cell[field].as_u64().is_some_and(|span| span > 1) {
                                add(&mut diagnostics, &mut total, &cell_path, field, message);
                            }
                        }
                        if cell["header"] == true && !retains_header {
                            add(
                                &mut diagnostics,
                                &mut total,
                                &cell_path,
                                "header",
                                "The header-cell role is not preserved in the output format.",
                            );
                        }
                        for (field, message) in [
                            (
                                "blocks",
                                "Block cell content is flattened into a text cell.",
                            ),
                            ("attrs", "Cell attributes are not emitted."),
                        ] {
                            if populated(&cell[field]) {
                                add(&mut diagnostics, &mut total, &cell_path, field, message);
                            }
                        }
                        if cell.get("valign").is_some() {
                            add(
                                &mut diagnostics,
                                &mut total,
                                &cell_path,
                                "valign",
                                "Vertical cell alignment is not emitted.",
                            );
                        }
                        let effective = cell
                            .get("align")
                            .or_else(|| column_aligns.get(c).copied().flatten())
                            .or_else(|| value["columns"][c].get("align"));
                        let changed = if target == "markdown" {
                            effective.and_then(Value::as_str).unwrap_or("left")
                                != aligns
                                    .get(c)
                                    .copied()
                                    .flatten()
                                    .and_then(Value::as_str)
                                    .unwrap_or("left")
                        } else {
                            effective.is_some_and(|align| align.as_str() != Some("left"))
                        };
                        if changed {
                            add(
                                &mut diagnostics,
                                &mut total,
                                &cell_path,
                                "align",
                                "Per-cell alignment is not preserved.",
                            );
                        }
                    }
                }
            }
        }
        if value["type"].is_string() {
            for field in AST_CHILD_FIELDS.iter().rev() {
                if let Some(child) = object.get(*field) {
                    stack.push((child, format!("{path}/{field}")));
                }
            }
        } else {
            for (key, child) in object.iter().rev() {
                stack.push((
                    child,
                    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                ));
            }
        }
    }
    json!({"assessment":"table-structure-v1","target":target,"complete":false,
        "checked":["table spans","caption association","short captions","header roles and row order","row groups","table/row/cell attributes","column metadata","block cells","horizontal and vertical cell alignment"],
        "unchecked":["non-table semantics","assets","host behavior","final PDF artifacts","source spelling","extension-generated tables"],
        "diagnostics":diagnostics,"totalDiagnostics":total,"maxDiagnostics":100,"truncated":total > diagnostics.len()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_fields_are_assessed_without_extending_render_losses() {
        let source = "|= System |= Limit | < |\n| A | Cold | 20 |\n| ^ | Hot | 10 |\n^ Limits\n";
        let ast: Value = serde_json::from_str(&carve::to_json_with_options(
            source,
            &carve::Options::default(),
        ))
        .unwrap();
        assert_eq!(assess(&ast, "markdown")["totalDiagnostics"], 3);
        assert_eq!(assess(&ast, "html")["totalDiagnostics"], 0);
        let moved: Value = serde_json::from_str(&carve::to_json_with_options(
            "| 1 | 2 |\n|= A |= B |\n",
            &carve::Options::default(),
        ))
        .unwrap();
        assert_eq!(
            assess(&moved, "markdown")["diagnostics"][0]["field"],
            "rowOrder"
        );
    }
}
