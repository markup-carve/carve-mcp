//! Embedded Carve 0.2 resources. The generated bundle is taken from the same
//! vendored spec and formatting functions as the TypeScript server.

use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceData {
    text: BTreeMap<String, String>,
    rule_ids: Vec<String>,
    spec_document_names: Vec<String>,
    upgrade_entry_ids: Vec<String>,
    lint_rule_names: Vec<String>,
}

fn data() -> &'static ResourceData {
    static DATA: OnceLock<ResourceData> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../resources/resource-texts.json"))
            .expect("generated Carve 0.2 resources must be valid JSON")
    })
}

pub fn read(uri: &str) -> Option<String> {
    let normalized = if let Some(id) = uri.strip_prefix("carve://rules/") {
        format!("carve://rules/{}", id.to_uppercase())
    } else if let Some(id) = uri.strip_prefix("carve://upgrade-map/") {
        format!("carve://upgrade-map/{}", id.to_uppercase())
    } else if let Some(name) = uri.strip_prefix("carve://lint-rules/") {
        format!("carve://lint-rules/{}", name.to_lowercase())
    } else {
        uri.to_string()
    };
    data().text.get(&normalized).cloned()
}

pub fn rule_ids() -> impl Iterator<Item = &'static str> {
    data().rule_ids.iter().map(String::as_str)
}

pub fn spec_document_names() -> impl Iterator<Item = &'static str> {
    data().spec_document_names.iter().map(String::as_str)
}

pub fn upgrade_entry_ids() -> impl Iterator<Item = &'static str> {
    data().upgrade_entry_ids.iter().map(String::as_str)
}

pub fn lint_rule_names() -> impl Iterator<Item = &'static str> {
    data().lint_rule_names.iter().map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_rules_are_readable() {
        assert!(rule_ids().count() > 100);
        assert!(
            read("carve://rules")
                .unwrap()
                .contains("Normative Carve 0.2 rule index")
        );
        assert!(read("carve://rules/C2-T-005").unwrap().contains("C2-T-005"));
        assert!(read("carve://rules/unknown").is_none());
    }

    #[test]
    fn lint_rule_lookup_is_case_insensitive() {
        assert!(read("carve://lint-rules/UNCLOSED-CONTAINER-FENCE").is_some());
        let names = lint_rule_names().collect::<Vec<_>>();
        assert!(names.len() > 90);
        assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
