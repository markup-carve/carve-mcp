# Writer workflows

These small examples are prompts you can use after connecting Carve MCP to an
AI writing tool. They describe the result a writer wants; the assistant chooses
the appropriate Carve tools.

## Review an article

Open [`article.carve`](article.carve), then ask:

> Use the Carve tools to check this article. Explain each warning in plain
> language and suggest the smallest correction. Do not edit the file yet.

After reviewing the suggestions:

> Apply the agreed corrections and format the result as canonical Carve.

## Convert existing Markdown

Open [`article.md`](article.md), then ask:

> Convert this Markdown document to Carve. Preserve its meaning and list any
> content that could not be represented exactly.

For Markdown from a particular editor, mention the flavor features it uses:

> This Markdown uses `==highlight==`, inline footnotes, and fenced divs. Enable
> those dialect features during migration.

## Check text before publishing on GitHub

> Check this Carve document for GitHub-specific surprises such as accidental
> mentions or issue links. Rewrite prose where needed, but leave code examples
> unchanged.

## Preview a document

> Render this Carve document as safe HTML for a preview. Report anything that
> was dropped or changed during rendering.

## Work across a documentation folder

The package-based server can read a configured documentation root. Start it
with read-only access:

```sh
npx -y @markup-carve/carve-mcp --root /absolute/path/to/docs
```

Then ask:

> Review the Carve files in the configured documentation folder. Summarize
> repeated problems and identify the three files that most need attention.

Add `--allow-write` only when you want the assistant to propose or perform file
writes. Writes remain dry runs unless a tool call explicitly disables dry-run
mode, and overwrites require the hash returned by the preceding read.
