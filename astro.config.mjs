import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
let devComponentIdPlugin;
try {
    ({ devComponentIdPlugin } = await import('./.phantomwp/ide/dev-tools.mjs'));
} catch {
    devComponentIdPlugin = () => ({ name: 'phantom-dev-tools-noop', apply: 'serve' });
}


// https://astro.build/config
// Note: Set your 'site' URL in SEO Settings to enable sitemap generation
export default defineConfig({
  integrations: [mdx(), sitemap(), react()],
  image: {
    // Use Sharp for image optimization (converts to WebP/AVIF, resizes)
    service: { entrypoint: 'astro/assets/services/sharp' },
  },
  server: {
    // Bind to all interfaces so Codespaces port forwarding can reach the dev server
    host: true,
    // Allow Codespaces reverse proxy hostname (Vite 6.2+ rejects unknown hosts by default)
    allowedHosts: ['.app.github.dev', '.fly.dev'],
  },
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss(), devComponentIdPlugin()],
    server: {
      headers: {
        // Allow iframe embedding in development only (for IDE preview)
        // Note: vite.server.headers only applies to dev server, not production builds
        'Content-Security-Policy': "frame-ancestors *",
      },
      allowedHosts: ['localhost', '.fly.dev'],
      cors: { origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ },
      hmr: {
        clientPort: 443,
        protocol: 'wss',
      },
      watch: {
        ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.output/**'],
      },
    },
  },
});
