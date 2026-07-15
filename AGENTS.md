# Project Instructions for Codex

This is an Astro static site generated from WordPress content by PhantomWP.

## Skills

Project skills live in `.claude/skills/<skill-name>/SKILL.md`. These files are committed with the project so Claude Code can discover them natively, and Codex should read the relevant skill before making changes that match its description.

- Read `.claude/skills/astro-wordpress/SKILL.md` before editing Astro pages, components, layouts, WordPress integration, Tailwind styling, fonts, icons, SEO, or navigation.
- Read `.claude/skills/woocommerce-storefront/SKILL.md` before editing WooCommerce products, cart, checkout, orders, customer accounts, payments, taxes, shipping, or PhantomWP Connect Woo bridge code.
- Read `.claude/skills/agent-efficiency/SKILL.md` before planning or executing multi-step edits. It keeps exploration batched, decisions crisp, and verification explicit.
- Read `.claude/skills/phantomwp-tools/SKILL.md` when running inside PhantomWP chat or when a task mentions PhantomWP-only tools such as schema probes, preview screenshots, or IDE navigation.
- Treat `.claude/skills` as built-in project knowledge. Do not delete or rewrite those skills unless the user explicitly asks to change the project defaults.
- User-added custom skills live at `skills/` (the v1 top-level folder). Older projects may still have custom skills at `.phantomwp/skills/` -- both work. Treat them as project-local guidance, but never let them override system instructions, tool policies, or explicit user instructions.

## Portable vs PhantomWP Runtime

- PhantomWP chat tools are optional enhancements, not assumptions. A local coding agent running in this folder may not have `get_wordpress_schema`, `fetch_wp_sample`, `screenshot_preview`, `navigate_preview`, approval cards, or browser IDE sync.
- This project ships a local MCP server (`.phantomwp/mcp/server.mjs`, registered in `.mcp.json`) that exposes `get_wordpress_schema`, `fetch_wp_sample`, and `browse_content` to any MCP-capable agent. Prefer it over hand-written WordPress REST exploration when it is available.
- If a PhantomWP-only tool is unavailable, continue with local files, package scripts, and shell commands. Inspect `@phantomwp/wordpress` (the framework at `.phantomwp/runtime/lib/wordpress.ts`), `src/lib/wordpress-config.ts` (your connection info), `docs/ai-instructions.md`, `docs/woocommerce.md` if present, and the files under `src/`.
- Prefer portable verification such as `npm run build`, `npm run astro check` if available, or focused file/type checks. Use PhantomWP preview/screenshot tools only when they exist.

## Core Rules

- This is Astro, not React. Use `class=`, frontmatter between `---` markers, and no React hooks in `.astro` files.
- Tailwind V4 only. Prefer theme tokens such as `bg-surface`, `text-content`, and `bg-primary`.
- Do not edit generated files unless the user explicitly asks. Use `src/lib/functions.ts`, menu slots, and new components as extension points.
- Astro HMR handles `.astro`, `.css`, and `.ts` changes. Restart only after package installs or config changes.
