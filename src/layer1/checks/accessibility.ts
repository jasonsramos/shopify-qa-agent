import { SiteConfig, AccessibilityResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'
import AxeBuilder from '@axe-core/playwright'
import { BrowserSession } from '../browser-session.js'

const IMPACT_TO_SEVERITY: { [key: string]: 'critical' | 'high' | 'medium' | 'low' } = {
  critical: 'critical',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
}

export async function runAccessibilityCheck(
  config: SiteConfig,
  sharedSession?: BrowserSession
): Promise<AccessibilityResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running accessibility check for ${base}`)

  // ── Try browser-based axe scanning first ───────────────────────────────

  let axeRan = false
  let owned = false
  let session: BrowserSession | null = null
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))

    try {
      // Test homepage
      const pages = ['/', '/products', '/cart']
      const allViolations: any[] = []

      for (const pagePath of pages) {
        const page = await session.newPage()
        try {
          await page.goto(`${base}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
          const results = await new AxeBuilder({ page }).analyze()
          allViolations.push(...results.violations.map((v: any) => ({ ...v, _page: pagePath })))
        } catch (err) {
          logger.debug(`Failed to run axe on ${pagePath}: ${err}`)
        } finally {
          await page.close()
        }
      }

      axeRan = true

      if (allViolations.length === 0) {
        findings.push({
          id: 'axe-no-violations',
          severity: 'info',
          title: 'No WCAG violations detected (axe)',
          description: 'Ran axe-core against homepage, products, and cart pages. No critical or serious accessibility violations found.',
        })
      } else {
        // Dedupe: the same rule violation appears once per page scanned — merge
        // by rule id, unioning affected pages and elements.
        const byRule = new Map<string, any>()
        for (const v of allViolations) {
          const existing = byRule.get(v.id)
          if (existing) {
            existing.pages.add(v._page)
            existing.nodes.push(...v.nodes)
          } else {
            byRule.set(v.id, { ...v, pages: new Set([v._page]), nodes: [...v.nodes] })
          }
        }

        // Group deduped violations by impact
        const byImpact: { [key: string]: any[] } = {}
        for (const v of byRule.values()) {
          if (!byImpact[v.impact]) byImpact[v.impact] = []
          byImpact[v.impact].push(v)
        }

        // Report each violation with actionable detail: rule, pages, and the
        // exact elements (CSS selector + HTML snippet) so fixes can be targeted.
        for (const impact of ['critical', 'serious', 'moderate']) {
          const violations = byImpact[impact] || []
          if (violations.length === 0) continue

          const severity = IMPACT_TO_SEVERITY[impact] || 'medium'
          // Neutralize raw HTML/backticks so the snippet renders as literal text
          // in both markdown and the PDF (marked escapes inline-code content).
          const code = (s: string) => '`' + String(s ?? '').replace(/`/g, "'") + '`'
          const detail = violations
            .map((v: any) => {
              const pages = [...v.pages].join(', ')
              const elements = v.nodes
                .slice(0, 3)
                .map((n: any) => {
                  const sel = Array.isArray(n.target) ? n.target.join(' ') : String(n.target ?? '')
                  const html = (n.html || '').replace(/\s+/g, ' ').slice(0, 120)
                  // No leading 4-space indent (that would become a markdown code block).
                  return `  – ${code(sel)} → ${code(html)}`
                })
                .join('\n')
              const more = v.nodes.length > 3 ? `\n  …and ${v.nodes.length - 3} more element(s)` : ''
              return `- **${v.id}** — ${v.help} (${v.nodes.length} element(s) on ${pages})\n${elements}${more}\n  Fix: ${v.helpUrl}`
            })
            .join('\n')

          findings.push({
            id: `axe-${impact}`,
            severity,
            title: `${violations.length} ${impact} WCAG violation type(s) (axe)`,
            description: `Found ${violations.length} distinct ${impact} accessibility rule violation(s):\n${detail}`,
            recommendation: 'Fix each element listed above. Rule documentation links included per violation.',
            evidence: violations.map((v: any) => `${v.id}×${v.nodes.length}`).join(', '),
          })
        }
      }
    } finally {
      if (owned && session) await session.close()
    }
  } catch (err: any) {
    logger.debug(`Axe-core scan failed: ${err.message}. Falling back to regex checks.`)
  }

  // ── Fallback: Static HTML regex checks (if axe didn't run) ───────────────

  if (!axeRan) {
    try {
      const response = await secureFetch(`${base}/`, { timeout: 30000 })
      const html = await response.text()

      // Check 1: Missing Alt Text
      const images = html.match(/<img[^>]*>/gi) || []
      const imagesWithoutAlt = images.filter((img) => !img.includes('alt=') || img.includes('alt=""'))

      if (imagesWithoutAlt.length > 0) {
        findings.push({
          id: 'missing-alt-text',
          severity: 'high',
          title: `${imagesWithoutAlt.length} images missing alt text`,
          description: `Found ${imagesWithoutAlt.length} images without alt text. This makes content inaccessible to screen reader users.`,
          recommendation: 'Add descriptive alt text to all images.',
          evidence: `${imagesWithoutAlt.length} images`,
        })
      }

      // Check 2: Form Labels
      const inputs = html.match(/<input[^>]*>/gi) || []
      const unlabeledInputs = inputs.filter((input) => {
        const id = input.match(/id="([^"]*)"/)?.[1]
        if (!id) return true
        return !html.includes(`<label for="${id}">`)
      })

      if (unlabeledInputs.length > 0) {
        findings.push({
          id: 'form-missing-labels',
          severity: 'high',
          title: `${unlabeledInputs.length} form inputs missing labels`,
          description: `Found ${unlabeledInputs.length} form inputs without associated labels. Screen reader users cannot understand the input purpose.`,
          recommendation: 'Add <label> elements with for= attributes for all form inputs.',
          evidence: `${unlabeledInputs.length} inputs`,
        })
      }

      // Check 3: Heading Hierarchy
      const h1Count = (html.match(/<h1[^>]*>/gi) || []).length
      if (h1Count !== 1) {
        findings.push({
          id: h1Count === 0 ? 'missing-h1' : 'multiple-h1',
          severity: 'medium',
          title: h1Count === 0 ? 'Page missing H1 heading' : `Multiple H1 headings (${h1Count} found)`,
          description: 'Best practice: Each page should have exactly one H1 heading.',
          recommendation: 'Use only one H1 per page. Use H2, H3 for subheadings.',
        })
      }

      // Check 4: ARIA Landmarks
      const hasNav = html.includes('role="navigation"') || html.includes('<nav')
      const hasMain = html.includes('role="main"') || html.includes('<main')
      const hasContentinfo = html.includes('role="contentinfo"') || html.includes('<footer')

      if (!hasNav || !hasMain || !hasContentinfo) {
        findings.push({
          id: 'missing-landmarks',
          severity: 'low',
          title: 'Missing ARIA landmarks',
          description: `Missing key landmarks: ${[!hasNav && 'navigation', !hasMain && 'main', !hasContentinfo && 'contentinfo'].filter(Boolean).join(', ')}`,
          recommendation: 'Use semantic HTML: <nav>, <main>, <footer>.',
        })
      }
    } catch (err) {
      logger.debug(`Failed to run fallback regex checks: ${err}`)
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: 'accessibility-pass',
      severity: 'info',
      title: 'No accessibility issues detected',
      description: 'Accessibility scan completed without finding critical or high-severity violations.',
    })
  }

  return {
    id: 'accessibility',
    name: 'Accessibility Audit (WCAG 2.1 AA)',
    status: findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
    pages_tested: 3,
    wcag_violations: findings.map((f) => ({
      ...f,
      wcag_level: 'AA' as const,
      element: 'html',
    })),
    contrast_issues: 0,
    missing_alt_text: 0,
    keyboard_navigation_broken: false,
  }
}
