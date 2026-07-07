import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'

const CANDIDATE_PAGES = [
  { url: '/', name: 'homepage' },
  { url: '/cart', name: 'cart' },
  { url: '/pages/contact', name: 'contact' },
  { url: '/account/register', name: 'register' },
  { url: '/account/login', name: 'login' },
]

export async function runFormAuditCheck(config: SiteConfig, sharedSession?: BrowserSession): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []
  const base = baseUrl(config.store_url)

  logger.debug('Running form audit check')

  let owned = false
  let session: BrowserSession | null = null
  let hasNewsletter = false
  let hasContactForm = false

  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))

    for (const page of CANDIDATE_PAGES) {
      let html = ''
      try {
        const browserPage = await session.newPage()
        try {
          const resp = await browserPage.goto(`${base}${page.url}`, { waitUntil: 'domcontentloaded', timeout: 12000 })
          if (!resp || resp.status() >= 400) continue
          html = await browserPage.content()
        } finally {
          await browserPage.close().catch(() => null)
        }
      } catch (err) {
        logger.debug(`Failed to load ${page.name}: ${err}`)
        continue
      }

      const formRegex = /<form[\s\S]*?<\/form>/gi
      const forms = html.match(formRegex) || []
      if (forms.length === 0) continue

      // Detect key form types
      const lowerHtml = html.toLowerCase()
      if (/newsletter|subscribe|sign up for|email.*updates/i.test(html)) hasNewsletter = true
      if (page.name === 'contact' || /contact[-_ ]?form|name="contact/i.test(html)) hasContactForm = true

      // Check 1: Forms with non-HTTPS action
      const formsWithoutHttps = forms.filter((form) => {
        const action = form.match(/action=["']([^"']*)["']/)?.[1]
        return action && !action.startsWith('https://') && !action.startsWith('/') && action.startsWith('http://')
      })
      if (formsWithoutHttps.length > 0) {
        findings.push({
          id: `form-http-${page.name}`,
          severity: 'critical',
          title: `Form on ${page.name} submits to HTTP (not HTTPS)`,
          description: `Found a form with an http:// action on ${page.name}. This exposes submitted data to interception.`,
          recommendation: 'Ensure all forms use HTTPS endpoints or relative paths.',
          evidence: page.name,
        })
      }

      // Check 2: Email inputs missing autocomplete
      const emailInputs = html.match(/<input[^>]*type\s*=\s*["']email["'][^>]*>/gi) || []
      const emailWithoutAutocomplete = emailInputs.filter((input) => !/autocomplete=/i.test(input))
      if (emailWithoutAutocomplete.length > 0) {
        findings.push({
          id: `email-missing-autocomplete-${page.name}`,
          severity: 'low',
          title: `${emailWithoutAutocomplete.length} email input(s) on ${page.name} missing autocomplete`,
          description: 'Email inputs should set autocomplete="email" to speed up entry and improve conversion.',
          recommendation: 'Add autocomplete="email" to email input fields.',
          evidence: page.name,
        })
      }

      // Check 3: Inputs without labels (and placeholder-as-label anti-pattern)
      const inputs = html.match(/<input[^>]*>/gi) || []
      const realInputs = inputs.filter((i) => !/type\s*=\s*["'](hidden|submit|button)["']/i.test(i))
      const unlabeled = realInputs.filter((input) => {
        const id = input.match(/id=["']([^"']*)["']/)?.[1]
        if (id && new RegExp(`<label[^>]*for=["']${id}["']`, 'i').test(html)) return false
        if (/aria-label\s*=|aria-labelledby\s*=/i.test(input)) return false
        return true
      })
      if (unlabeled.length > 0) {
        // Of the unlabeled, how many rely only on placeholder?
        const placeholderOnly = unlabeled.filter((i) => /placeholder\s*=/i.test(i))
        findings.push({
          id: `form-missing-labels-${page.name}`,
          severity: 'high',
          title: `${unlabeled.length} form input(s) on ${page.name} missing labels`,
          description: `Found ${unlabeled.length} inputs without an associated <label> or aria-label${placeholderOnly.length > 0 ? `, of which ${placeholderOnly.length} use a placeholder as a substitute for a label (placeholders vanish on focus and fail WCAG)` : ''}.`,
          recommendation: 'Add a <label for=""> (or aria-label) to every input. Do not rely on placeholder text as a label.',
          evidence: page.name,
        })
      }

      // Check 4: GDPR / consent on forms that collect PII
      const collectsPII = emailInputs.length > 0 || /type=["']tel["']|name=["'][^"']*(phone|address|name)/i.test(html)
      if (collectsPII) {
        const hasConsent =
          /type=["']checkbox["'][^>]*>(?:(?!<\/form>).)*?(consent|agree|privacy|gdpr|terms)/i.test(html) ||
          /(consent|agree|privacy|gdpr)(?:(?!<\/form>).)*?type=["']checkbox["']/i.test(html) ||
          lowerHtml.includes('privacy policy') ||
          lowerHtml.includes('privacy-policy')
        if (!hasConsent) {
          findings.push({
            id: `form-no-consent-${page.name}`,
            severity: 'medium',
            title: `Form on ${page.name} collects personal data without visible consent`,
            description: `A form on ${page.name} collects email/phone/address but has no consent checkbox or privacy-policy link nearby. This is a GDPR/CCPA compliance risk.`,
            recommendation: 'Add a consent checkbox and/or a link to your privacy policy adjacent to the submit button.',
            evidence: page.name,
          })
        }
      }

      // Check 5: Generic submit button text
      const submitButtons = html.match(/<button[^>]*>([\s\S]*?)<\/button>/gi) || []
      const genericButtons = submitButtons.filter((btn) => {
        const text = (btn.match(/>([\s\S]*?)<\/button>/)?.[1] || '').replace(/<[^>]*>/g, '').trim().toLowerCase()
        return ['submit', 'go', 'send', 'ok'].includes(text)
      })
      if (genericButtons.length > 0) {
        findings.push({
          id: `generic-button-text-${page.name}`,
          severity: 'low',
          title: `${genericButtons.length} button(s) on ${page.name} use generic text`,
          description: 'Buttons use generic text like "Submit" or "Go". Action-specific labels improve UX and conversion.',
          recommendation: 'Use action-specific text: "Add to Cart", "Sign Up", "Send Message", etc.',
          evidence: page.name,
        })
      }
    }

    // Informational: key form presence
    findings.push({
      id: 'form-presence',
      severity: 'info',
      title: 'Key form presence',
      description: `Newsletter signup: ${hasNewsletter ? 'found' : 'not found'}. Contact form: ${hasContactForm ? 'found' : 'not found'}.`,
    })

    if (!findings.some((f) => f.severity !== 'info')) {
      findings.unshift({
        id: 'forms-good',
        severity: 'info',
        title: 'Form audit: no major issues found',
        description: 'Forms use HTTPS, have proper labels, consent affordances, and clear button text.',
      })
    }

    return {
      id: 'form-audit',
      name: 'Form Audit',
      status: findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Form audit error: ${err.message}`)
    findings.push({
      id: 'form-audit-error',
      severity: 'medium',
      title: 'Form audit failed',
      description: `Could not analyse forms: ${err.message}`,
    })
    return {
      id: 'form-audit',
      name: 'Form Audit',
      status: 'warning',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } finally {
    if (owned && session) await session.close()
  }
}
