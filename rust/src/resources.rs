use std::sync::OnceLock;

use serde::Deserialize;

const DOCS_BASE: &str = "https://markup-carve.github.io/carve";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleData {
    source_commit: String,
    index: RuleIndex,
}

#[derive(Deserialize)]
struct RuleIndex {
    scopes: Vec<Scope>,
    rules: Vec<Rule>,
    retired: Vec<RetiredRule>,
}

#[derive(Deserialize)]
struct Scope {
    id: String,
    title: String,
    description: String,
}

#[derive(Deserialize)]
struct Rule {
    id: String,
    part: String,
    title: String,
    scope: String,
}

#[derive(Deserialize)]
struct RetiredRule {
    id: String,
    title: String,
    replacement: String,
}

fn data() -> &'static RuleData {
    static DATA: OnceLock<RuleData> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../resources/rules.json"))
            .expect("generated rule resources must be valid JSON")
    })
}

pub fn authoring_guide() -> String {
    format!(
        r#"# Carve authoring quick start

This guide covers the forms writers use most. It accompanies Carve language
specification {} and the Rust engine {}.

## Everyday text

| Write | Meaning |
| --- | --- |
| `/italic/` | emphasis |
| `*bold*` | strong emphasis |
| `_underline_` | underline |
| `~strike~` | deleted text |
| <code>&#96;code&#96;</code> | inline code |
| `[text](url)` | link |
| `![alt](image.jpg)` | image |
| `[^1]` and `[^1]: Note` | footnote |

Use a backslash before ASCII punctuation when it should stay literal.

## Structure

`#` through `######` create headings. Use `-` for bullet lists,
`1.` for numbered lists, `- [ ]` for tasks, and `>` for quotations.
Fenced code blocks use three backticks followed immediately by the language.

Put block attributes on their own line immediately before a block:

`{{#stable-id .wide key=value}}`  
`# A heading`

Inline attributes follow the inline construct: `*important*{{.highlight}}`.

Containers use matching colon fences:

```carve
::: note "Optional title"
Body
:::
```

Keep the space after the opening colons; without it the line is ordinary text.
Use one more colon for each nested container.

## Tables and captions

Pipe tables need no delimiter row. Attach `=` to the pipe, then add a space,
to make a header cell: `|= Name |= Value |`. Put a line beginning with `^`
after an image, quote, table, or code block to add a caption.

## Good defaults

- Prefer explicit links; bare URLs remain literal.
- Keep block markers at the container's content column.
- Run `carve_lint` before publishing and `carve_format` for canonical source.
- Check `losses` or migration diagnostics before accepting converted output.

Full examples: {DOCS_BASE}/examples
Complete cheat sheet: {DOCS_BASE}/cheatsheet
Syntax edge cases: {DOCS_BASE}/parsing-ambiguities
"#,
        carve::SPEC_VERSION,
        env!("CARVE_LANG_VERSION")
    )
}

