import { FixableIssue } from '../types.js'

/**
 * Generate an AI-ready fix prompt for a collection of fixable issues.
 * Structured for Claude to understand the problem and suggest solutions.
 */
export function buildFixPrompt(issues: FixableIssue[], storeName: string, storeDomain: string): string {
  // Group by severity
  const bySeverity = {
    critical: issues.filter((i) => i.severity === 'critical'),
    high: issues.filter((i) => i.severity === 'high'),
    medium: issues.filter((i) => i.severity === 'medium'),
  }

  const critical = bySeverity.critical.length
  const high = bySeverity.high.length
  const medium = bySeverity.medium.length

  let markdown = `# QA Fix Prompt — ${storeName}

**Store:** ${storeDomain}
**Total Issues:** ${issues.length} (${critical} critical, ${high} high, ${medium} medium)

---

You are a Shopify QA specialist helping to fix issues found in an automated QA audit. For each issue below:

1. **Understand the problem** — read the description
2. **Assess impact** — why this matters to the store
3. **Suggest a fix** — step-by-step instructions for the store owner or developer
4. **Prioritize** — which issues to tackle first

## Issues by Severity

`

  if (bySeverity.critical.length > 0) {
    markdown += `### 🚨 Critical (${bySeverity.critical.length})\n\n`
    for (const issue of bySeverity.critical) {
      markdown += formatIssueBlock(issue)
    }
    markdown += '\n'
  }

  if (bySeverity.high.length > 0) {
    markdown += `### ⚠️ High (${bySeverity.high.length})\n\n`
    for (const issue of bySeverity.high) {
      markdown += formatIssueBlock(issue)
    }
    markdown += '\n'
  }

  if (bySeverity.medium.length > 0) {
    markdown += `### 💡 Medium (${bySeverity.medium.length})\n\n`
    for (const issue of bySeverity.medium) {
      markdown += formatIssueBlock(issue)
    }
    markdown += '\n'
  }

  markdown += `---

## Fix Strategy

### Step 1: Review & Triage
- Review each issue above
- Identify quick wins (effort: minutes)
- Plan multi-step fixes (effort: hours)

### Step 2: Categorize by Type
- **Admin settings:** Direct Shopify Admin changes
- **Content edits:** Product data, images, descriptions, SEO metadata
- **Code changes:** Theme code or custom JavaScript
- **App installs:** Install/configure critical apps

### Step 3: Execute Fixes
- Start with critical/high severity
- Test each fix on a dev/staging store
- Verify with the Layer 2 AI tester (checkout flow, visual, mobile)

### Step 4: Re-test
After applying fixes, run: \`npm run dev -- qa-full -c your-config.yml\`

---

## Notes
- Many issues have an \`admin_url\` pointing to the relevant Shopify Admin page
- Effort estimates (minutes/hours) are rough; adjust based on your theme complexity
- Contact Shopify Support for app conflicts or payment gateway issues
`

  return markdown
}

/** Format a single issue as a structured block. */
function formatIssueBlock(issue: FixableIssue): string {
  let block = `#### ${issue.id}: ${issue.title}\n\n`
  block += `**Category:** ${issue.category} | **Fix Type:** ${issue.fix_type} | **Effort:** ${issue.effort}\n\n`
  block += `**Problem:** ${issue.problem}\n\n`
  block += `**Solution:** ${issue.fix}\n\n`

  if (issue.admin_url) {
    block += `**Admin Link:** \`${issue.admin_url}\`\n\n`
  }

  block += '---\n\n'
  return block
}
