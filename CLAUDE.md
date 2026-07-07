# Shopify QA Agent — Fully Automated Testing

A **two-layer automated QA testing tool** for Shopify stores, powered by your Shopify admin token and GitHub CLI.

- **Layer 1:** Automated security, performance, accessibility, SEO checks (zero AI cost)
- **Layer 2:** AI-powered browser testing via specialist agents (Claude Code + Playwright)

---

## Quick Start

```bash
npm install
npm run build
claude
# Then type:
/shopify-qa yourstore.myshopify.com
```

The agent will ask for your credentials on first run, save them, and run everything automatically.

---

## How To Run

### First time on a new store

```
/shopify-qa yourstore.myshopify.com
```

Claude will ask:
1. Admin API token (from Shopify Admin → Apps → Develop apps)
2. Storefront password (if store is password-protected, else skip)
3. GitHub theme repo URL (optional, for deeper code analysis)

Credentials are saved to `configs/yourstore.myshopify.com.yml` — never asked again.

### Subsequent runs

```
/shopify-qa yourstore.myshopify.com
```

Config is already saved — runs immediately.

---

## How It Works

### Layer 1: Automated Checks (zero AI cost)

Runs 26 automated checks using your Shopify Admin API and a real browser:

- **Security** — HTTPS, headers, payment safety, secure scripts
- **Performance** — Lighthouse scores (mobile + desktop), Core Web Vitals
- **Accessibility** — WCAG 2.1 AA compliance
- **SEO** — Meta tags, structured data, sitemaps
- **Shopify-specific** — Products, collections, payments, apps, checkout
- **Responsive** — Mobile & tablet viewports
- **Forms** — Labels, placeholders, GDPR, CRO scoring
- **Content** — Broken links, missing images, alt text
- **Theme code** — Liquid, JS, CSS analysis via GitHub

### Layer 2: AI Browser Testing

Claude Code opens a real browser and tests the store like a human QA engineer:

- **Checkout agent** — Full purchase flow (home → product → cart → checkout)
- **Visual agent** — Desktop + mobile visual inspection
- **Forms agent** — Kilowott Form Standard, CRO scoring /10
- **Mobile agent** — 375×812 viewport, touch targets, hamburger menu
- **Theme agent** — Verifies code features work on the live site

---

## Output

```
qa-reports/yourstore.myshopify.com-YYYY-MM-DD/
├── final-report.md          ← Full QA report
├── final-report.pdf         ← PDF for client
├── layer1-results.json      ← Raw automated findings
├── layer2-findings.json     ← AI browser test findings
├── fixable-issues.json      ← Issues for fix prompts
├── regression.json          ← Changes vs previous run
└── screenshots/             ← All browser screenshots
```

---

## Other CLI Commands

```bash
# Run Layer 1 + automated Layer 2 (checkout, footer, visual screenshots)
npm run dev -- qa-full -c configs/yourstore.yml

# Run Layer 1 only (no browser testing)
npm run dev -- run -c configs/yourstore.yml

# Merge Layer 1 + Layer 2 into final report
npm run dev -- merge --report qa-reports/yourstore-2026-06-12

# Generate AI fix prompts from a report
npm run dev -- fix --report qa-reports/yourstore-2026-06-12

# Save a regression baseline
npm run dev -- snapshot -c configs/yourstore.yml

# Compare against baseline
npm run dev -- diff -c configs/yourstore.yml

# Verify whether an older report's findings are resolved (remediation tracking)
# Runs a fresh Layer 1 and produces verification-report.md/pdf with
# Resolved / Still present / Worse / New tables
npm run dev -- verify --against qa-reports/yourstore-2026-06-12 -c configs/yourstore.yml

# Or compare two existing reports without running anything:
npm run dev -- verify --against qa-reports/yourstore-2026-06-12 --current qa-reports/yourstore-2026-07-06

# Watch the browser while it tests (any of: run, qa-full, verify)
npm run dev -- qa-full -c configs/yourstore.yml --headed
```

## Accuracy notes

- **Cart & checkout are verified via Shopify's AJAX Cart API** (`/cart.js`, `/cart/add.js`)
  and by navigating directly to `/checkout` — not by DOM selector guessing. AJAX
  drawer carts no longer produce false "item not in cart" / "checkout button not
  found" findings.
- **Password-protected stores skip the PageSpeed API** (it can't log in and would
  measure the password page); browser-based metrics from the authenticated session
  are used instead.
- **GitHub theme analysis distinguishes "couldn't fetch repo" from "repo is empty"** —
  repo access failures produce a single low-severity "analysis skipped" note, never
  missing-liquid/config blockers.
- **Checks emit "unverifiable" findings** when bot protection (checkpoint/hCaptcha)
  blocks automation, instead of asserting a failure.

---

## Prerequisites

- Node.js
- Claude Code CLI (`claude --version`)
- GitHub CLI (`gh --version`) — for theme code analysis
- Playwright MCP — installed automatically by Claude Code
- Google PageSpeed API key (optional) — for Lighthouse scores
  ```
  PAGESPEED_API_KEY=your-key  # add to .env
  ```
