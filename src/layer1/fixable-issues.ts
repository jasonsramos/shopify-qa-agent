import { Layer1Results, FixableIssue } from '../types.js'

/**
 * Extract fixable issues from Layer 1 results
 */
export function extractFixableIssues(results: Layer1Results): FixableIssue[] {
  const issues: FixableIssue[] = []
  let id = 1

  // Collect all findings from all checks
  const allFindings = results.all_checks
    .flatMap((c) => c.findings)
    .filter((f) => f.severity !== 'info')
    .sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
      return severityOrder[a.severity as keyof typeof severityOrder] - severityOrder[b.severity as keyof typeof severityOrder]
    })

  for (const finding of allFindings) {
    const fixableIssue = inferFixableIssue(finding, id)
    if (fixableIssue) {
      issues.push(fixableIssue)
      id++
    }
  }

  return issues
}

function inferFixableIssue(finding: any, index: number): FixableIssue | null {
  const id = `FIX-${String(index).padStart(3, '0')}`

  // Security issues
  if (finding.id?.startsWith('missing-header-')) {
    return {
      id,
      severity: finding.severity,
      category: 'security',
      fix_type: 'admin-setting',
      title: finding.title,
      problem: finding.description,
      fix: finding.recommendation || 'Configure the security header in Shopify theme settings',
      admin_url: '/admin/themes/current/editor',
      effort: 'minutes',
    }
  }

  if (finding.id === 'https-not-enforced') {
    return {
      id,
      severity: finding.severity,
      category: 'security',
      fix_type: 'admin-setting',
      title: finding.title,
      problem: finding.description,
      fix: 'Enable HTTPS enforcement in Shopify Admin',
      admin_url: '/admin/settings/general',
      effort: 'minutes',
    }
  }

  if (finding.id?.startsWith('exposed-file-')) {
    return {
      id,
      severity: finding.severity,
      category: 'security',
      fix_type: 'code-change',
      title: finding.title,
      problem: finding.description,
      fix: 'Delete the exposed file from your server',
      effort: 'minutes',
    }
  }

  // Payment/Checkout issues
  if (finding.id === 'no-payment-configured') {
    return {
      id,
      severity: finding.severity,
      category: 'checkout',
      fix_type: 'admin-setting',
      title: finding.title,
      problem: finding.description,
      fix: 'Configure a payment gateway in Shopify Admin Settings',
      admin_url: '/admin/settings/payments',
      effort: 'minutes',
    }
  }

  if (finding.id === 'checkout-not-accessible') {
    return {
      id,
      severity: finding.severity,
      category: 'checkout',
      fix_type: 'admin-setting',
      title: finding.title,
      problem: finding.description,
      fix: 'Verify the store is published and checkout is enabled',
      admin_url: '/admin/settings/checkout',
      effort: 'minutes',
    }
  }

  // Product/Content issues
  if (finding.id === 'products-none' || finding.id === 'products-very-few') {
    return {
      id,
      severity: finding.severity,
      category: 'content',
      fix_type: 'content-edit',
      title: finding.title,
      problem: finding.description,
      fix: 'Add products to your store',
      admin_url: '/admin/products',
      effort: 'hours',
    }
  }

  if (finding.id === 'products-missing-images') {
    return {
      id,
      severity: finding.severity,
      category: 'content',
      fix_type: 'content-edit',
      title: finding.title,
      problem: finding.description,
      fix: 'Add product images via Shopify Admin',
      admin_url: '/admin/products',
      effort: 'hours',
    }
  }

  if (finding.id === 'products-missing-descriptions') {
    return {
      id,
      severity: finding.severity,
      category: 'content',
      fix_type: 'content-edit',
      title: finding.title,
      problem: finding.description,
      fix: 'Add descriptions to products for SEO and customer understanding',
      admin_url: '/admin/products',
      effort: 'hours',
    }
  }

  // Accessibility issues
  if (finding.id?.includes('alt-text') || finding.id === 'missing-alt-text') {
    return {
      id,
      severity: finding.severity,
      category: 'accessibility',
      fix_type: 'content-edit',
      title: finding.title,
      problem: finding.description,
      fix: 'Add alt text to all images for screen reader accessibility',
      effort: 'hours',
    }
  }

  // SEO issues
  if (finding.id?.includes('meta') || finding.id?.includes('seo')) {
    return {
      id,
      severity: finding.severity,
      category: 'seo',
      fix_type: 'content-edit',
      title: finding.title,
      problem: finding.description,
      fix: finding.recommendation || 'Update SEO metadata for better search visibility',
      effort: 'hours',
    }
  }

  // App/Theme issues
  if (finding.id?.includes('app-conflict')) {
    return {
      id,
      severity: finding.severity,
      category: 'apps',
      fix_type: 'app-install',
      title: finding.title,
      problem: finding.description,
      fix: finding.recommendation || 'Resolve app conflict by uninstalling or updating one app',
      admin_url: '/admin/apps',
      effort: 'minutes',
    }
  }

  if (finding.id?.includes('theme')) {
    return {
      id,
      severity: finding.severity,
      category: 'theme',
      fix_type: 'admin-setting',
      title: finding.title,
      problem: finding.description,
      fix: finding.recommendation || 'Update or configure your theme',
      admin_url: '/admin/themes',
      effort: 'hours',
    }
  }

  // Performance issues
  if (finding.id?.includes('performance') || finding.id?.includes('lighthouse')) {
    return {
      id,
      severity: finding.severity,
      category: 'performance',
      fix_type: 'code-change',
      title: finding.title,
      problem: finding.description,
      fix: finding.recommendation || 'Optimize assets and reduce render-blocking resources',
      effort: 'hours',
    }
  }

  // Fallback: create a generic fixable issue
  return {
    id,
    severity: finding.severity,
    category: 'security',
    fix_type: 'admin-setting',
    title: finding.title,
    problem: finding.description,
    fix: finding.recommendation || 'Review and address this finding',
    effort: 'hours',
  }
}
