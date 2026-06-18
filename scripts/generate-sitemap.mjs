import fs from 'node:fs';
import path from 'node:path';

const site = 'https://ops-error-atlas.pages.dev';
const contentDir = path.resolve('src/content/errors');
const outputFile = path.resolve('public/sitemap.xml');
const defaultLastmod = '2026-06-17T00:00:00.000Z';

const staticPages = [
	'/',
	'/about/',
	'/contact/',
	'/errors/',
	'/methodology/',
	'/privacy/',
	'/terms/',
	'/tool/',
];

function readErrorPages() {
	return fs
		.readdirSync(contentDir)
		.filter((file) => file.endsWith('.md'))
		.map((file) => {
			const body = fs.readFileSync(path.join(contentDir, file), 'utf8');
			const slug = body.match(/^slug:\s*['"]?([^'"\n]+)['"]?/m)?.[1];
			const updatedAt = body.match(/^updatedAt:\s*([0-9-]+)/m)?.[1];
			const publishedAt = body.match(/^publishedAt:\s*([0-9-]+)/m)?.[1];

			if (!slug) {
				throw new Error(`Missing slug in ${file}`);
			}

			return {
				loc: `${site}/errors/${slug}/`,
				lastmod: `${updatedAt ?? publishedAt ?? '2026-06-17'}T00:00:00.000Z`,
			};
		})
		.sort((a, b) => a.loc.localeCompare(b.loc));
}

const urls = [
	...staticPages.map((page) => ({
		loc: `${site}${page}`,
		lastmod: defaultLastmod,
	})),
	...readErrorPages(),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map(
		({ loc, lastmod }) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
  </url>`,
	)
	.join('\n')}
</urlset>
`;

fs.writeFileSync(outputFile, xml, 'utf8');
