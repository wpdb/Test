# Font Installation Guide

## Check Installed Fonts First
Before installing any font, ALWAYS check package.json for existing @fontsource packages:
- If @fontsource/inter OR @fontsource-variable/inter exists, the font is ALREADY INSTALLED
- Do NOT install again - just update theme.css to use it
- Both @fontsource/fontname and @fontsource-variable/fontname provide the same font family name

## Switching to an Installed Font
If the font is already in package.json, just update theme.css:
```css
@theme {
    --font-sans: 'Inter', system-ui, sans-serif;
}
```
No npm install needed!

## Installing New Fonts (Fontsource)
Only if the font is NOT in package.json:
```bash
npm install @fontsource/inter
```

Import in src/layouts/BaseLayout.astro after frontmatter:
```astro
---
// frontmatter
---
import '@fontsource/inter';
```

Popular fonts: inter, roboto, poppins, open-sans, fira-code, jetbrains-mono

Variable fonts (all weights) - same font family name:
```js
import '@fontsource-variable/inter';  // Still uses font-family: 'Inter'
```

## Google Fonts (CDN)
Add to BaseLayout.astro <head>:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
```

## Self-Hosted (Custom Fonts)
1. Upload font files to public/fonts/
2. Add @font-face in src/styles/global.css:
```css
@font-face {
    font-family: 'CustomFont';
    src: url('/fonts/custom-font.woff2') format('woff2');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
}
```

## Using Fonts in Tailwind
Configure in theme.css:
```css
@theme {
    --font-sans: 'Inter', system-ui, sans-serif;
    --font-heading: 'Playfair Display', serif;
    --font-mono: 'Fira Code', monospace;
}
```
Use: class="font-sans", class="font-heading", class="font-mono"
