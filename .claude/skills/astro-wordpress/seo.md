# SEO Configuration

## Page Meta Tags
```astro
---
const seo = {
    title: 'Page Title | Site Name',
    description: 'Page description for search engines',
    image: '/og-image.png',
    canonical: 'https://example.com/page',
};
---

<Layout {seo}>
    <!-- content -->
</Layout>
```

## Layout SEO Component
```astro
---
interface Props {
    seo?: {
        title?: string;
        description?: string;
        image?: string;
        canonical?: string;
        noindex?: boolean;
    };
}
const { seo } = Astro.props;
---

<head>
    <title>{seo?.title || 'Default Title'}</title>
    <meta name="description" content={seo?.description || 'Default description'} />

    <!-- Open Graph -->
    <meta property="og:title" content={seo?.title} />
    <meta property="og:description" content={seo?.description} />
    <meta property="og:image" content={seo?.image} />

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={seo?.title} />

    {seo?.canonical && <link rel="canonical" href={seo.canonical} />}
    {seo?.noindex && <meta name="robots" content="noindex,nofollow" />}
</head>
```

## WordPress SEO Import
PhantomWP can import SEO from Yoast, Rank Math, or AIOSEO:
- Use SEO Settings (TrendingUp icon) in toolbar
- Configure which plugin to import from
- Meta tags are automatically applied to posts/pages
