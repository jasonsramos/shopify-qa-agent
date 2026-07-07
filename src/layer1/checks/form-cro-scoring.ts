import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'

interface FormScore {
  page: string
  formCount: number
  issues: FormIssue[]
  score: number
}

interface FormIssue {
  type: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
}

export async function runFormCroScoringCheck(config: SiteConfig, sharedSession?: BrowserSession): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running form CRO scoring check for ${base}`)

  const pagesToTest = [
    { path: '/products', name: 'Products' },
    config.test_checkout ? { path: '/cart', name: 'Cart' } : null,
    config.test_checkout ? { path: '/checkout', name: 'Checkout' } : null,
  ].filter(Boolean) as { path: string; name: string }[]

  let owned = false
  let session: BrowserSession | null = null
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))

    const formScores: FormScore[] = []

    for (const page of pagesToTest) {
      try {
        const browserPage = await session.newPage()
        await browserPage.setViewportSize({ width: 375, height: 667 })

        await browserPage.goto(`${base}${page.path}`, { waitUntil: 'domcontentloaded', timeout: 15000 })

        const formData = await browserPage.evaluate(() => {
          const forms = Array.from(document.querySelectorAll('form, [role="form"]'))
          return forms.map((form: any) => {
            const inputs = Array.from(form.querySelectorAll('input, textarea, select'))
            const labels = Array.from(form.querySelectorAll('label'))
            const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'))

            const issues: FormIssue[] = []
            let score = 100

            // Check for labels
            inputs.forEach((input: any) => {
              const hasLabel = labels.some((label: any) => label.htmlFor === input.id || label.contains(input))
              if (!hasLabel && input.placeholder) {
                issues.push({
                  type: 'placeholder-only',
                  severity: 'medium',
                  description: `Input uses placeholder instead of label: "${input.placeholder}"`,
                })
                score -= 10
              } else if (!hasLabel && !input.placeholder && input.name !== 'csrf') {
                issues.push({
                  type: 'no-label-or-placeholder',
                  severity: 'high',
                  description: `Input "${input.name}" has no label or placeholder`,
                })
                score -= 15
              }
            })

            // Check for required indicator
            inputs.forEach((input: any) => {
              if (input.required && !input.placeholder?.includes('*') && input.parentElement?.textContent?.includes('*') === false) {
                issues.push({
                  type: 'no-required-indicator',
                  severity: 'low',
                  description: `Required field "${input.name}" doesn't visually indicate it's required`,
                })
                score -= 5
              }
            })

            // Check button text
            buttons.forEach((button: any) => {
              const text = button.textContent?.trim() || button.value || ''
              if (!text || text.length < 2) {
                issues.push({
                  type: 'missing-cta-text',
                  severity: 'high',
                  description: 'Submit button has unclear or missing text',
                })
                score -= 15
              } else if (text.length > 30) {
                issues.push({
                  type: 'long-cta-text',
                  severity: 'low',
                  description: `Submit button text is too long: "${text}"`,
                })
                score -= 5
              }
            })

            // Check for autocomplete attributes
            const autocompleteCount = inputs.filter((i: any) => i.getAttribute('autocomplete')).length
            if (autocompleteCount === 0 && inputs.length > 2) {
              issues.push({
                type: 'no-autocomplete',
                severity: 'low',
                description: 'Form fields lack autocomplete attributes for better mobile UX',
              })
              score -= 10
            }

            // Check contrast on labels
            // @ts-ignore - window is available in browser context
            const lowContrastLabels = labels.filter((label: any) => {
              const color = window.getComputedStyle(label).color
              const bgColor = window.getComputedStyle(label).backgroundColor
              // Simplified contrast check (would need proper WCAG calculation)
              return color === bgColor || color.includes('rgba(0,0,0,0)')
            }).length

            if (lowContrastLabels > 0) {
              issues.push({
                type: 'low-contrast',
                severity: 'medium',
                description: `${lowContrastLabels} label(s) have low contrast`,
              })
              score -= 10
            }

            return {
              inputCount: inputs.length,
              labelCount: labels.length,
              buttonCount: buttons.length,
              issues,
              score: Math.max(0, score),
            }
          })
        })

        const totalScore = formData.length > 0 ? Math.round(formData.reduce((sum: number, f: any) => sum + f.score, 0) / formData.length) : 0

        formScores.push({
          page: page.name,
          formCount: formData.length,
          issues: formData.flatMap((f: any) => f.issues),
          score: totalScore,
        })

        if (formData.length === 0) {
          findings.push({
            id: `form-cro-no-forms-${page.path}`,
            severity: 'info',
            title: `No forms found on ${page.name}`,
            description: `No forms detected on ${page.path}`,
          })
        } else if (totalScore < 70) {
          findings.push({
            id: `form-cro-low-score-${page.path}`,
            severity: 'medium',
            title: `Form CRO score low on ${page.name}: ${totalScore}/100`,
            description: `Form conversion optimization score is ${totalScore}/100. Found ${formData.flatMap((f: any) => f.issues).length} issues affecting conversion rates.`,
            recommendation: 'Review form labels, required indicators, button text clarity, and contrast.',
            evidence: formData.flatMap((f: any) => f.issues.map((i: any) => `${i.type}: ${i.description}`)),
          })
        } else {
          findings.push({
            id: `form-cro-good-score-${page.path}`,
            severity: 'info',
            title: `Form CRO score on ${page.name}: ${totalScore}/100`,
            description: `Form is reasonably optimized for conversion with a score of ${totalScore}/100.`,
          })
        }

        await browserPage.close()
      } catch (err: any) {
        findings.push({
          id: `form-cro-test-error-${page.path}`,
          severity: 'low',
          title: `Could not test forms on ${page.name}`,
          description: `Error: ${err.message}`,
        })
      }
    }

    if (findings.length === 0) {
      findings.push({
        id: 'form-cro-complete',
        severity: 'info',
        title: 'Form CRO assessment complete',
        description: 'Analyzed forms across key pages.',
      })
    }
  } catch (err: any) {
    findings.push({
      id: 'form-cro-browser-error',
      severity: 'high',
      title: 'Could not run form CRO scoring',
      description: `Browser automation failed: ${err.message}`,
      recommendation: 'Check Playwright installation.',
    })
  } finally {
    if (owned && session) await session.close()
  }

  return {
    id: 'form-cro-scoring',
    name: 'Form CRO Scoring',
    status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.some((f) => f.severity === 'high') ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
