import * as fs from 'fs/promises'
import path from 'path'
import { Layer1Results, SiteConfig } from '../types.js'
import { logger } from '../utils.js'
import { analyzeThemeCode, formatThemeAnalysis } from '../theme-analyzer.js'

/**
 * Build a comprehensive Layer 2 investigation prompt
 */
export async function buildLayer2Prompt(
  results: Layer1Results,
  config: SiteConfig,
  outputDir: string
): Promise<string> {
  const storeName = config.name || config.store_domain

  // Analyze theme code if provided
  let themeAnalysis = ''
  try {
    if (config.project_path) {
      logger.debug(`Analyzing theme code at: ${config.project_path}`)
      const analysis = await analyzeThemeCode(config.project_path)
      if (analysis.hasTheme && analysis.fileCount > 0) {
        themeAnalysis = `\n## Theme Code Context\n\n${formatThemeAnalysis(analysis)}\n`
      }
    }
  } catch (err: any) {
    logger.warn(`Could not analyze theme: ${err.message}`)
  }

  // Get instructions
  let instructions = ''
  try {
    // Resolve path relative to src/layer2/ — works for both tsx (source) and dist/ (compiled)
    const fileUrl = new URL(import.meta.url)
    const dirPath = path.dirname(fileUrl.pathname.replace(/^\/([A-Z]:)/, '$1'))
    const instructionsPath = path.join(dirPath, 'instructions.md')
    instructions = await fs.readFile(instructionsPath, 'utf-8')
  } catch (err: any) {
    logger.warn(`Could not load instructions.md: ${err.message}`)
    instructions = '# Layer 2 Instructions\n\nRefer to src/layer2/instructions.md for detailed testing protocol.'
  }

  // Collect critical and high findings
  const criticalFindings = results.all_checks
    .flatMap((c) => c.findings)
    .filter((f) => f.severity === 'critical')
  const highFindings = results.all_checks
    .flatMap((c) => c.findings)
    .filter((f) => f.severity === 'high')

  return `# Layer 2 Investigation Prompt

**Store Under Test:** ${storeName}
**Domain:** ${config.store_domain}
**Plan:** ${config.store_plan || 'Unknown'}
**Theme:** ${config.theme_name || 'Not specified'}
**Generated:** ${new Date().toISOString()}

${themeAnalysis}---

${instructions}

---

## Layer 1 Summary

Layer 1 automated checks completed with these results:

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${results.critical_findings} |
| 🟠 High | ${results.high_findings} |
| 🟡 Medium | ${results.medium_findings} |
| 🔵 Low | ${results.low_findings} |

**Total Findings:** ${results.total_findings}
**Total Checks Run:** ${results.all_checks.length}

---

## Critical Issues (MUST Investigate)

${
  criticalFindings.length === 0
    ? '_No critical issues found in Layer 1._'
    : criticalFindings
        .map(
          (f) =>
            `### ${f.title}\n\n${f.description}\n\n**How to verify:** Test the checkout flow and payment methods manually.`
        )
        .join('\n\n---\n\n')
}

---

## High Priority Issues (Investigate First)

${
  highFindings.length === 0
    ? '_No high priority issues found._'
    : highFindings
        .map((f) => `- **${f.title}** — ${f.description}`)
        .join('\n')
}

---

## Investigation Queue (Prioritized)

${results.layer2_queue.length === 0 ? '_No items queued for investigation._' : ''}

### High Priority (${results.layer2_queue.filter((i) => i.priority === 'high').length})

${results.layer2_queue
  .filter((i) => i.priority === 'high')
  .map(
    (i, idx) =>
      `${idx + 1}. **${i.title}**
   - Type: ${i.type}
   - Description: ${i.description}
   - Pages: ${i.pages?.join(', ') || 'All pages'}`
  )
  .join('\n\n')}

### Medium Priority (${results.layer2_queue.filter((i) => i.priority === 'medium').length})

${results.layer2_queue
  .filter((i) => i.priority === 'medium')
  .map(
    (i, idx) =>
      `${idx + 1}. **${i.title}**
   - Type: ${i.type}
   - Description: ${i.description}`
  )
  .join('\n\n')}

---

## Store Configuration Context

