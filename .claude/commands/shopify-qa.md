# /shopify-qa — Autonomous Shopify QA Agent

Run a full QA audit on a Shopify store. Uses a coordinator pattern: Layer 1
runs automated checks via CLI (zero tokens), then specialist agents test the
live store in the browser with minimal context each.

## Usage

```
/shopify-qa <store-domain>
/shopify-qa <store-domain> --skip-ai
```

Example:
```
/shopify-qa vingtor-2.myshopify.com
```

Credentials and settings are auto-loaded from the matching config file in `configs/`.

## Arguments

`$ARGUMENTS` contains whatever the user typed after `/shopify-qa`.
Extract: store domain (required), optional flags (`--skip-ai`).

---

## Execution Steps

### Step 0 — Find config (or ask user for credentials)

**Check if a config file exists for this store:**

```bash
ls configs/
```

Read each `.yml` config file. Find one where `store_domain` matches the
domain the user provided. Note the `admin_access_token`, `project_path`,
`storefront_password`, and any `known_issues`.

**If NO matching config file exists**, ask the user:

```
I need a few details to run the audit:

1. Admin API token (from Shopify Admin → Apps → Develop apps → your app → API credentials)
   It starts with shpat_ or shpps_

2. Storefront password (only if the store is password-protected — press Enter to skip)

3. Theme GitHub repo URL (optional, for deeper code analysis — e.g. https://github.com/Kilowott-HQ/Vingtor)
   Press Enter to skip

```

Once the user provides them, create a config file:

```bash
# Create configs/ directory if it doesn't exist
mkdir -p configs
```

Write a `configs/<store-domain>.yml` file:
```yaml
name: <store name from domain>
store_domain: <domain>
admin_access_token: <token from user>
storefront_password: <password if provided, else omit>
project_path: <github url if provided, else omit>
store_plan: advanced
test_checkout: true
test_on_mobile: true
key_pages:
  - /
  - /products
  - /cart
  - /checkout
```

**Do NOT spawn the shopify-theme-summarizer agent** — Layer 1 already analyzed
the theme code. The `agent-context-theme.md` file contains everything needed.
Just note that `project_path` is set so you run the qa-theme agent later.

---

### Step 1 — Run Layer 1 + Automated Layer 2 (zero tokens)

```bash
npm run dev -- qa-full -c configs/<store-domain>.yml
```

**Use `qa-full` not `run`** — `run` only does Layer 1. `qa-full` does:
- Layer 1 (all 26 automated checks)
- Automated Layer 2 (checkout flow screenshots, footer link checking, visual screenshots)
- GitHub theme analysis
- Generates agent context files

If the store has a storefront password, the config file already has it so the
agent will bypass it automatically.

Wait for it to complete (~5-8 minutes). The output directory will be printed — note it.
It will look like: `qa-reports/<store-domain>-<date>/`

This produces:
- `layer1-results.json` — raw findings
- `layer2-findings.json` — automated browser test results
- `layer2-prompt.md` — full context
- `agent-context-checkout.md` — context for checkout agent
- `agent-context-visual.md` — context for visual agent
- `agent-context-forms.md` — context for forms agent
- `agent-context-mobile.md` — context for mobile agent
- `agent-context-theme.md` — context for theme agent
- `screenshots/` — automated screenshots (checkout flow, footer links, responsive)

---

### Step 2 — Read Layer 1 summary

Read `layer1-results.json` briefly. Note:
- Overall status (BLOCKED / WARNING / PASS)
- Critical and high findings
- Whether checkout issues were flagged
- Whether forms were found
- Whether a theme repo was analyzed

---

### Step 3 — Dispatch specialist agents sequentially

**IMPORTANT: Playwright MCP uses a single browser — agents MUST run one at
a time. Dispatch them sequentially, NOT in parallel.**

Before dispatching each agent:
1. Read the agent's context file (e.g. `qa-reports/<output-dir>/agent-context-checkout.md`)
2. Note the absolute screenshots directory path: `<absolute-path-to-output-dir>/screenshots/`
3. Pass BOTH the context file content AND the absolute screenshots path in the prompt

