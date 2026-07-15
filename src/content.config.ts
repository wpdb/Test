import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const products = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/products' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    price: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    image: z.string().optional(),
    sku: z.string().optional(),
    inStock: z.boolean().optional(),
    date: z.string().optional(),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    image: z.string().optional(),
    client: z.string().optional(),
    date: z.string(),
  }),
});

export const collections = {
  products,
  projects,
};
