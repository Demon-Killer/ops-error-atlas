# Ops Error Atlas

An English technical content site focused on backend and network errors. The first release is designed to validate a simple loop:

`build -> deploy -> index -> traffic -> later AdSense review`

## What is included

- Home page
- Error guide index
- 5 starter error articles
- `Error Explainer` rule-based tool
- About, Privacy, Contact pages
- `robots.txt`
- `sitemap`

## Local development

Install dependencies:

```bash
npm install
```

Start the local development server:

```bash
npm run dev
```

Build the static site:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Content structure

Articles live in:

```text
src/content/errors/
```

Each article is a Markdown file with this frontmatter:

```yaml
title: 'What does "connection reset by peer" mean?'
description: Learn what the error means and which commands to run first.
slug: connection-reset-by-peer
publishedAt: 2026-05-13
tags:
  - TCP
  - Linux
related:
  - broken-pipe
popular: true
```

## Add a new article

1. Create a new Markdown file in `src/content/errors/`
2. Fill in the required frontmatter
3. Keep the article structure consistent:
   - What it means
   - Common causes
   - How to diagnose it
   - Commands to try
   - How to fix it
   - FAQ
4. Run:

```bash
npm run build
```

If the build passes, the new route will be generated automatically.

## Deploy to Cloudflare Pages

This project can be deployed on the free `Cloudflare Pages` plan using the default `*.pages.dev` subdomain.

### Option 1: Git-based deployment

Recommended when you want automatic deploys after each push.

1. Push this project to GitHub
2. Log in to Cloudflare
3. Open `Workers & Pages`
4. Click `Create`
5. Choose `Pages`
6. Choose `Connect to Git`
7. Select this repository
8. Set:
   - Framework preset: `Astro`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: leave empty if the repo root is this project
9. Click `Save and Deploy`

### Option 2: Direct upload

Recommended when you want the fastest first deployment without Git.

1. Run:

```bash
npm run build
```

2. Log in to Cloudflare
3. Open `Workers & Pages`
4. Click `Create`
5. Choose `Pages`
6. Choose `Upload assets`
7. Upload the full `dist/` directory

### Expected site URL

Cloudflare will assign a URL like:

```text
https://ops-error-atlas.pages.dev
```

You can keep this free subdomain for testing before buying a custom domain.

## Before Search Console submission

Replace these placeholders first:

- `your-email@example.com` in `src/pages/contact.astro`
- the site URL in `astro.config.mjs` if your final `pages.dev` project name differs

## Before AdSense preparation

Do not apply too early. First reach:

- at least 15 to 30 focused content pages
- a complete About page
- a complete Privacy page
- a working Contact page
- real index coverage in Google Search Console

## Current gaps

- No custom domain yet
- No analytics snippet yet
- Only 5 articles so far
- Contact email is still a placeholder

## Suggested next step

1. Deploy to Cloudflare Pages
2. Confirm the public `pages.dev` URL
3. Update `astro.config.mjs` with the final URL
4. Add 10 more articles
5. Submit the site to Google Search Console
