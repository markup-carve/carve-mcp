//! MCP's position-independent patch over the 2.0 JSON tree. The engine's
//! patch API is for full encoded trees; this host patch intentionally omits
//! source positions and parse-stage metadata, as the TypeScript host does.

use serde_json::{Value, json};

const MAX_OPERATIONS: usize = 1_000;
const MAX_BYTES: usize = 1_000_000;

fn metadata(key: &str) -> bool {
    matches!(key, "pos" | "srcByteLength" | "stages")
}

pub(crate) fn without_positions(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(without_positions).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(key, value)| {
                    !metadata(key) || (key.as_str() == "pos" && !value.is_object())
                })
                .map(|(key, value)| (key.clone(), without_positions(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn semantic_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| semantic_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            let keys_a: Vec<_> = a.keys().filter(|key| !metadata(key)).collect();
            let keys_b: Vec<_> = b.keys().filter(|key| !metadata(key)).collect();
            keys_a == keys_b && keys_a.iter().all(|key| semantic_equal(&a[*key], &b[*key]))
        }
        _ => left == right,
    }
}

fn escaped(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

pub(crate) fn diff(before: &Value, after: &Value) -> Result<Vec<Value>, String> {
    fn walk(left: &Value, right: &Value, path: &str, operations: &mut Vec<Value>) {
        if semantic_equal(left, right) {
            return;
        }
        match (left, right) {
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                for (index, (x, y)) in a.iter().zip(b).enumerate() {
                    walk(x, y, &format!("{path}/{index}"), operations);
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                for key in a
                    .keys()
                    .filter(|key| !metadata(key) && !b.contains_key(*key))
                {
                    operations
                        .push(json!({"op":"remove", "path":format!("{path}/{}",escaped(key))}));
                }
                for (key, value) in b.iter().filter(|(key, _)| !metadata(key)) {
                    let at = format!("{path}/{}", escaped(key));
                    match a.get(key) {
                        Some(previous) => walk(previous, value, &at, operations),
                        None => operations.push(json!({"op":"add", "path":at,
                            "value":without_positions(value)})),
                    }
                }
            }
            _ => operations.push(json!({"op":"replace", "path":path,
                "value":without_positions(right)})),
        }
    }
    let mut operations = Vec::new();
    walk(before, after, "", &mut operations);
    operations.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    check(&operations)?;
    Ok(operations)
}

fn check(operations: &[Value]) -> Result<(), String> {
    if operations.len() > MAX_OPERATIONS {
        return Err(format!(
            "Patch has {} operations; the limit is {MAX_OPERATIONS}.",
            operations.len()
        ));
    }
    let bytes = serde_json::to_vec(operations)
        .map_err(|e| e.to_string())?
        .len();
    if bytes > MAX_BYTES {
        return Err(format!(
            "Patch operations is {bytes} bytes; the limit is {MAX_BYTES} bytes."
        ));
    }
    Ok(())
}

pub(crate) fn apply(base: &Value, operations: &[Value]) -> Result<Value, String> {
    check(operations)?;
    let mut root = base.clone();
    for operation in operations {
        let entry = operation
            .as_object()
            .ok_or("patch operation must be an object")?;
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "op" | "path" | "value"))
        {
            return Err("patch operation has an unknown property".into());
        }
        let kind = entry
            .get("op")
            .and_then(Value::as_str)
            .ok_or("patch operation requires a string op")?;
        let path = entry
            .get("path")
            .and_then(Value::as_str)
            .ok_or("patch operation requires a string path")?;
        let value = entry.get("value");
        if matches!(kind, "add" | "replace") && value.is_none() {
            return Err("patch add and replace require a value".into());
        }
        if kind == "remove" && value.is_some() {
            return Err("patch remove must not carry a value".into());
        }
        if !matches!(kind, "add" | "replace" | "remove") {
            return Err("unknown patch operation".into());
        }
        let Some(parts) = path.strip_prefix('/').map(|text| {
            text.split('/')
                .map(|part| part.replace("~1", "/").replace("~0", "~"))
                .collect::<Vec<_>>()
        }) else {
            if path.is_empty() {
                if kind == "remove" {
                    return Err("patch cannot remove the document".into());
                }
                root = value.cloned().expect("value checked above");
                continue;
            }
            return Err(format!("patch path {path:?} is not a JSON pointer"));
        };
        let (last, parents) = parts.split_last().ok_or("patch path is empty")?;
        let mut parent = &mut root;
        for part in parents {
            parent = match parent {
                Value::Object(map) => map.get_mut(part),
                Value::Array(array) => part
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| array.get_mut(index)),
                _ => None,
            }
            .ok_or_else(|| format!("patch path {path} does not exist"))?;
        }
        match parent {
            Value::Array(array) => {
                let index = if last == "-" && kind == "add" {
                    Some(array.len())
                } else if last == "0"
                    || (!last.starts_with('0') && last.bytes().all(|byte| byte.is_ascii_digit()))
                {
                    last.parse::<usize>().ok()
                } else {
                    None
                };
                let index = index
                    .filter(|index| {
                        *index <= array.len() && (kind == "add" || *index < array.len())
                    })
                    .ok_or_else(|| format!("patch path {path} is out of range"))?;
                match kind {
                    "add" => array.insert(index, value.cloned().unwrap()),
                    "remove" => {
                        array.remove(index);
                    }
                    _ => array[index] = value.cloned().unwrap(),
                }
            }
            Value::Object(map) => {
                if kind != "add" && !map.contains_key(last) {
                    return Err(format!("patch path {path} does not exist"));
                }
                if kind == "remove" {
                    map.remove(last);
                } else {
                    map.insert(last.clone(), value.cloned().unwrap());
                }
            }
            _ => return Err(format!("patch path {path} does not exist")),
        }
    }
    Ok(without_positions(&root))
}

pub(crate) fn fingerprint(value: &Value) -> String {
    fn semantic(value: &Value, strip: bool) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| semantic(item, strip)).collect())
            }
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .filter(|(key, _)| !strip || !metadata(key))
                    .map(|(key, item)| (key.clone(), semantic(item, strip && key != "keyValues")))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    let bytes = semantic(value, true).to_string();
    let hash = bytes
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("fnv1a64:{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_ignores_source_metadata_and_changes_nested_content() {
        let before = json!({"type":"document","astVersion":"2.0","srcByteLength":1,
            "children":[{"type":"paragraph","children":[{"type":"text","value":"a", "pos":{"startOffset":0}}]}]});
        let after = json!({"type":"document","astVersion":"2.0","srcByteLength":2,
            "children":[{"type":"paragraph","children":[{"type":"text","value":"b", "pos":{"startOffset":1}}]}]});
        let operations = diff(&before, &after).unwrap();
        assert_eq!(
            operations,
            vec![json!({"op":"replace","path":"/children/0/children/0/value","value":"b"})]
        );
        assert_eq!(
            apply(&before, &operations).unwrap()["children"][0]["children"][0]["value"],
            "b"
        );
    }
}
