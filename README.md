# Ops Error Atlas

Ops Error Atlas is an English technical content site focused on backend, Linux, network, Nginx, DNS, TCP, and TLS troubleshooting.

The project is designed to validate a practical publishing loop:

`research -> build -> deploy -> index -> improve -> monetize`

Live site:

```text
https://ops-error-atlas.pages.dev/
```

## What is included

- Home page
- Error guide index
- 20+ focused troubleshooting guides
- `Error Explainer` rule-based tool
- About, Privacy, Contact pages
- `robots.txt`
- `sitemap`
- `ads.txt`
- Google Search Console verification tag
- Google AdSense site code

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

The site already includes:

- public `robots.txt`
- public sitemap
- Google site verification meta tag
- canonical production URL configured for the current Cloudflare Pages domain

## AdSense preparation

The site already includes the core AdSense preparation items:

- complete About page
- complete Privacy page
- working Contact page
- focused technical content library
- AdSense site script
- `ads.txt` at the site root

## Current gaps

- No custom domain yet
- No privacy-friendly analytics snippet yet
- Search indexing is still early
- AdSense approval is still pending

## Suggested next step

1. Keep the deployed site stable while Search Console and AdSense re-check it
2. Publish one high-quality troubleshooting guide at a steady cadence
3. Add a custom domain when the project direction is confirmed
4. Add privacy-friendly analytics after indexing is stable
