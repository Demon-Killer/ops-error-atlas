import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const errors = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/errors' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		slug: z.string(),
		publishedAt: z.coerce.date(),
		updatedAt: z.coerce.date().optional(),
		tags: z.array(z.string()),
		related: z.array(z.string()).default([]),
		popular: z.boolean().optional(),
	}),
});

export const collections = {
	errors,
};
