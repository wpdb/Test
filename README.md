# My Astro Site

This site was created with **phantomwp** - migrated from WordPress to Astro.

## Project Structure

```
/
├── docs/
│   └── ai-instructions.md   # Your preferences & custom APIs for the AI
├── public/
├── src/
│   ├── components/          # Reusable Astro/React components
│   ├── data/                # JSON/TS data files (cards, settings, etc.)
│   ├── layouts/             # Page layouts
│   ├── pages/               # Routes - each file becomes a page
│   │   └── index.astro
│   └── styles/              # Global CSS and theme tokens
└── package.json
```

Astro looks for `.astro`, `.md`, or `.mdx` files in the `src/pages/` directory. Each page is exposed as a route based on its file name. MDX files allow you to use React components and access frontmatter fields directly in your content.

## AI Assistant

The `docs/` folder lets you customize the AI:

- **ai-instructions.md** - Your preferences and custom APIs

## Commands

All commands are run from the root of the project:

| Command                | Action                                           |
| :--------------------- | :----------------------------------------------- |
| `npm install`        | Installs dependencies                            |
| `npm run dev`        | Starts local dev server at `localhost:4321`    |
| `npm run build`      | Build your production site to `./dist/`        |
| `npm run preview`    | Preview your build locally, before deploying     |

## Running Locally

```bash
git clone <your-repo>
cd <your-repo>
cp .env.example .env       # then paste your WordPress secret
npm install
npm run dev
```

This project runs standalone -- no PhantomWP backend needed. Everything you need to build and deploy is in the repo.

## Where Your WordPress Credentials Live

PhantomWP keeps the secret you use to talk to your WordPress site out of git:

- `src/lib/wordpress-config.ts` is committed and contains your WordPress URL and image-source mode. **It does not contain the secret.**
- `.env` is git-ignored and contains `WP_ACCESS_SECRET`. Copy `.env.example` to `.env` and paste the secret from the PhantomWP WordPress Settings panel.
- For production deploys (Vercel, Netlify, etc.), set `WP_ACCESS_SECRET` in your hosting platform's environment-variables UI -- not in code.

If `WP_ACCESS_SECRET` is missing at build time, any WordPress request that requires auth will fail with a 401. That's intentional: it surfaces a missing configuration loudly instead of silently using a stale value.

## Blog Helper Functions

The `src/utils/blog-helpers.ts` file contains useful code snippets for working with blog posts:

- **Get all posts**: `getAllPosts()`
- **Filter by category/tag**: `getPostsByCategory()`, `getPostsByTag()`
- **Pagination**: `paginatePosts()`
- **Related posts**: `getRelatedPosts()`
- **Search**: `searchPosts()`
- **Archives**: `getPostArchives()`
- And many more!

Check the file for complete documentation and usage examples.

## Documentation

Check out [Astro documentation](https://docs.astro.build) or jump into the [Discord server](https://astro.build/chat).

## Created with phantomwp

Learn more about migrating from WordPress to Astro at [phantomwp.com](https://phantomwp.com)
