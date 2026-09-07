export const writerPrompts = [
  {
    name: 'review-document', title: 'Review a Carve document',
    description: 'Review a Carve document for clear, correct, human-focused writing.',
    text: 'Review the supplied Carve document. Run carve_lint first. Explain issues in plain language, distinguish safe formatting from changes that require author judgment, preserve the author\'s voice, and do not write without showing the proposed result first.',
  },
  {
    name: 'convert-markdown', title: 'Convert Markdown safely',
    description: 'Convert Markdown to Carve while explaining fidelity warnings.',
    text: 'Convert the supplied Markdown with carve_migrate. Explain fidelity diagnostics in plain language, preserve meaning and structure, then lint the converted Carve. Do not hide dropped or degraded content.',
  },
  {
    name: 'prepare-for-github', title: 'Prepare writing for GitHub',
    description: 'Check a Carve document for GitHub-specific publishing surprises.',
    text: 'Prepare the supplied Carve document for GitHub. Lint with the github platform enabled, explain anything GitHub may relink or render unexpectedly, and show proposed changes before applying them.',
  },
  {
    name: 'explain-warnings', title: 'Explain Carve warnings',
    description: 'Turn Carve diagnostics into concise, actionable writing guidance.',
    text: 'Explain the supplied Carve warnings for a human writer. Use each carve://lint-rules/{ruleName} resource when useful. Say what readers would experience, identify safe fixes, and present ambiguous choices without silently choosing one.',
  },
  {
    name: 'preview-document', title: 'Preview a Carve document',
    description: 'Render and assess a document without changing its source.',
    text: 'Preview the supplied Carve document in the requested target. Report rendering losses and important accessibility or readability concerns. Do not modify the source.',
  },
  {
    name: 'review-workspace', title: 'Review a documentation folder',
    description: 'Review an authorized documentation workspace as a bounded project.',
    text: 'Review the authorized documentation workspace with carve_review_workspace. Prioritize problems that affect readers, use its fix plan to separate lossless formatting from changes requiring judgment, and call out broken local links and anchors. Use carve_prepare_workspace_edits for a readable batch preview. Do not write files without previewing and receiving approval.',
  },
] as const;
