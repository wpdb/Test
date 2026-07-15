# WordPress Integration Guide

**IMPORTANT:** Never modify `.phantomwp/runtime/lib/wordpress.ts` (the framework) or `src/lib/wordpress.ts` (the re-export shim). Both are auto-generated.

To change your WordPress connection, edit `src/lib/wordpress-config.ts` (URL, secret, image-source mode -- this is also regenerated on WP reconnect).

To add custom data-fetching helpers, put them in `src/lib/functions.ts`. Import `makeCMSRequest` from `@phantomwp/wordpress`.

## Discovering Available Data

**Use the AI tools first** (available in the chat panel) before writing manual API calls:

1. **get_wordpress_schema** - Returns the full site schema: all post types (with rest_base), taxonomies, ACF field groups/fields, and detected plugins. Call this first to understand what data is available.
2. **fetch_wp_sample** - Fetches a real WordPress post with actual ACF data values, including nested structures like repeater and flexible content sub-fields. Pass `restBase` (e.g., "team-member") and optionally `id` to fetch a specific post. If no `id` is given, it returns the post with the richest ACF data.

For manual queries in code, use `makeCMSRequest` (imported from `./wordpress`). Authentication is handled automatically.

```typescript
// makeCMSRequest returns { success: boolean, data?: T, error?: string }

// Discover all post types (including custom ones)
const { data: types } = await makeCMSRequest('/wp/v2/types');
// types: { post: {...}, page: {...}, product: { rest_base: 'products', taxonomies: ['product_cat'] }, ... }

// Discover all taxonomies
const { data: taxonomies } = await makeCMSRequest('/wp/v2/taxonomies');
// taxonomies: { category: {...}, post_tag: {...}, product_cat: { rest_base: 'product_cat', types: ['product'] }, ... }

// Get a single post to inspect its field structure (use acf_format=standard for expanded ACF values)
const { data: sample } = await makeCMSRequest('/wp/v2/posts?per_page=1&_embed&acf_format=standard');
// ACF fields appear in the `acf` property -- acf_format=standard returns full objects (e.g., image with url/width/height) instead of just IDs
```

## Posts
```typescript
const posts = await getPosts({ page: 1, perPage: 10 });
const post = await getPost('my-post-slug');

// Render content safely
<article set:html={post.content.rendered} />
```

## Pages
```typescript
const pages = await getPages();
const page = await getPage('about');
```

## Featured Images
```typescript
const imageUrl = getFeaturedImageUrl(post, 'large');
// Sizes: thumbnail, medium, large, full

{post._embedded?.['wp:featuredmedia']?.[0] && (
    <img src={getFeaturedImageUrl(post, 'large')} alt={post.title.rendered} />
)}
```

## Custom Post Types
```typescript
// Fetch custom post type items using their rest_base
const { data: products } = await makeCMSRequest('/wp/v2/products?_embed');
const { data: productArr } = await makeCMSRequest('/wp/v2/products?slug=my-product&_embed');
const product = productArr?.[0];

// Custom post types often have ACF fields in the `acf` property
const price = product?.acf?.price;
const gallery = product?.acf?.gallery;
```

## ACF (Advanced Custom Fields)
```typescript
// ACF fields appear in the `acf` property of posts/pages/custom types
const post = await getPost('my-post');
const heroImage = post.acf?.hero_image; // image field
const features = post.acf?.features;     // repeater field (array)
const relatedPosts = post.acf?.related;  // relationship field (array of post IDs)

// ACF options pages (if configured)
const { data: options } = await makeCMSRequest('/acf/v3/options/theme-settings');
const siteLogo = options?.acf?.site_logo;
```

## Custom Taxonomies
```typescript
// Fetch terms for a custom taxonomy using its rest_base
const { data: productCats } = await makeCMSRequest('/wp/v2/product_cat');
// Filter posts by custom taxonomy term
const { data: filteredProducts } = await makeCMSRequest('/wp/v2/products?product_cat=5');
```

## Custom Requests (add to src/lib/functions.ts)
```typescript
// In src/lib/functions.ts:
import { makeCMSRequest } from './wordpress';

// makeCMSRequest handles auth and base URL automatically
export async function getProducts() {
    const { data } = await makeCMSRequest<any[]>('/wp/v2/products?_embed');
    return data || [];
}
```

## Forms (Fluent Forms)
```typescript
await submitFluentForm(formId, {
    name: 'John',
    email: 'john@example.com',
    message: 'Hello!'
});
```

## Comments
```typescript
await createComment(postId, 'Great post!', {
    name: 'Commenter',
    email: 'commenter@example.com'
});
```

## Navigation
```typescript
const navPages = await getNavigationPages();
const menuItems = await getMenuItems('main');
const isActive = isActivePath(Astro.url.pathname, '/about');
```
