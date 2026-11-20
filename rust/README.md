# Carve MCP for Rust

This package is the native Carve MCP server. It consumes `carve-lang` and
serves MCP over stdio as the `carve-mcp-rs` binary. GitHub releases distribute
the native binaries. The crate is not published to crates.io. CI checks the
pinned engine build and the TypeScript server comparison.

The Rust server uses the pinned Carve 0.2 API and offers the same local tools as
the TypeScript server:

- Document review: `carve_lint`, `carve_diagnose_and_fix`, `carve_format`,
  `carve_render`, `carve_check_targets`, `carve_parse`
- Structured edits: `carve_create_ast_patch`, `carve_apply_ast_patch`,
  `carve_select_ast_nodes`, `carve_get_block`, `carve_replace_source`,
  `carve_plan_ast_edit`, `carve_create_reversible_ast_patch`,
  `carve_apply_reversible_ast_patch`
- Conversion: `carve_migrate`, `carve_upgrade`
- Workspace: `carve_workspace_info`, `carve_read_file`, `carve_list_files`,
  `carve_review_workspace`, `carve_reference_graph`, `carve_prepare_edit`,
  `carve_prepare_workspace_edits`, `carve_write_file`, `carve_reviewed_edit`,
  `carve_undo_reviewed_edit`

Carve 0.2's Rust API does not provide BBCode import. The Rust migrate tool
reports that limitation under C2-T-003. The upgrade tool uses the installed
Carve CLI because the 0.2 library does not expose the 0.1 source upgrader.

With one or more `--root` arguments it also provides guarded file discovery,
workspace review, reads, single-file and batch edit previews, and unified
diffs. `--allow-write` enables atomic, hash-guarded writes; writes remain dry runs unless the caller opts in on the
individual call.

It also serves the writer prompts, authoring guide, normative rule index and
rule lookup, and lint-diagnostic explanations available from the package-based
server. Tools return human-readable summaries and schema-declared structured
results.

Run `carve-mcp-rs --help` or `carve-mcp-rs --version` for command information.
Use `--config carve-mcp.json` for the same relative roots, exclusions, review
limits, platform defaults, and link-check switches supported by the npm server.
The configuration cannot enable writes.

The 0.2 conformance check drives both implementations through MCP, compares
all tool names and representative results, and checks a reviewed edit followed
by its undo. The resource check compares the available resource text and
templates with the TypeScript server. HTTP remains TypeScript-only; the Rust
binary provides the same local authoring and guarded project workflow over
stdio.
