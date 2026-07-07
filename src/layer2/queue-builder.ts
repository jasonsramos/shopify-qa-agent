import { Layer1Results } from '../types.js'

/**
 * L2 Investigation Queue Item — matches WP agent's structure.
 * Builds a prioritized, trigger-per-finding queue that informs:
 * - agent-context files (sliced by category)
 * - .claude/agents/ tasks (each specialist gets subset)
 */
export interface Layer2QueueItem {
  id: string // checkout-flow-deep, visual-assessment, form-quality-gdpr, etc.
  category: 'flow' | 'visual' | 'anomaly' | 'error-context' | 'ux' | 'code-driven'
  priority: 'high' | 'medium' | 'low'
  title: string
  description: string
  trigger: string // which Layer 1 finding(s) triggered this
  pages?: string[]
  context?: Record<string, any> // code analysis, custom checkout fields, etc.
}

/**
 * Build a rich investigation queue from Layer 1 findings.
 * Each finding → one or more queue items, prioritized.
 * Mirrors WP agent's buildLayer2Queue().
 */
export function buildLayer2Queue(l1: Layer1Results): Layer2QueueItem[] {
  const queue: Layer2QueueItem[] = []

  // ── Always: Core investigations ──────────────────────────────────────
  queue.push({
    id: 'visual-assessment',
    category: 'visual',
    priority: 'medium',
    title: 'Visual Assessment',
    description: 'Inspect site visually on mobile (375x812) and desktop (1440x900). Check for broken images, layout issues, placeholder content, responsive design.',
    trigger: 'Always run',
    pages: ['/', '/products', '/cart'],
  })

  queue.push({
    id: 'checkout-flow-deep',
    category: 'flow',
    priority: 'high',
    title: 'Deep Checkout Flow',
    description: 'Shop → product → add to cart → cart page → checkout page. Verify all form fields, payment section, mobile responsiveness. Do NOT submit.',
    trigger: 'Always run (critical for ecommerce)',
  })

  // ── Errors: Critical/High Layer 1 findings ──────────────────────────
  const criticalFindings = l1.all_checks
    .flatMap((c) => c.findings)
    .filter((f) => f.severity === 'critical' || f.severity === 'high')

  criticalFindings.forEach((finding) => {
    if (finding.id === 'storefront-password-locked') {
      // Skip — Layer 1 already marked as info if password configured
      return
    }

    if (finding.id.includes('axe') || finding.title.toLowerCase().includes('accessibility')) {
      queue.push({
        id: 'accessibility-critical-verify',
        category: 'error-context',
        priority: 'high',
        title: 'Accessibility Critical Violations — Verify',
        description: `Layer 1 flagged: ${finding.title}. Manually verify with keyboard + screen reader on live site.`,
        trigger: `Accessibility check flagged critical/high`,
        pages: ['/', '/products', '/cart', '/checkout'],
      })
    }

    if (finding.title.toLowerCase().includes('404') || finding.title.toLowerCase().includes('broken')) {
      queue.push({
        id: `broken-page-verify-${finding.id}`,
        category: 'anomaly',
        priority: 'high',
        title: `Verify Broken Page: ${finding.title}`,
        description: `Layer 1 found: ${finding.title}. Confirm on live site.`,
        trigger: 'Page health / broken links check',
      })
    }

    if (finding.title.toLowerCase().includes('console') || finding.title.toLowerCase().includes('error')) {
      queue.push({
        id: `console-errors-impact-${finding.id}`,
        category: 'error-context',
        priority: 'high',
        title: `Console/Network Errors — Assess UX Impact`,
        description: `Layer 1 captured: ${finding.title}. Verify whether this actually breaks user flows.`,
        trigger: 'Console & Network Errors check',
      })
    }

    if (
      finding.title.toLowerCase().includes('security') ||
      finding.title.toLowerCase().includes('exposed') ||
      finding.title.toLowerCase().includes('vulnerability')
    ) {
      queue.push({
        id: `security-high-risk-verify-${finding.id}`,
        category: 'error-context',
        priority: 'high',
        title: `Security Issue — Verify Exploitability`,
        description: `Layer 1 flagged: ${finding.title}. Confirm whether genuinely exploitable on live site.`,
        trigger: 'Security scan flagged critical/high',
      })
    }
  })

  // ── Forms ──────────────────────────────────────────────────────────
  const formCheck = l1.all_checks.find((c) => c.id === 'form-audit')
  if (formCheck && formCheck.findings.length > 0) {
    queue.push({
      id: 'form-quality-cro',
      category: 'ux',
      priority: 'medium',
      title: 'Form Quality & CRO Assessment',
      description: 'Evaluate all forms: placeholders, labels, GDPR consent, mobile UX, submit buttons, validation. Calculate CRO Score /10.',
      trigger: 'Form Audit check flagged issues',
      pages: ['/contact', '/cart', '/checkout'],
      context: { form_issues_count: formCheck.findings.length },
    })
  }

  // ── SEO ──────────────────────────────────────────────────────────
  const seoCheck = l1.all_checks.find((c) => c.id === 'seo-health')
  if (seoCheck && seoCheck.findings.length > 0) {
    queue.push({
      id: 'seo-critical-verify',
      category: 'ux',
      priority: 'low',
      title: 'SEO Issues — Spot Check',
      description: 'Verify Layer 1 SEO findings: meta tags, OG tags, structured data presence.',
      trigger: 'SEO Health check flagged issues',
    })
  }

  // ── Responsive ──────────────────────────────────────────────────────
  const responsiveCheck = l1.all_checks.find((c) => c.id === 'responsive')
  if (responsiveCheck && responsiveCheck.findings.length > 0) {
    queue.push({
      id: 'responsive-critical',
      category: 'ux',
      priority: 'medium',
      title: 'Responsive Design — Mobile & Tablet Check',
      description: 'Test on mobile (375x812) and tablet (768x1024). Check layout, overflow, touch targets.',
      trigger: 'Responsive check flagged issues',
      pages: ['/', '/products', '/cart'],
    })
  }

  // ── Mobile-specific ──────────────────────────────────────────────────
  queue.push({
    id: 'mobile-ux',
    category: 'ux',
    priority: 'medium',
    title: 'Mobile UX Assessment',
    description: 'Test at 375x812 (iPhone): hamburger navigation, touch targets (min 44x44px), sticky elements, form inputs, video loading.',
    trigger: 'Always run for Shopify stores (mobile-first audience)',
  })

  // ── Theme/Code ──────────────────────────────────────────────────────
  const themeCheck = l1.all_checks.find((c) => c.id === 'shopify-theme')
  if (themeCheck) {
    queue.push({
      id: 'theme-code-verification',
      category: 'code-driven',
      priority: 'low',
      title: 'Theme Code Verification',
      description: 'If theme analysis available: verify no broken Liquid, JS errors, outdated patterns in live theme.',
      trigger: 'Shopify Theme check + GitHub analysis',
      context: { theme_name: (themeCheck as any).theme_name, asset_count: (themeCheck as any).asset_count },
    })
  }

  // ── Performance ──────────────────────────────────────────────────────
  const perfCheck = l1.all_checks.find((c) => c.id === 'performance')
  if (perfCheck && (perfCheck.findings.some((f) => f.severity === 'high') || (perfCheck as any).lighthouse_scores?.mobile?.performance < 50)) {
    queue.push({
      id: 'performance-ux-impact',
      category: 'ux',
      priority: 'medium',
      title: 'Performance & Mobile Rendering',
      description: 'Assess UX impact of slow load: does hero render? are CTAs clickable? do forms load?',
      trigger: 'Performance check flagged high/critical or Lighthouse mobile <50',
      context: {
        mobile_perf_score: (perfCheck as any).lighthouse_scores?.mobile?.performance ?? 0,
        fcp_ms: (perfCheck as any).lighthouse_scores?.mobile?.fcp_ms ?? 0,
      },
    })
  }

  return queue
}


/** Group queue by category for agent routing. */
export function queueByCategory(queue: Layer2QueueItem[]): Record<string, Layer2QueueItem[]> {
  const grouped: Record<string, Layer2QueueItem[]> = {}
  queue.forEach((item) => {
    if (!grouped[item.category]) grouped[item.category] = []
    grouped[item.category].push(item)
  })
  return grouped
}
