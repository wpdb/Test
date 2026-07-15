---
name: phantomwp-tools
description: Use only when running inside PhantomWP chat or when PhantomWP-specific tools are available. Explains how to use schema, preview, screenshot, task, and IDE tools while preserving portable fallbacks for local agents.
---

# PhantomWP Tools

Use only when running inside PhantomWP or when the named tools are available. If these tools are unavailable, fall back to local files and shell commands.

## WordPress Discovery

- Prefer `get_wordpress_schema` before building pages that consume WordPress post types, taxonomies, ACF/SCF fields, or plugin-specific data.
- Use `wp_probe_schema` for a small fresh check of known slugs after scaffold changes.
- Use `fetch_wp_sample` when schema fields are unknown or nested field shapes matter.

Fallback when unavailable:
- Inspect `@phantomwp/wordpress` (`.phantomwp/runtime/lib/wordpress.ts`) for generated helper names and return shapes.
- Inspect `src/lib/wordpress-config.ts` for the project's WordPress connection (URL, secret, image-source mode).
- Inspect `src/lib/functions.ts`, existing pages, and `docs/ai-instructions.md`.
- For WooCommerce projects, inspect `docs/woocommerce.md` and `src/lib/local-product-data.ts` if present.

## Preview And Visual Checks

- Use `screenshot_preview` when the user explicitly asks to see something, reports a visual issue, or after a non-obvious layout change.
- Use `navigate_preview` only when the preview is not already on the target path.
- Do not use screenshots just to locate a pinned element when source context is already provided.

Fallback when unavailable:
- Run local verification such as `npm run build` or `npm run astro check`.
- Inspect the changed Astro/CSS structure directly and mention that no browser screenshot was available.

## File And IDE Sync

- In PhantomWP chat, use provided file tools and approval flow for writes.
- If `phantomwp-ide` is available in a local shell, use it after meaningful edits:
  - `phantomwp-ide open <file> [line]`
  - `phantomwp-ide refresh-files [folder]`
  - `phantomwp-ide preview <path>`
- If the command is unavailable, skip it without blocking the coding task.

## Progress And Completion

- Use task/progress tools only for multi-step work where they reduce ambiguity.
- End only after the last tool or command succeeded, or after reporting the exact blocker.
- Prefer portable verification first: `npm run build`, `npm run astro check` if available, or targeted tests.
