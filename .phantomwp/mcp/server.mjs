#!/usr/bin/env node
// This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
// Source of truth lives in PhantomWP infrastructure generators.

/**
 * PhantomWP MCP server (stdio).
 *
 * Exposes read-only WordPress discovery tools to MCP clients such as
 * Claude Code and Cursor: get_wordpress_schema, fetch_wp_sample,
 * browse_content. Zero dependencies; requires Node 18+ (built-in fetch).
 *
 * Connection details are resolved exactly like the Astro build resolves
 * them: WP_API_URL from src/lib/wordpress-config.ts and WP_ACCESS_SECRET
 * from the environment or .env. The secret is sent as the
 * X-PhantomWP-Secret header and is never written to output or logs.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

var SERVER_NAME = 'phantomwp';
var SERVER_VERSION = '0.1.0';
var DEFAULT_PROTOCOL_VERSION = '2025-06-18';
var FETCH_TIMEOUT_MS = 15000;
var SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
var MAX_OUTPUT_CHARS = 60000;
var MAX_SAMPLED_TYPES = 8;

// ---------------------------------------------------------------------------
// Connection config — same sources the Astro runtime uses.
// ---------------------------------------------------------------------------

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

function readSecret(root) {
  if (process.env.WP_ACCESS_SECRET) return process.env.WP_ACCESS_SECRET;
  var envFiles = ['.env', '.env.local'];
  for (var i = 0; i < envFiles.length; i++) {
    var file = path.join(root, envFiles[i]);
    if (!fs.existsSync(file)) continue;
    var lines = fs.readFileSync(file, 'utf8').split('\n');
    for (var j = 0; j < lines.length; j++) {
      var match = lines[j].match(/^\s*WP_ACCESS_SECRET\s*=\s*(.*)\s*$/);
      if (match && match[1]) {
        return match[1].replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return '';
}

function loadConfig() {
  var root = findProjectRoot(process.cwd());
  if (!root) {
    throw new Error(
      'Could not locate the project root (no src/lib/wordpress-config.ts found ' +
      'walking up from ' + process.cwd() + '). Run this server from inside a ' +
      'PhantomWP-generated project, or connect WordPress in PhantomWP first.'
    );
  }
  var apiUrl = readApiUrl(root);
  if (!apiUrl) {
    throw new Error(
      'No WordPress connection found: src/lib/wordpress-config.ts has no WP_API_URL. ' +
      'Connect your WordPress site in the PhantomWP IDE first.'
    );
  }
  return { root: root, apiUrl: apiUrl, secret: readSecret(root) };
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

  var data = {
    source: 'live',
    generatedAt: new Date().toISOString(),
    siteApiUrl: cfg.apiUrl,
    postTypes: postTypes,
    taxonomies: taxonomies,
    note:
      'sampleFields are inferred from one published item per type. acfKeys appear only when ' +
      "ACF's \"show in REST\" is enabled for that field group. Use fetch_wp_sample for full values.",
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

var TOOLS = [
  {
    name: 'get_wordpress_schema',
    description:
      "Get the connected WordPress site's content schema: post types, taxonomies, and which " +
      'ACF/meta fields appear on each type. Call this FIRST before writing any code that ' +
      'fetches WordPress data, and before guessing REST routes or field names. The result ' +
      'reports source:"cache"|"live"; pass refresh:true to bypass the 5-minute cache.',
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
];

async function callTool(name, args) {
  var cfg = loadConfig();
  if (name === 'get_wordpress_schema') return getWordPressSchema(cfg, args);
  if (name === 'fetch_wp_sample') return fetchWpSample(cfg, args);
  if (name === 'browse_content') return browseContent(cfg, args);
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
