# AdSense and Search Console Checklist - 2026-06-17

## Current Site State

- Site URL: `https://ops-error-atlas.pages.dev/`
- XML sitemap: `https://ops-error-atlas.pages.dev/sitemap.xml`
- Text sitemap fallback: `https://ops-error-atlas.pages.dev/sitemap.txt`
- Robots: `https://ops-error-atlas.pages.dev/robots.txt`
- Error guide count after this update: 34
- Generated static page count after this update: 42
- AdSense script status: not loaded before approval
- AdSense account verification meta: kept in the base layout
- Policy pages: `/privacy/`, `/terms/`, `/about/`, `/contact/`, `/methodology/`

## Search Console Steps

1. Open Google Search Console.
2. Select the property for `https://ops-error-atlas.pages.dev/`.
3. Go to `Sitemaps`.
4. Submit `sitemap.xml`.
5. If Search Console still reports `Couldn't fetch` / cannot read the sitemap after deployment is complete, submit `sitemap.txt` as a fallback.
6. If URL Inspection quota is available, inspect only these priority URLs first:
   - `https://ops-error-atlas.pages.dev/`
   - `https://ops-error-atlas.pages.dev/errors/`
   - `https://ops-error-atlas.pages.dev/methodology/`
   - `https://ops-error-atlas.pages.dev/about/`
   - `https://ops-error-atlas.pages.dev/tool/`
7. If Search Console reports that indexing request quota is exceeded, stop manual requests. Do not keep retrying the same URLs. Rely on sitemap discovery and internal links, then check indexing status again after 2-7 days.
8. After quota resets, inspect a small sample of new article URLs:
   - `https://ops-error-atlas.pages.dev/errors/nginx-upstream-sent-too-big-header/`
   - `https://ops-error-atlas.pages.dev/errors/nginx-client-intended-to-send-too-large-body/`
   - `https://ops-error-atlas.pages.dev/errors/too-many-close-wait-connections/`
   - `https://ops-error-atlas.pages.dev/errors/syn-backlog-overflow/`
   - `https://ops-error-atlas.pages.dev/errors/dns-servfail/`

## If Indexing Request Quota Is Exceeded

- This is expected when too many URL Inspection indexing requests are submitted.
- It is not a site code error.
- Do not repeatedly request indexing for the same URL.
- Confirm that `sitemap.xml` or `sitemap.txt` was submitted successfully.
- Confirm that `robots.txt` allows crawling.
- Confirm that new pages are linked from `/errors/` and related guides.
- Wait for Googlebot to discover pages through sitemap and internal links.
- Recheck Search Console indexing status after 2-7 days.

## AdSense Resubmission Timing

- Do not resubmit immediately after deployment.
- Wait until Cloudflare Pages finishes deployment.
- Wait 2-7 days for Google to crawl the updated content.
- In Search Console, confirm that the homepage, `/errors/`, `/methodology/`, and several new article URLs are indexed or at least discovered.
- After that, request AdSense review again.

## What Changed For Low Value Content

- Added practical long-tail troubleshooting guides.
- Added stronger internal links from core guides to new long-tail pages.
- Added maintainer background and editorial responsibility signals.
- Added structured author and publisher URLs in article JSON-LD.
- Kept the site free of pre-approval ad scripts.

## Next Content Candidates

- `TLS alert unknown ca`
- `connection pool exhausted`
- `upstream timed out while connecting`
- `recv() failed connection reset by peer while reading response header`
- `no live upstreams while connecting to upstream`
- `upstream prematurely closed connection while reading response header`
