# Tailwind v4 Theming Guide

PhantomWP's Theme Studio writes `src/styles/theme.css` — the canonical token registry. This file is the source of truth for color, type, spacing, motion, and layout. **Always read `src/styles/theme.css` before choosing exact token names or values, and consume a token before inventing a literal value.**

The format is standard and intentionally simple:

- Tailwind projects use a single `@theme { ... }` block.
- CSS projects use a single `:root { ... }` block.
- Token names are CSS custom properties. Use `var(--token-name)` in scoped CSS, and use Tailwind utilities like `max-w-7xl` when Tailwind exposes the value.

## Theme tokens (theme.css)

```css
@theme {
    /* === Color === drives bg-*, text-*, border-* utilities */
    --color-primary: #6366f1;
    --color-primary-dark: #4f46e5;
    --color-primary-light: #818cf8;
    --color-secondary: #64748b;
    --color-accent: #06b6d4;

    --color-surface: #ffffff;        /* page bg */
    --color-surface-alt: #f9fafb;    /* card bg */
    --color-surface-hover: #f3f4f6;  /* hover bg */
    --color-content: #1f2937;        /* primary text */
    --color-content-light: #6b7280;  /* secondary text */
    --color-content-lighter: #9ca3af;/* muted text */
    --color-outline: #e5e7eb;        /* borders */

    --color-success: #22c55e;
    --color-warning: #f59e0b;
    --color-error: #ef4444;

    /* === Typography === */
    --font-sans: 'Inter', system-ui, sans-serif;
    --font-heading: 'Inter', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', monospace;

    --text-xs: 0.75rem;
    --text-sm: 0.875rem;
    --text-base: 1rem;
    --text-lg: 1.125rem;
    --text-xl: 1.25rem;
    --text-2xl: 1.5rem;
    --text-3xl: 1.875rem;
    --text-4xl: 2.25rem;

    --leading-tight: 1.1;
    --leading-snug: 1.25;
    --leading-normal: 1.5;
    --leading-relaxed: 1.75;

    --tracking-tight: -0.02em;
    --tracking-normal: 0;
    --tracking-wide: 0.05em;

    --font-weight-regular: 400;
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;

    /* === Spacing === */
    /* Master unit — every p-*, m-*, gap-*, space-* utility is calc(var(--spacing) * N).
       Change this ONE value to re-scale the entire site's rhythm. */
    --spacing: 0.25rem;

    /* Named ramp for hand-written CSS (e.g. padding: var(--space-md)). */
    --space-xs: 0.25rem;
    --space-sm: 0.5rem;
    --space-md: 1rem;
    --space-lg: 1.5rem;
    --space-xl: 2rem;
    --space-2xl: 3rem;
    --space-3xl: 4rem;

    /* === Containers ===
       Tailwind defaults apply across max-w-*. Only project override: */
    --container-prose: 56rem;
    --container-full:  100%;

    /* === Radius === drives rounded-* */
    --radius-sm: 0.25rem;
    --radius-md: 0.375rem;
    --radius-lg: 0.5rem;
    --radius-xl: 0.75rem;
    --radius-full: 9999px;

    /* === Shadow === drives shadow-* */
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
    --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
    --shadow-inner: inset 0 2px 4px 0 rgb(0 0 0 / 0.05);

    /* === Borders === for custom CSS */
    --border-hairline: 0.5px;
    --border-thin: 1px;
    --border-thick: 2px;

    /* === Motion === durations + easings for transitions/animations */
    --duration-fast: 150ms;
    --duration-normal: 250ms;
    --duration-slow: 400ms;
    --ease-in: cubic-bezier(0.4, 0, 1, 1);
    --ease-out: cubic-bezier(0, 0, 0.2, 1);
    --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

    /* === Breakpoints === also drive Tailwind's md:, lg:, xl: variants */
    --breakpoint-sm: 640px;
    --breakpoint-md: 768px;
    --breakpoint-lg: 1024px;
    --breakpoint-xl: 1280px;
    --breakpoint-2xl: 1536px;

    /* === Z-index === scale to prevent stacking-context wars */
    --z-base: 0;
    --z-dropdown: 10;
    --z-sticky: 20;
    --z-overlay: 40;
    --z-modal: 50;
    --z-toast: 60;

    /* === Opacity === for disabled / muted / overlay states */
    --opacity-disabled: 0.4;
    --opacity-muted: 0.6;
    --opacity-overlay: 0.7;
}
```

## Dark mode

Override only what changes — usually colors. Spacing, radius, motion, etc. are mode-invariant.

```css
.dark {
    --color-surface: #0f172a;
    --color-surface-alt: #1e293b;
    --color-content: #f9fafb;
    --color-content-light: #d1d5db;
    --color-outline: #334155;
    /* ... */
}
```

## Usage patterns

### Tailwind utilities (Tailwind v4 reads tokens directly)

```html
<div class="bg-surface text-content border border-outline rounded-md shadow-md p-4">
    <div class="mx-auto max-w-7xl">
        <h1 class="text-2xl font-semibold text-primary">Title</h1>
    </div>
    <p class="text-content-light mt-2">Subtitle</p>
    <button class="bg-primary text-white px-4 py-2 rounded-md cursor-pointer transition-colors">
        Click
    </button>
</div>
```

### Scoped CSS / inline styles (for what utilities don't cover)

When you need a value Tailwind doesn't expose as a utility (motion timing, custom shadows, brand SVGs), reference the variable directly:

```astro
<style>
    .card {
        max-width: var(--container-prose);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-md);
        transition: all var(--duration-normal) var(--ease-out);
        z-index: var(--z-dropdown);
    }
    .card:disabled { opacity: var(--opacity-disabled); }
</style>
```

## DO / DON'T

- **DO** `shadow-md` instead of `shadow-[0_4px_6px_rgba(0,0,0,0.1)]` — the token already exists.
- **DO** `max-w-7xl` or `max-width: var(--container-prose)` instead of hard-coded pixel values.
- **DO** `transition-all duration-200 ease-out` → upgrade to `transition-all` with custom CSS `transition-duration: var(--duration-normal); transition-timing-function: var(--ease-out)` when you need theme-driven timing.
- **DO** change `--spacing` (not individual `p-*` overrides) when the whole UI feels too dense or too airy.
- **DON'T** hard-code colors, durations, easings, or radii. The whole point of the token system is single-knob theming.
- **DON'T** invent new `--*` variables in components; add them to `theme.css` so the rest of the project (and the Theme Studio) can see them.

## Discovering current values

To see what's currently in `theme.css` from a script or AI tool, just read the file — it's plain CSS with one block (`@theme` or `:root`) at the top.