pub fn rule_index_markdown() -> String {
    let rules = data();
    let scopes = rules
        .index
        .scopes
        .iter()
        .map(|scope| {
            format!(
                "- **{}**: {} ({DOCS_BASE}/rules/{})",
                scope.title, scope.description, scope.id
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# Normative Carve rule index\n\nThis is an explicitly pinned development snapshot of the Carve {}\nlanguage contract from markup-carve/carve commit `{}`.\nThe server engine is carve-lang {}; those version lines are independent.\n\nThe categories below are different views of one language contract; they are\nnot optional conformance levels.\n\n{}\n\nRead `carve://rules/{{ruleId}}` for a stable normative `CARVE-*` rule's title\nand category. Linter names such as `unclosed-container-fence` belong to a\nseparate diagnostic namespace and are not normative rule IDs.\nThe complete human-readable index is at {DOCS_BASE}/rules/.\n",
        carve::SPEC_VERSION,
        rules.source_commit,
        env!("CARVE_LANG_VERSION"),
        scopes
    )
}

pub fn rule_markdown(rule_id: &str) -> Option<String> {
    let rules = data();
    let normalized = rule_id.to_uppercase();
    if let Some(rule) = rules.index.rules.iter().find(|rule| rule.id == normalized) {
        let scope = rules
            .index
            .scopes
            .iter()
            .find(|scope| scope.id == rule.scope);
        return Some(format!(
            "# {}: {}\n\nPart: {}\n\nCategory: {}\n\n{}\n\nRead this rule's category: {DOCS_BASE}/rules/{}\n\nPinned source metadata: https://github.com/markup-carve/carve/blob/{}/resources/spec/rules.json\n",
            rule.id,
            rule.title,
            rule.part,
            scope.map_or(rule.scope.as_str(), |scope| scope.title.as_str()),
            scope.map_or("", |scope| scope.description.as_str()),
            rule.scope,
            rules.source_commit
        ));
    }
    rules
        .index
        .retired
        .iter()
        .find(|rule| rule.id == normalized)
        .map(|rule| {
            let replacement = if rule.replacement.starts_with("CARVE-") {
                format!("carve://rules/{}", rule.replacement)
            } else {
                format!(
                    "https://github.com/markup-carve/carve/blob/main/{}",
                    rule.replacement
                )
            };
            format!(
                "# {}: {}\n\nThis rule is retired. Replacement: {replacement}\n",
                rule.id, rule.title
            )
        })
}

pub fn rule_ids() -> Vec<&'static str> {
    data()
        .index
        .rules
        .iter()
        .map(|rule| rule.id.as_str())
        .chain(data().index.retired.iter().map(|rule| rule.id.as_str()))
        .collect()
}

const LINT_RULES: &[(&str, &str)] = &[
    (
        "bidi-control-in-source",
        "Invisible bidirectional controls can make source read differently from its stored order.",
    ),
    (
        "block-marker-as-text",
        "A block marker is being read as ordinary text, usually because spacing or indentation is wrong.",
    ),
    (
        "braced-comment-in-a-template-source",
        "A braced comment can be interpreted by an outer template before Carve sees it.",
    ),
    (
        "broken-crossref",
        "A cross-reference does not resolve to a document target.",
    ),
    (
        "carve-version-unsupported",
        "The document requests a Carve version this engine does not support.",
    ),
    (
        "colon-fence-length-mismatch",
        "A container closer must use the same number of colons as its opener.",
    ),
    (
        "duplicate-footnote-definition",
        "More than one definition uses the same footnote label.",
    ),
    (
        "duplicate-heading-id",
        "More than one heading resolves to the same identifier.",
    ),
    (
        "fence-title-syntax",
        "A fence title or label does not use the required quoted or bracketed form.",
    ),
    ("figure-group-empty", "A composite figure has no panels."),
    (
        "figure-group-nested",
        "Composite figure groups cannot be nested.",
    ),
    (
        "figure-group-opener-metadata",
        "Figure-group metadata is placed where it cannot be represented safely.",
    ),
    (
        "figure-group-panel-number",
        "A figure panel number conflicts with the group numbering model.",
    ),
    (
        "figure-group-single-panel",
        "A composite figure has only one panel and does not need grouping.",
    ),
    (
        "footnote-labels-differ-only-in-whitespace",
        "Footnote labels differ only by whitespace and can be confused.",
    ),
    (
        "platform-issue-reference",
        "The selected publishing platform can relink a bare issue reference unexpectedly.",
    ),
    (
        "platform-mention-token",
        "The selected publishing platform can relink a bare mention unexpectedly.",
    ),
    (
        "quote-fence-ends-the-quote-above",
        "A quote fence closes a preceding quote instead of opening the intended block.",
    ),
    (
        "semantic-attribute-outside-span",
        "A semantic attribute is attached where it cannot create the intended span.",
    ),
    (
        "semantic-attribute-value-ignored",
        "The selected semantic span ignores an authored attribute value.",
    ),
    (
        "unclosed-container-fence",
        "A colon-fenced container reaches the end of the document without a closer.",
    ),
    (
        "unresolved-footnote",
        "A footnote reference has no matching definition.",
    ),
    (
        "unresolved-reference-link",
        "A reference-style link has no matching definition or heading.",
    ),
    (
        "unused-footnote-definition",
        "A footnote is defined but never referenced.",
    ),
];

pub fn lint_rule_markdown(name: &str) -> Option<String> {
    let normalized = name.to_lowercase();
    LINT_RULES
        .iter()
        .find(|(name, _)| *name == normalized)
        .map(|(name, description)| {
            format!(
                "# {name}\n\n{description}\n\nThe warning returned by `carve_lint` includes the exact location and a document-specific explanation.\n"
            )
        })
}

pub fn lint_rule_names() -> impl Iterator<Item = &'static str> {
    LINT_RULES.iter().map(|(name, _)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_rules_are_readable() {
        assert!(rule_ids().len() > 100);
        assert!(rule_index_markdown().contains("Normative Carve rule index"));
        assert!(
            rule_markdown("carve-p0-001")
                .unwrap()
                .contains("LEADING BYTE ORDER MARK")
        );
        assert!(rule_markdown("unknown").is_none());
    }

    #[test]
    fn lint_rule_lookup_is_case_insensitive() {
        assert!(lint_rule_markdown("UNCLOSED-CONTAINER-FENCE").is_some());
        let names = lint_rule_names().collect::<Vec<_>>();
        assert_eq!(names.len(), 24);
        assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