**Payment Methods Configured:**
${
  results.shopify_store_config?.findings.length > 0
    ? results.shopify_store_config.findings
        .filter((f) => f.id.includes('payment'))
        .map((f) => `- ${f.title}`)
        .join('\n')
    : '- Check Layer 1 results for payment gateway status'
}

**Apps Installed:**
${
  results.shopify_apps?.findings.length > 0
    ? results.shopify_apps.findings.map((f) => `- ${f.title}`).join('\n')
    : '- No apps detected or requires admin credentials'
}

**Security Status:**
${results.security?.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').map((f) => `- ⚠️ ${f.title}`).join('\n') || '- No critical security issues'}

---

## Testing Strategy

### Phase 1: Checkout Flow (Critical)
Focus on homepage → product → cart → checkout flow. Test both desktop and mobile (375px).

### Phase 2: Forms & CRO
Evaluate checkout form quality, newsletter forms, and any custom forms for UX/CRO best practices.

### Phase 3: App Testing
If apps are installed, verify they load and function correctly without breaking the store.

### Phase 4: Mobile & Visual
Test responsive design at multiple viewpoints and check for visual issues (broken images, overlapping text, etc).

### Phase 5: Analytics Verification
Confirm GA4, GTM, or pixel tracking fires correctly during user flows.

---

## Playwright MCP Investigation Steps (for Claude Code operators)

> The automated Layer 2 verifier already ran these flows and saved screenshots to \`screenshots/l2-*.png\`.
> To go deeper, drive these exact steps with the Playwright MCP server. Each step is concrete and reproducible.

### A. Deep checkout flow ${criticalFindings.some((f) => f.id.includes('checkout')) || highFindings.some((f) => f.id.includes('checkout')) ? '⚠️ (Layer 1 flagged checkout)' : ''}
1. \`browser_navigate\` → \`${config.store_url}\`${config.storefront_password ? ` (storefront password: \`${config.storefront_password}\` — submit the password form first)` : ''}
2. \`browser_navigate\` to the first product page, then click **Add to cart** (\`button[name="add"]\`).
3. \`browser_navigate\` → \`${config.store_url}/cart\`; confirm the line item is present.
4. Click **Checkout**; wait for \`**/checkouts/**\`. Confirm email, address, and payment sections render.
5. \`browser_take_screenshot\` at each step. Do NOT submit a real payment.

### B. Mobile + desktop visual sweep
1. \`browser_resize\` to 375×812 (mobile) then 1440×900 (desktop).
2. For \`/\`, \`/products\`, \`/cart\`: navigate, screenshot, and visually check for blank heroes, overlapping text, broken images, or placeholder content.

${
  highFindings.filter((f) => f.id.includes('axe') || f.title.toLowerCase().includes('accessib')).length > 0
    ? '### C. Accessibility re-verification\n1. Tab through the page with the keyboard; confirm focus is visible and order is logical.\n2. Verify the specific axe violations from Layer 1 on the live DOM.\n'
    : ''
}${
  results.security?.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
    ? '### D. Security exploitability check\n1. For each exposed-file/mixed-content/cryptominer finding, navigate to the exact URL and confirm whether it is genuinely reachable/exploitable (kill false positives).\n'
    : ''
}
---

## Optional: Autonomous AI pass

If \`ANTHROPIC_API_KEY\` is set and you run with \`--ai\`, the agent can execute these investigations autonomously. Otherwise the automated verifier above is the zero-cost default.

---

## Output Location

Save all findings to: **${path.join(outputDir, 'layer2-findings.json')}**

Save screenshots to: **${path.join(outputDir, 'screenshots')}/**

After testing, run:
\`\`\`bash
npm run dev -- merge --report ${outputDir}
\`\`\`

This will generate the final merged report combining Layer 1 + Layer 2.

---

## Expected Output Format

See instructions.md for the complete \`layer2-findings.json\` schema and screenshot naming conventions.

Key fields:
- \`id\`: investigation identifier (checkout-flow, form-cro, apps, etc)
- \`status\`: pass | fail | warning
- \`summary\`: one-line finding
- \`details\`: detailed description
- \`screenshots\`: array of screenshot filenames
- \`issues\`: array of specific issues found

---

**Begin testing now. Take your time and be thorough. Good luck!**
`
}
