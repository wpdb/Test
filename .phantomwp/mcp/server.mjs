#!/usr/bin/env node
// This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
// Source of truth lives in PhantomWP infrastructure generators.

/**
 * PhantomWP MCP server (stdio).
 *
 * Exposes WordPress tools to MCP clients such as Claude Code and Cursor:
 * discovery (get_wordpress_schema, fetch_wp_sample, browse_content) and,
 * since 0.3.0, scaffold tools (wp_register_post_type, wp_register_taxonomy,
 * wp_register_field_group, wp_create_posts, wp_delete_managed_posts,
 * wp_list_managed_scaffold).
 *
 * Discovery reads WordPress directly. Scaffold calls are proxied through
 * PhantomWP (/api/ai/wp-scaffold), which signs the request to the Connect
 * plugin with pairing keys this server never holds; they authenticate with
 * a PhantomWP personal access token (PHANTOMWP_MCP_TOKEN). Writes are
 * double-gated: the site admin must enable scaffold writes in wp-admin >
 * PhantomWP, and the MCP client prompts for approval per call.
 * Zero dependencies; requires Node 18+ (built-in fetch).
 *
 * Connection details are resolved exactly like the Astro build resolves
 * them: WP_API_URL from src/lib/wordpress-config.ts and WP_ACCESS_SECRET
 * from the environment or .env. The secret is sent as the
 * X-PhantomWP-Secret header; neither it nor the access token is ever
 * written to output or logs.
 *
 * The project root is normally discovered by walking up from cwd. Clients
 * that cannot set a working directory (e.g. Claude Desktop) can pass it
 * explicitly: "--root /path/to/project" or PHANTOMWP_PROJECT_ROOT.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

var SERVER_NAME = 'phantomwp';
var SERVER_VERSION = '0.3.0';
var DEFAULT_PROTOCOL_VERSION = '2025-06-18';
var FETCH_TIMEOUT_MS = 15000;
var SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
var MAX_OUTPUT_CHARS = 60000;
var MAX_SAMPLED_TYPES = 8;

// ---------------------------------------------------------------------------
// Connection config — same sources the Astro runtime uses.
// ---------------------------------------------------------------------------

// Where to start looking for the project. MCP clients without a cwd
// concept (Claude Desktop's config has no cwd field) pass the project
// location as "--root <path>" or PHANTOMWP_PROJECT_ROOT instead.
function resolveStartDir() {
  var argv = process.argv.slice(2);
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) return path.resolve(argv[i + 1]);
  }
  if (process.env.PHANTOMWP_PROJECT_ROOT) {
    return path.resolve(process.env.PHANTOMWP_PROJECT_ROOT);
  }
  return process.cwd();
}

function findProjectRoot(startDir) {
  var dir = startDir;
  for (var i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, 'src', 'lib', 'wordpress-config.ts')) ||
      fs.existsSync(path.join(dir, 'src', 'lib', 'wordpress.ts'))
    ) {
      return dir;
    }
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readApiUrl(root) {
  var candidates = [
    path.join(root, 'src', 'lib', 'wordpress-config.ts'),
    // Pre-1.25 projects baked the URL into src/lib/wordpress.ts directly.
    path.join(root, 'src', 'lib', 'wordpress.ts'),
  ];
  for (var i = 0; i < candidates.length; i++) {
    var file = candidates[i];
    if (!fs.existsSync(file)) continue;
    var content = fs.readFileSync(file, 'utf8');
    var match = content.match(/export const WP_API_URL\s*=\s*['"]([^'"]+)['"]/);
    if (match && match[1]) return match[1].replace(/\/+$/, '');
  }
  return null;
}

// Resolve a config value from the process environment first, then .env /
// .env.local in the project root. Used for WP_ACCESS_SECRET (reads),
// PHANTOMWP_MCP_TOKEN (scaffold calls), and optional PHANTOMWP_URL /
// PHANTOMWP_REPO overrides.
function readEnvValue(root, name) {
  if (process.env[name]) return process.env[name];
  var envFiles = ['.env', '.env.local'];
  for (var i = 0; i < envFiles.length; i++) {
    var file = path.join(root, envFiles[i]);
    if (!fs.existsSync(file)) continue;
    var lines = fs.readFileSync(file, 'utf8').split('\n');
    for (var j = 0; j < lines.length; j++) {
      var match = lines[j].match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*)\\s*$'));
      if (match && match[1]) {
        return match[1].replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return '';
}

function loadConfig() {
  var startDir = resolveStartDir();
  var root = findProjectRoot(startDir);
  if (!root) {
    throw new Error(
      'Could not locate the project root (no src/lib/wordpress-config.ts found ' +
      'walking up from ' + startDir + '). Run this server from inside a ' +
      'PhantomWP-generated project, pass the project folder as "--root /path/to/project" ' +
      '(or set PHANTOMWP_PROJECT_ROOT), or connect WordPress in PhantomWP first.'
    );
  }
  var apiUrl = readApiUrl(root);
  if (!apiUrl) {
    throw new Error(
      'No WordPress connection found: src/lib/wordpress-config.ts has no WP_API_URL. ' +
      'Connect your WordPress site in the PhantomWP IDE first.'
    );
  }
  var appUrl = (readEnvValue(root, 'PHANTOMWP_URL') || 'https://phantomwp.com').replace(/\/+$/, '');
  return {
    root: root,
    apiUrl: apiUrl,
    secret: readEnvValue(root, 'WP_ACCESS_SECRET'),
    appUrl: appUrl,
    mcpToken: readEnvValue(root, 'PHANTOMWP_MCP_TOKEN'),
    // Only needed when the token is not repo-scoped; scoped tokens (the
    // Connect dialog default) name their repository server-side.
    repo: readEnvValue(root, 'PHANTOMWP_REPO'),
  };
}

// ---------------------------------------------------------------------------
// WordPress REST helpers.
// ---------------------------------------------------------------------------

async function wpFetch(cfg, route, params) {
  var url = new URL(cfg.apiUrl + route);
  if (params) {
    for (var key of Object.keys(params)) {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.set(key, String(params[key]));
      }
    }
  }
  var headers = { Accept: 'application/json' };
  if (cfg.secret) headers['X-PhantomWP-Secret'] = cfg.secret;
  var res;
  try {
    res = await fetch(url, { headers: headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error('Could not reach WordPress at ' + url.host + ': ' + (err && err.message ? err.message : String(err)));
  }
  if (!res.ok) {
    var hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = ' (authenticated request rejected — check that WP_ACCESS_SECRET is set in .env and the PhantomWP Connect plugin is active)';
    }
    throw new Error('WordPress returned HTTP ' + res.status + ' for ' + route + hint);
  }
  return res.json();
}

function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function keysOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

// ---------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------

var schemaCache = null;

async function getWordPressSchema(cfg, args) {
  var refresh = Boolean(args && args.refresh);
  if (!refresh && schemaCache && Date.now() - schemaCache.at < SCHEMA_CACHE_TTL_MS) {
    return Object.assign({}, schemaCache.data, { source: 'cache' });
  }

  var typesMap = await wpFetch(cfg, '/wp/v2/types');
  var taxonomiesMap = await wpFetch(cfg, '/wp/v2/taxonomies');

  var postTypes = [];
  for (var slug of Object.keys(typesMap)) {
    var t = typesMap[slug];
    if (!t || !t.rest_base) continue;
    postTypes.push({
      slug: slug,
      name: t.name,
      restBase: t.rest_base,
      hierarchical: Boolean(t.hierarchical),
      taxonomies: Array.isArray(t.taxonomies) ? t.taxonomies : [],
    });
  }

  // Infer field shape from one sample item per type (skip media uploads).
  var sampled = 0;
  for (var i = 0; i < postTypes.length && sampled < MAX_SAMPLED_TYPES; i++) {
    var type = postTypes[i];
    if (type.restBase === 'media') continue;
    sampled++;
    try {
      var items = await wpFetch(cfg, '/wp/v2/' + type.restBase, {
        per_page: 1,
        _fields: 'id,acf,meta',
      });
      var item = Array.isArray(items) ? items[0] : null;
      if (item) {
        type.sampleFields = {
          acfKeys: keysOf(item.acf),
          metaKeys: keysOf(item.meta),
        };
      } else {
        type.sampleFields = { note: 'no published items to sample' };
      }
    } catch (err) {
      type.sampleFields = { note: 'sample failed: ' + (err && err.message ? err.message : String(err)) };
    }
  }

  var taxonomies = [];
  for (var taxSlug of Object.keys(taxonomiesMap)) {
    var tax = taxonomiesMap[taxSlug];
    if (!tax || !tax.rest_base) continue;
    taxonomies.push({
      slug: taxSlug,
      name: tax.name,
      restBase: tax.rest_base,
      types: Array.isArray(tax.types) ? tax.types : [],
    });
  }

  var scaffold;
  try {
    scaffold = await getScaffoldCapabilities(cfg, refresh);
  } catch (err) {
    scaffold = { available: false, error: err && err.message ? err.message : String(err) };
  }

  var data = {
    source: 'live',
    generatedAt: new Date().toISOString(),
    siteApiUrl: cfg.apiUrl,
    postTypes: postTypes,
    taxonomies: taxonomies,
    scaffold: scaffold,
    note:
      'sampleFields are inferred from one published item per type. acfKeys appear only when ' +
      "ACF's \"show in REST\" is enabled for that field group. Use fetch_wp_sample for full values. " +
      'The scaffold block reports whether the wp_* scaffold tools can run (writesEnabled, ' +
      'canCreatePostTypes, activeModeler, ...).',
  };
  schemaCache = { at: Date.now(), data: data };
  return data;
}

function trimPost(item) {
  if (!item || typeof item !== 'object') return item;
  var out = {};
  for (var key of Object.keys(item)) {
    if (key === '_links' || key === 'yoast_head' || key === 'yoast_head_json') continue;
    if (key === '_embedded') {
      try {
        var media = item._embedded['wp:featuredmedia'];
        if (Array.isArray(media) && media[0] && media[0].source_url) {
          out.featuredImageUrl = media[0].source_url;
        }
      } catch (err) {
        // No featured media — fine.
      }
      continue;
    }
    out[key] = item[key];
  }
  if (out.content && typeof out.content.rendered === 'string' && out.content.rendered.length > 3000) {
    out.content = {
      rendered: out.content.rendered.slice(0, 3000) + '... [truncated]',
      truncated: true,
    };
  }
  return out;
}

async function fetchWpSample(cfg, args) {
  var restBase = args && typeof args.restBase === 'string' ? args.restBase.replace(/^\/+|\/+$/g, '') : '';
  if (!restBase) throw new Error('restBase is required (e.g. "posts", "pages", "team-member" — see get_wordpress_schema)');
  if (!/^[a-zA-Z0-9_-]+$/.test(restBase)) throw new Error('restBase must be a plain REST base slug, not a path');

  if (args && args.id !== undefined && args.id !== null) {
    var single = await wpFetch(cfg, '/wp/v2/' + restBase + '/' + Math.trunc(Number(args.id)), { _embed: 1 });
    return trimPost(single);
  }

  var items = await wpFetch(cfg, '/wp/v2/' + restBase, { per_page: 10, _embed: 1 });
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No published items found for post type "' + restBase + '"');
  }
  var best = items[0];
  var bestScore = -1;
  for (var i = 0; i < items.length; i++) {
    var score = 0;
    try {
      score = JSON.stringify(items[i].acf || {}).length + JSON.stringify(items[i].meta || {}).length;
    } catch (err) {
      score = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = items[i];
    }
  }
  return trimPost(best);
}

async function browseContent(cfg, args) {
  var restBase = args && typeof args.restBase === 'string' ? args.restBase.replace(/^\/+|\/+$/g, '') : '';
  if (!restBase) throw new Error('restBase is required (e.g. "posts", "pages" — see get_wordpress_schema)');
  if (!/^[a-zA-Z0-9_-]+$/.test(restBase)) throw new Error('restBase must be a plain REST base slug, not a path');

  var perPage = Math.min(Math.max(Math.trunc(Number(args && args.perPage) || 10), 1), 20);
  var page = Math.max(Math.trunc(Number(args && args.page) || 1), 1);
  var params = { per_page: perPage, page: page };
  if (args && typeof args.search === 'string' && args.search.trim()) params.search = args.search.trim();

  var items = await wpFetch(cfg, '/wp/v2/' + restBase, params);
  if (!Array.isArray(items)) throw new Error('Unexpected response for post type "' + restBase + '"');
  return {
    restBase: restBase,
    page: page,
    count: items.length,
    items: items.map(function (item) {
      var excerptHtml = item.excerpt && item.excerpt.rendered ? item.excerpt.rendered : '';
      return {
        id: item.id,
        slug: item.slug,
        title: item.title && item.title.rendered ? stripHtml(item.title.rendered) : '',
        date: item.date,
        link: item.link,
        excerpt: stripHtml(excerptHtml).slice(0, 200),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Scaffold tools — create CPTs, taxonomies, field groups, and seed content.
// Calls are proxied through PhantomWP's /api/ai/wp-scaffold dispatcher, which
// signs the request to the Connect plugin with pairing keys this server never
// holds (so any paired plugin version works, and PhantomWP's schema cache is
// invalidated after mutations). Auth: a PhantomWP personal access token from
// PHANTOMWP_MCP_TOKEN. Writes are double-gated: the wp-admin "scaffold
// writes" toggle must be on, and the MCP client prompts for approval per
// tool call.
// ---------------------------------------------------------------------------

var SCAFFOLD_BASE = '/phantomwp/v1/scaffold';
var capsCache = null;

async function appScaffold(cfg, action, extra) {
  var url = new URL(cfg.appUrl + '/api/ai/wp-scaffold');
  if (cfg.repo) url.searchParams.set('repo', cfg.repo);
  var body = Object.assign({ action: action }, extra || {});
  var res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.mcpToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error('Could not reach PhantomWP at ' + url.host + ': ' + (err && err.message ? err.message : String(err)));
  }
  var payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    var code = payload && payload.code ? String(payload.code) : '';
    if (res.status === 401 && code !== 'PLUGIN_PAIRING_INVALID' && code !== 'API_KEY_MISMATCH') {
      throw new Error(
        'PhantomWP rejected the access token (HTTP 401). The PHANTOMWP_MCP_TOKEN is invalid or ' +
        'expired — ask the user to generate a fresh token in the PhantomWP editor (Connect AI ' +
        'Agent dialog) and update it.'
      );
    }
    if (code === 'pwp_writes_disabled') {
      throw new Error(
        'Scaffold writes are disabled on the WordPress site. Ask the user to open wp-admin > ' +
        'PhantomWP and enable scaffold writes, then retry.'
      );
    }
    // Two error shapes arrive here: PhantomWP's { error, code, hint } and
    // relayed WP_Error bodies { code, message }.
    var message = '';
    if (payload && payload.error) message = String(payload.error);
    else if (payload && payload.message) message = String(payload.message);
    else message = 'PhantomWP returned HTTP ' + res.status;
    var hint = payload && payload.hint ? String(payload.hint) : '';
    throw new Error(message + (hint ? ' ' + hint : ''));
  }
  if (payload && payload.error) {
    var extraHint = payload.hint ? ' ' + String(payload.hint) : '';
    throw new Error(String(payload.error) + extraHint);
  }
  return payload;
}

async function getScaffoldCapabilities(cfg, refresh) {
  if (!refresh && capsCache && Date.now() - capsCache.at < SCHEMA_CACHE_TTL_MS) {
    return capsCache.data;
  }
  var raw;
  try {
    raw = await wpFetch(cfg, SCAFFOLD_BASE + '/capabilities');
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    if (msg.indexOf('HTTP 404') >= 0) {
      // rest_no_route: the Connect plugin is not installed or not active.
      var missing = {
        connectorMissing: true,
        writesEnabled: false,
        note:
          'The PhantomWP Connect plugin is not installed or not active on the WordPress site, so ' +
          'scaffold tools are unavailable. Suggest installing it from the PhantomWP dashboard and, ' +
          'for content modeling, a modeler such as Secure Custom Fields (SCF) or ACF.',
      };
      capsCache = { at: Date.now(), data: missing };
      return missing;
    }
    throw err;
  }
  var data = {
    connectorMissing: false,
    pluginVersion: raw && raw.plugin_version ? raw.plugin_version : null,
    writesEnabled: Boolean(raw && raw.writes_enabled),
    canCreatePostTypes: Boolean(raw && raw.can_create_post_types),
    canCreateTaxonomies: Boolean(raw && raw.can_create_taxonomies),
    canCreateFields: Boolean(raw && raw.can_create_fields),
    canCreatePosts: Boolean(raw && raw.can_create_posts),
    activeModeler: raw && raw.active_modeler ? raw.active_modeler : null,
    modelersDetected: raw && Array.isArray(raw.modelers_detected) ? raw.modelers_detected : [],
    suggestedPlugins: raw && Array.isArray(raw.suggested_plugins) ? raw.suggested_plugins : [],
  };
  capsCache = { at: Date.now(), data: data };
  return data;
}

// Preflight for scaffold calls. The token check is local; the capability
// probe always goes live (never the cache) so a toggle the user flipped
// seconds ago is seen immediately. Both turn misconfigurations into
// instructive errors instead of raw 401s from the doomed call.
async function ensureScaffoldAccess(cfg, needsWrites) {
  if (!cfg.mcpToken) {
    throw new Error(
      'PHANTOMWP_MCP_TOKEN is not set (checked the environment, .env, and .env.local). Scaffold ' +
      'tools authenticate to PhantomWP with a personal access token — ask the user to generate one ' +
      'in the PhantomWP editor (Connect AI Agent dialog) and expose it as PHANTOMWP_MCP_TOKEN. ' +
      'The discovery tools keep working without it.'
    );
  }
  var caps = await getScaffoldCapabilities(cfg, true);
  if (caps.connectorMissing) {
    throw new Error(
      'The PhantomWP Connect plugin is not installed or not active on the WordPress site ' +
      '(its scaffold routes return 404). Ask the user to install/activate it, then retry.'
    );
  }
  if (needsWrites && !caps.writesEnabled) {
    throw new Error(
      'PhantomWP scaffold writes are disabled in the WordPress plugin. Ask the user to open ' +
      'wp-admin > PhantomWP and enable scaffold writes, then retry. If they decline, offer a ' +
      'WordPress-pages-based fallback instead of the write tools.'
    );
  }
  return caps;
}

function fillDefaults(args, defaults) {
  var out = Object.assign({}, args);
  for (var key of Object.keys(defaults)) {
    if (out[key] === undefined) out[key] = defaults[key];
  }
  return out;
}

function requireSlug(value, label) {
  var slug = typeof value === 'string' ? value.trim() : '';
  if (!slug) throw new Error(label + ' is required');
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error(label + ' must be lowercase letters, digits, underscores, or hyphens');
  return slug;
}

async function listManagedScaffold(cfg) {
  await ensureScaffoldAccess(cfg, false);
  return appScaffold(cfg, 'list_registry', {});
}

async function registerPostType(cfg, args) {
  var definition = fillDefaults(args || {}, {
    supports: ['title', 'editor', 'thumbnail', 'excerpt'],
    public: true,
    show_in_rest: true,
    hierarchical: false,
  });
  definition.slug = requireSlug(definition.slug, 'slug');
  if (!definition.labels || !definition.labels.name || !definition.labels.singular_name) {
    throw new Error('labels.name and labels.singular_name are required');
  }
  await ensureScaffoldAccess(cfg, true);
  return appScaffold(cfg, 'register_post_type', { definition: definition });
}

async function registerTaxonomy(cfg, args) {
  var definition = fillDefaults(args || {}, {
    hierarchical: false,
    public: true,
    show_in_rest: true,
  });
  definition.slug = requireSlug(definition.slug, 'slug');
  if (!Array.isArray(definition.object_types) || definition.object_types.length === 0) {
    throw new Error('object_types must be a non-empty array of post type slugs');
  }
  if (!definition.labels || !definition.labels.name || !definition.labels.singular_name) {
    throw new Error('labels.name and labels.singular_name are required');
  }
  await ensureScaffoldAccess(cfg, true);
  return appScaffold(cfg, 'register_taxonomy', { definition: definition });
}

async function registerFieldGroup(cfg, args) {
  var definition = fillDefaults(args || {}, { show_in_rest: true });
  if (!definition.key || typeof definition.key !== 'string') throw new Error('key is required');
  if (!definition.title) throw new Error('title is required');
  if (!Array.isArray(definition.location) || definition.location.length === 0) {
    throw new Error('location rules are required (ACF format: outer array is OR, inner array is AND)');
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
    throw new Error('fields must be a non-empty array');
  }
  await ensureScaffoldAccess(cfg, true);
  return appScaffold(cfg, 'register_field_group', { definition: definition });
}

async function createPosts(cfg, args) {
  var postType = requireSlug(args && args.post_type, 'post_type');
  var posts = args && Array.isArray(args.posts) ? args.posts : [];
  if (posts.length === 0) throw new Error('posts must be a non-empty array');
  if (posts.length > 50) throw new Error('At most 50 posts may be created per call');
  await ensureScaffoldAccess(cfg, true);
  return appScaffold(cfg, 'create_posts', { post_type: postType, posts: posts });
}

async function deleteManagedPosts(cfg, args) {
  var postType = requireSlug(args && args.post_type, 'post_type');
  await ensureScaffoldAccess(cfg, true);
  return appScaffold(cfg, 'delete_managed_posts', { post_type: postType });
}

var TOOLS = [
  {
    name: 'get_wordpress_schema',
    description:
      "Get the connected WordPress site's content schema: post types, taxonomies, and which " +
      'ACF/meta fields appear on each type. Call this FIRST before writing any code that ' +
      'fetches WordPress data, before guessing REST routes or field names, and before any ' +
      'wp_* scaffold tool — the scaffold block in the result reports writesEnabled, ' +
      'canCreatePostTypes, and the active content modeler. The result reports ' +
      'source:"cache"|"live"; pass refresh:true to bypass the 5-minute cache.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Bypass the 5-minute cache and probe live.' },
      },
    },
  },
  {
    name: 'fetch_wp_sample',
    description:
      'Fetch one real WordPress post (with its actual ACF values) to inspect the exact data ' +
      'structure. Use when get_wordpress_schema shows unknown field shapes or you need ' +
      'repeater/flexible-content sub-fields. restBase is the REST base slug from ' +
      'get_wordpress_schema (e.g. "posts", "pages", "team-member").',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        restBase: { type: 'string', description: 'REST base slug of the post type.' },
        id: { type: 'number', description: 'Specific post ID. If omitted, returns the post with the richest ACF data.' },
      },
      required: ['restBase'],
    },
  },
  {
    name: 'browse_content',
    description:
      'List or search published WordPress content of one post type (id, slug, title, date, ' +
      'link, plain-text excerpt). Use to find a specific post/page or see what content exists; ' +
      'use fetch_wp_sample when you need the full field data of one item.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        restBase: { type: 'string', description: 'REST base slug of the post type.' },
        search: { type: 'string', description: 'Full-text search term.' },
        page: { type: 'number', description: 'Page number (default 1).' },
        perPage: { type: 'number', description: 'Items per page, max 20 (default 10).' },
      },
      required: ['restBase'],
    },
  },
  {
    name: 'wp_list_managed_scaffold',
    description:
      'List all CPTs, taxonomies, and field groups PhantomWP has previously scaffolded on this ' +
      'WordPress site. Use before creating a new resource to avoid duplicates and to surface ' +
      'what already exists to the user.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wp_register_post_type',
    description:
      "Create or update a WordPress custom post type via the site's installed content modeler " +
      '(SCF, ACF, ACPT, or Meta Box). Call get_wordpress_schema first and confirm ' +
      'scaffold.canCreatePostTypes is true; if false, tell the user which modeler to install ' +
      'from scaffold.suggestedPlugins. Upserts by slug; slug changes after creation are rejected. ' +
      'Requires scaffold writes enabled in wp-admin > PhantomWP and a PhantomWP access token in PHANTOMWP_MCP_TOKEN.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'CPT slug, e.g. "team-member". Must be unique, lowercase, underscores/hyphens allowed.' },
        labels: {
          type: 'object',
          description: 'At minimum { "name": "Team Members", "singular_name": "Team Member" }; extra WordPress label keys pass through.',
          properties: {
            name: { type: 'string' },
            singular_name: { type: 'string' },
          },
          required: ['name', 'singular_name'],
          additionalProperties: true,
        },
        supports: { type: 'array', items: { type: 'string' }, description: 'WP supports list. Defaults to ["title","editor","thumbnail","excerpt"].' },
        public: { type: 'boolean', description: 'Defaults to true.' },
        show_in_rest: { type: 'boolean', description: 'Defaults to true — the Astro frontend consumes content via REST.' },
        rest_base: { type: 'string' },
        hierarchical: { type: 'boolean', description: 'Defaults to false.' },
        menu_icon: { type: 'string', description: 'Dashicons class, e.g. "dashicons-groups".' },
        taxonomies: { type: 'array', items: { type: 'string' } },
      },
      required: ['slug', 'labels'],
    },
  },
  {
    name: 'wp_register_taxonomy',
    description:
      "Create or update a WordPress taxonomy via the site's installed content modeler. The " +
      'object_types array must reference CPTs or built-in post types that already exist. ' +
      'Requires scaffold writes enabled in wp-admin > PhantomWP and a PhantomWP access token in PHANTOMWP_MCP_TOKEN.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        object_types: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Post type slugs this taxonomy attaches to, e.g. ["team-member"].' },
        labels: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            singular_name: { type: 'string' },
          },
          required: ['name', 'singular_name'],
          additionalProperties: true,
        },
        hierarchical: { type: 'boolean', description: 'Defaults to false.' },
        public: { type: 'boolean', description: 'Defaults to true.' },
        show_in_rest: { type: 'boolean', description: 'Defaults to true.' },
        rest_base: { type: 'string' },
      },
      required: ['slug', 'object_types', 'labels'],
    },
  },
  {
    name: 'wp_register_field_group',
    description:
      'Create or update an ACF-style field group attached to one or more post types. Field ' +
      'format follows ACF conventions; the WP-side adapter normalizes per-modeler quirks. Use ' +
      'field types supported by the active modeler (reported in scaffold.modelersDetected). ' +
      'Requires scaffold writes enabled in wp-admin > PhantomWP and a PhantomWP access token in PHANTOMWP_MCP_TOKEN.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Unique field group key, e.g. "group_team_member".' },
        title: { type: 'string' },
        location: {
          type: 'array',
          description: 'ACF location rules: outer array is OR, inner array is AND.',
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                param: { type: 'string' },
                operator: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['param', 'operator', 'value'],
            },
          },
        },
        show_in_rest: {
          type: 'boolean',
          description: "Whether the group's fields are exposed in the WP REST API under the item's acf/meta keys. Defaults to true because the Astro frontend consumes fields via REST; only pass false for admin-only fields.",
        },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              name: { type: 'string' },
              type: { type: 'string', description: 'ACF field type: text, textarea, image, url, select, repeater, group, etc.' },
              required: { type: 'boolean', description: 'Defaults to false.' },
            },
            required: ['key', 'label', 'name', 'type'],
            additionalProperties: true,
          },
        },
      },
      required: ['key', 'title', 'location', 'fields'],
    },
  },
  {
    name: 'wp_create_posts',
    description:
      'Create or update posts (seed/demo content) for an existing post type on the connected ' +
      'WordPress site. The post_type must already exist (built-in like "post"/"page", or a CPT ' +
      'registered via wp_register_post_type). Upserts by slug when the existing post is ' +
      'PhantomWP-managed; refuses to overwrite human-authored posts. Each post is tagged with ' +
      'managed meta so the batch can later be cleaned via wp_delete_managed_posts. Use this ' +
      'for demo content; never use Astro-side scripts or curl. You can attach a featured image ' +
      'per post by passing featured_image_url; the plugin downloads it server-side, stores it ' +
      'in the WP media library, and sets it as the post thumbnail. Requires scaffold writes ' +
      'enabled in wp-admin > PhantomWP and a PhantomWP access token in PHANTOMWP_MCP_TOKEN.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        post_type: { type: 'string', description: 'Target post type slug, e.g. "project". Must already be registered on the WP site.' },
        posts: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              slug: { type: 'string', description: 'Optional slug; derived from title if omitted.' },
              content: { type: 'string', description: 'HTML content body.' },
              excerpt: { type: 'string' },
              status: { type: 'string', enum: ['publish', 'draft', 'private', 'pending'], description: 'Defaults to publish.' },
              featured_image_url: {
                type: 'string',
                description: 'Public URL to a JPEG/PNG/WebP image. WordPress downloads it server-side, stores it in the media library (tagged as PhantomWP-managed), and sets it as the post thumbnail. Use https://placehold.co/800x600/png?text=... as a quick placeholder. On download failure the post is still created and the result includes featured_image_warning — retry that post with a placehold.co URL.',
              },
              fields: { type: 'object', description: 'Custom fields by key, e.g. { "client_name": "Acme" }. Stored as post meta; ACF and SCF read from post meta transparently. Keys cannot start with underscore.', additionalProperties: true },
              terms: { type: 'object', description: 'Taxonomy terms keyed by taxonomy slug, e.g. { "project_category": ["Web Design"] }. Terms are created on demand.', additionalProperties: { type: 'array', items: { type: ['string', 'number'] } } },
            },
            required: ['title'],
          },
        },
      },
      required: ['post_type', 'posts'],
    },
  },
  {
    name: 'wp_delete_managed_posts',
    description:
      'Delete ONLY the posts that PhantomWP previously created via wp_create_posts for a given ' +
      'post type. Never touches human-authored posts (they lack the managed meta tag). Use when ' +
      'the user wants to wipe sample/demo content before reseeding, or to remove demo content ' +
      'entirely. Requires scaffold writes enabled in wp-admin > PhantomWP and a PhantomWP access token in PHANTOMWP_MCP_TOKEN.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        post_type: { type: 'string', description: 'Post type slug whose managed seed posts should be deleted.' },
      },
      required: ['post_type'],
    },
  },
];

async function callTool(name, args) {
  var cfg = loadConfig();
  if (name === 'get_wordpress_schema') return getWordPressSchema(cfg, args);
  if (name === 'fetch_wp_sample') return fetchWpSample(cfg, args);
  if (name === 'browse_content') return browseContent(cfg, args);
  if (name === 'wp_list_managed_scaffold') return listManagedScaffold(cfg);
  if (name === 'wp_register_post_type') return registerPostType(cfg, args);
  if (name === 'wp_register_taxonomy') return registerTaxonomy(cfg, args);
  if (name === 'wp_register_field_group') return registerFieldGroup(cfg, args);
  if (name === 'wp_create_posts') return createPosts(cfg, args);
  if (name === 'wp_delete_managed_posts') return deleteManagedPosts(cfg, args);
  throw new Error('Unknown tool: ' + name);
}

// ---------------------------------------------------------------------------
// MCP stdio transport: newline-delimited JSON-RPC 2.0.
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

function toToolText(value) {
  var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + '\n... [output truncated at ' + MAX_OUTPUT_CHARS + ' chars]';
  }
  return text;
}

async function handleRequest(message) {
  var method = message.method;
  var id = message.id;

  if (method === 'initialize') {
    var requested = message.params && typeof message.params.protocolVersion === 'string'
      ? message.params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    var name = message.params && message.params.name;
    var args = (message.params && message.params.arguments) || {};
    try {
      var value = await callTool(name, args);
      sendResult(id, { content: [{ type: 'text', text: toToolText(value) }] });
    } catch (err) {
      // Tool failures are results (isError), not protocol errors, per MCP.
      sendResult(id, {
        content: [{ type: 'text', text: 'Error: ' + (err && err.message ? err.message : String(err)) }],
        isError: true,
      });
    }
    return;
  }

  sendError(id, -32601, 'Method not found: ' + method);
}

var rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', function (line) {
  var trimmed = line.trim();
  if (!trimmed) return;
  var message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, 'Parse error');
    return;
  }
  // Notifications (no id) need no response.
  if (message.id === undefined || message.id === null) return;
  handleRequest(message).catch(function (err) {
    sendError(message.id, -32603, 'Internal error: ' + (err && err.message ? err.message : String(err)));
  });
});

rl.on('close', function () {
  process.exit(0);
});
