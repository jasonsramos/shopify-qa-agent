import * as fs from 'fs/promises'
import path from 'path'
import { Layer1Results } from '../types.js'
import { buildLayer2Queue } from './queue-builder.js'
import { logger } from '../utils.js'

/**
 * Generate 5 lean context files for specialist agents.
 * Each is <2KB, contains only what that agent needs.
 * Mirrors WP agent's agent-context-*.md files.
 */
export async function buildAgentContextFiles(l1: Layer1Results, outputDir: string): Promise<void> {
  const queue = buildLayer2Queue(l1)
  // ── 1. Checkout Agent Context ──────────────────────────────────────
  const checkoutItems = queue.filter((q) => q.category === 'flow' || q.id.includes('checkout'))
  const checkoutContext = `# Agent Context — Checkout & Flow Testing

**Shopify Store:** ${l1.store_domain}
**Tested:** ${new Date(l1.ran_at).toLocaleString()}

## Critical Path
- [ ] Homepage loads
- [ ] Product page accessible
- [ ] Add to cart succeeds
- [ ] Cart page displays
- [ ] Checkout page reachable (do NOT submit)
- [ ] Test on mobile (375x812) and desktop

## Custom Checkout Fields
Inspect during testing:
- All email/name/address fields present
- No unexpected required fields
- Error messages clear
- Mobile: no overflow, inputs focus correctly

## Screenshot Directory
Save to: \`screenshots/\`

## Investigations
${checkoutItems.map((q) => `- ${q.id}: ${q.description}`).join('\n')}
`
  await fs.writeFile(path.join(outputDir, 'agent-context-checkout.md'), checkoutContext, 'utf-8')

  // ── 2. Visual Assessment Context ──────────────────────────────────────
  const visualItems = queue.filter((q) => q.id === 'visual-assessment' || q.category === 'visual')
  const brokenPages = l1.all_checks.flatMap((c) => c.findings).filter((f) => f.id.includes('404') || f.title.includes('404'))
  const visualContext = `# Agent Context — Visual Assessment

**Shopify Store:** ${l1.store_domain}
**Tested:** ${new Date(l1.ran_at).toLocaleString()}

## Pages to Inspect
- Homepage: /
- Products: /products
- Cart: /cart
- Checkout: /checkout
${brokenPages.length > 0 ? `\n## Known Broken Pages\n${brokenPages.map((f) => `- ${f.title}`).join('\n')}\n` : ''}

## Visual Checklist (Mobile 375x812 + Desktop 1440x900)
- [ ] Hero image loads (no placeholder)
- [ ] Product images load
- [ ] Layout responsive, no overflow
- [ ] Text readable, no overlaps
- [ ] Buttons clickable and sized correctly
- [ ] Navigation accessible
- [ ] Footer links work

## Screenshot Directory
Save to: \`screenshots/\`

## Investigations
${visualItems.map((q) => `- ${q.id}: ${q.description}`).join('\n')}
`
  await fs.writeFile(path.join(outputDir, 'agent-context-visual.md'), visualContext, 'utf-8')

  // ── 3. Forms & CRO Context ──────────────────────────────────────────
  const formItems = queue.filter((q) => q.id.includes('form') || q.category === 'ux')
  const formContext = `# Agent Context — Forms & CRO

**Shopify Store:** ${l1.store_domain}
**Tested:** ${new Date(l1.ran_at).toLocaleString()}

## Form Pages
- Contact form: /contact (if exists)
- Cart: /cart
- Checkout: /checkout
- Newsletter: (if exists)

## Kilowott Form Standard Checklist
Per form:
- [ ] Email field has placeholder example (e.g., "you@example.com")
- [ ] Name field has placeholder (e.g., "John Smith")
- [ ] All required fields marked (red asterisk or text)
- [ ] Label text visible (not just placeholder)
- [ ] GDPR consent checkbox present (if collecting PII)
- [ ] Privacy link present and clickable
- [ ] Submit button: good contrast, clear text
- [ ] Mobile: input fields don't overflow, keyboard dismisses
- [ ] Success message shows

## CRO Assessment
Rate form quality /10:
- Label clarity (0-2)
- Placeholder quality (0-2)
- Mobile UX (0-2)
- Trust signals (0-2)
- Validation feedback (0-2)

## Screenshot Directory
Save to: \`screenshots/\`

## Investigations
${formItems.slice(0, 3).map((q) => `- ${q.id}: ${q.description}`).join('\n')}
`
  await fs.writeFile(path.join(outputDir, 'agent-context-forms.md'), formContext, 'utf-8')

  // ── 4. Mobile UX Context ──────────────────────────────────────────────
  const mobileItems = queue.filter((q) => q.id.includes('mobile') || q.id === 'responsive-critical')
  const mobileContext = `# Agent Context — Mobile UX

**Shopify Store:** ${l1.store_domain}
**Tested:** ${new Date(l1.ran_at).toLocaleString()}
**Viewport:** 375×812 (iPhone)

## Mobile Checklist
- [ ] Hamburger menu works (if present)
- [ ] Menu items tap correctly
- [ ] Touch targets ≥44×44px (buttons, links, nav)
- [ ] Forms: inputs focus without zoom
- [ ] Forms: keyboard dismisses after input
- [ ] Hero video: loads without blank (or poster image present)
- [ ] Images: not oversized, responsive srcset
- [ ] Sticky header: doesn't overlap content
- [ ] Footer: all links tappable
- [ ] Checkout: multi-step, clear progress

## Performance Notes
${(l1.all_checks.find((c) => c.id === 'performance') as any)?.lighthouse_scores?.mobile
  ? `- Mobile Lighthouse: ${(l1.all_checks.find((c) => c.id === 'performance') as any).lighthouse_scores.mobile.performance}/100`
  : '- (Lighthouse score not available)'}

## Screenshot Directory
Save to: \`screenshots/\`

## Investigations
${mobileItems.map((q) => `- ${q.id}: ${q.description}`).join('\n')}
`
  await fs.writeFile(path.join(outputDir, 'agent-context-mobile.md'), mobileContext, 'utf-8')

  // ── 5. Theme/Code Analysis Context ──────────────────────────────────
  const themeItems = queue.filter((q) => q.category === 'code-driven')
  const themeCheck = l1.all_checks.find((c) => c.id === 'shopify-theme')
  const themeContext = `# Agent Context — Theme & Code Verification

**Shopify Store:** ${l1.store_domain}
**Tested:** ${new Date(l1.ran_at).toLocaleString()}

## Theme Info
${themeCheck ? `- Theme: ${(themeCheck as any).theme_name || 'Unknown'}
- Assets: ${(themeCheck as any).asset_count || '?'} files` : '- (Theme info not available)'}

## Automated Checks Already Run
- Liquid templates validated
- JavaScript files scanned
- CSS structure checked
- Configuration validated

## What to Verify on Live Site
- All Liquid sections render without errors
- Custom JS functionality works (if present)
- CSS styles apply correctly
- No console errors on all pages
- Product variants work if custom logic

## Layer 1 Code Analysis
If available in parent context:
- Custom checkout fields
- Hooks/filters
- REST endpoints
- Custom post types

## Screenshot Directory
Save to: \`screenshots/\`

## Investigations
${themeItems.map((q) => `- ${q.id}: ${q.description}`).join('\n')}
${themeItems.length === 0 ? '(No code-driven investigations queued)' : ''}
`
  await fs.writeFile(path.join(outputDir, 'agent-context-theme.md'), themeContext, 'utf-8')

  logger.success(`✓ Generated 5 agent-context files in ${outputDir}`)
}
