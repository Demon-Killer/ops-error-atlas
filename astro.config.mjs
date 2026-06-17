// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const site = 'https://ops-error-atlas.pages.dev';
const contentDir = path.resolve('./src/content/errors');
const defaultLastmod = '2026-06-17T00:00:00.000Z';

function readErrorLastmods() {
	const lastmods = new Map();

	for (const file of fs.readdirSync(contentDir)) {
		if (!file.endsWith('.md')) {
			continue;
		}

		const body = fs.readFileSync(path.join(contentDir, file), 'utf8');
		const slug = body.match(/^slug:\s*['"]?([^'"\n]+)['"]?/m)?.[1];
		const updatedAt = body.match(/^updatedAt:\s*([0-9-]+)/m)?.[1];
		const publishedAt = body.match(/^publishedAt:\s*([0-9-]+)/m)?.[1];

		if (slug) {
			lastmods.set(`${site}/errors/${slug}/`, `${updatedAt ?? publishedAt ?? '2026-06-17'}T00:00:00.000Z`);
		}
	}

	return lastmods;
}

const errorLastmods = readErrorLastmods();

export default defineConfig({
	site,
	integrations: [
		sitemap({
			serialize(item) {
				item.lastmod = errorLastmods.get(item.url) ?? defaultLastmod;
				return item;
			},
		}),
	],
});