**The screenshots directory path must be absolute** (e.g. `C:\Users\Kilowott\Desktop\shopify-qa-agent\qa-reports\vingtor-2.myshopify.com-2026-06-12\screenshots\`). The agent uses `browser_take_screenshot` with the `savePath` pointing to this directory.

#### Agent 1: Checkout Flow (always run)

```
Use the qa-checkout agent:
"Store URL: [store-url]
Screenshots directory (absolute path): [absolute-path]/screenshots/
Context:
[paste full content of agent-context-checkout.md]"
```

#### Agent 2: Visual Assessment (always run)

```
Use the qa-visual agent:
"Store URL: [store-url]
Screenshots directory (absolute path): [absolute-path]/screenshots/
Context:
[paste full content of agent-context-visual.md]"
```

#### Agent 3: Form Quality (if forms found in Layer 1)

```
Use the qa-forms agent:
"Store URL: [store-url]
Screenshots directory (absolute path): [absolute-path]/screenshots/
Context:
[paste full content of agent-context-forms.md]"
```

#### Agent 4: Mobile UX (always run)

```
Use the qa-mobile agent:
"Store URL: [store-url]
Screenshots directory (absolute path): [absolute-path]/screenshots/
Context:
[paste full content of agent-context-mobile.md]"
```

#### Agent 5: Theme Verification (if project_path set)

```
Use the qa-theme agent:
"Store URL: [store-url]
Screenshots directory (absolute path): [absolute-path]/screenshots/
Context:
[paste full content of agent-context-theme.md]"
```

**Skip agents that don't apply:**
- Skip qa-checkout — automated Layer 2 (qa-full) already ran the full checkout flow with screenshots
- Skip qa-visual — automated Layer 2 already captured desktop/mobile/footer screenshots
- Skip qa-mobile — automated Layer 2 already tested mobile viewports
- **Only run these agents:**
  - qa-forms (if forms found in Layer 1) — CRO scoring and Kilowott Form Standard
  - qa-theme (if `project_path` in config) — verify theme features work on live site

---

### Step 4 — Collect and write layer2-findings.json

Collect the JSON output from each agent. Each agent returns a JSON object.
Combine them and write to `qa-reports/<output-dir>/layer2-findings.json`.

**CRITICAL: The JSON must follow this EXACT structure** (report-merger.ts depends on it):

```json
{
  "tested_at": "<ISO timestamp>",
  "store_domain": "<domain e.g. vingtor-2.myshopify.com>",
  "investigations": [
    {
      "id": "checkout-flow-deep",
      "status": "pass|fail|warning",
      "summary": "one-line summary from agent",
      "details": "detailed paragraph from agent",
      "screenshots": ["filename-only.png", "not-full-path.png"],
      "issues": [
        {
          "severity": "blocker|major|minor",
          "title": "issue title",
          "description": "specific description",
          "location": "https://full-url",
          "how_to_fix": "specific fix"
        }
      ]
    }
  ]
}
```

**Important notes:**
- `screenshots` array must contain **filenames only** (e.g. `"visual-home-desktop.png"`), NOT full paths
- Each agent's JSON output maps to one entry in `investigations`
- Use the agent's `id` field exactly as returned (e.g. `checkout-flow-deep`, `visual-assessment`, `form-quality-cro`, `mobile-ux`, `theme-code-verification`)

Write this file using the Write tool to `qa-reports/<output-dir>/layer2-findings.json`.

---

### Step 5 — Merge and generate final report

```bash
npm run dev -- merge --report qa-reports/<output-dir>
```

---

### Step 6 — Present results

Read `qa-reports/<output-dir>/final-report.md` and present to the user:
- Overall status (APPROVED / CONDITIONAL / BLOCKED)
- Blocker and major issues with fix instructions
- What was tested (which specialist agents ran)
- Report location: `qa-reports/<output-dir>/final-report.md`
- PDF location: `qa-reports/<output-dir>/final-report.pdf`

---

## Why This Architecture

- **Layer 1 (CLI)** = zero AI tokens, runs all automated checks
- **Specialist agents (Haiku)** = each gets only its slice of context from agent-context-*.md files
- **Coordinator (you)** = stays lean, only orchestrates and merges
- **Result:** Fast, token-efficient, no redundant codebase reading

## Rules

- Do NOT read raw theme files yourself — use agent-context-theme.md which Layer 1 already generated
- Do NOT read the full layer2-prompt.md — use the agent-context-*.md files only
- Do NOT submit payment or create real orders
- Each specialist agent takes its own screenshots
- If an agent fails, note it and continue with the others
- Run browser agents SEQUENTIALLY (single Playwright browser)
