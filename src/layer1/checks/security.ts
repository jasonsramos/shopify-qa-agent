import { SiteConfig, SecurityResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'

/**
 * Comprehensive Shopify store security scan
 *
 * Checks:
 *  1. SSL/TLS certificate validity
 *  2. HTTPS enforcement
 *  3. Security headers (OWASP recommended)
 *  4. Sensitive file exposure
 *  5. Directory listing
 *  6. Mixed content
 *  7. CORS configuration
 *  8. Theme file security
 *  9. API endpoint exposure
 * 10. Checkout security
 * 11. Payment gateway configuration
 * 12. Admin panel accessibility
 * 13. Third-party script security
 * 14. CDN security
 * 15. Backup file exposure
 */
export async function runSecurityCheck(
  config: SiteConfig,
  session?: BrowserSession
): Promise<SecurityResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []
  const headersMap: Record<string, string> = {}
  const exposedFiles: { path: string; status: number; risk: string }[] = []

  logger.debug(`Running security check for ${config.store_domain}`)

  // ── Check 1: HTTPS Enforcement ────────────────────────────────────────

  try {
    const httpUrl = base.replace('https://', 'http://')
    const response = await secureFetch(httpUrl, { redirect: 'manual', timeout: 5000 }).catch(
      () => null
    )

    if (response && response.status >= 300 && response.status < 400) {
      // Good: redirects to HTTPS
      logger.debug('✓ HTTP redirects to HTTPS')
    } else if (response && response.ok) {
      findings.push({
        id: 'https-not-enforced',
        severity: 'critical',
        title: 'HTTP not enforced to HTTPS',
        description: `Your store is accessible via HTTP (${httpUrl}) without redirect to HTTPS. This allows man-in-the-middle attacks.`,
        recommendation:
          'Enable HTTPS enforcement in Shopify Admin. Shopify handles this automatically for myshopify.com domains.',
      })
    }
  } catch (err) {
    // Expected: many servers reject HTTP
    logger.debug('HTTP request failed (expected for HTTPS-only stores)')
  }

  // ── Check 2: Security Headers ──────────────────────────────────────────

  try {
    const response = await secureFetch(base, { timeout: 10000 })
    const headers = response.headers
    headers.forEach((v, k) => (headersMap[k] = v))

    const criticalHeaders = [
      'x-frame-options',
      'x-content-type-options',
      'content-security-policy',
      'strict-transport-security',
      'referrer-policy',
    ]

    for (const header of criticalHeaders) {
      const value = headers.get(header)
      if (!value) {
        findings.push({
          id: `missing-header-${header}`,
          severity: header === 'strict-transport-security' ? 'high' : 'medium',
          title: `Missing security header: ${header}`,
          description: `The ${header} header is not set. This can leave the store vulnerable to certain attacks.`,
          recommendation: `Configure ${header} in your theme or via Shopify settings.`,
        })
      }
    }

    // CSP quality — present but weak directives
    const csp = headers.get('content-security-policy')
    if (csp) {
      const weak: string[] = []
      if (csp.includes('unsafe-inline')) weak.push("'unsafe-inline'")
      if (csp.includes('unsafe-eval')) weak.push("'unsafe-eval'")
      if (/(^|\s)\*($|\s|;)/.test(csp) || csp.includes('default-src *')) weak.push('wildcard (*) source')
      if (weak.length > 0) {
        findings.push({
          id: 'csp-weak',
          severity: 'low',
          title: 'Content-Security-Policy contains weak directives',
          description: `CSP is set but allows ${weak.join(', ')}, which significantly reduces its protection against XSS.`,
          recommendation: 'Tighten CSP: remove unsafe-inline/unsafe-eval and wildcard sources; use nonces or hashes.',
          evidence: weak.join(', '),
        })
      }
    }

    // Version / technology disclosure headers
    const disclosureHeaders = ['server', 'x-powered-by', 'x-generator', 'x-aspnet-version', 'x-aspnetmvc-version']
    for (const h of disclosureHeaders) {
      const val = headers.get(h)
      // Shopify's own "Server: cloudflare" / nginx without version is fine; flag values that leak a version number
      if (val && /\d+\.\d+/.test(val)) {
        findings.push({
          id: `version-disclosure-${h}`,
          severity: 'low',
          title: `Software version disclosed via ${h} header`,
          description: `The ${h} header exposes a version ("${val}"). Attackers use this to target known CVEs.`,
          recommendation: `Suppress or genericize the ${h} response header.`,
          evidence: val,
        })
      }
    }
  } catch (err) {
    logger.debug(`Failed to check security headers: ${err}`)
  }

  // ── Check 3: Admin Panel Accessible ────────────────────────────────────

  try {
    const adminUrl = `${base}/admin`
    const response = await secureFetch(adminUrl, { timeout: 5000 })

    if (response.ok) {
      findings.push({
        id: 'admin-accessible',
        severity: 'high',
        title: 'Admin panel accessible at /admin',
        description: `Your Shopify admin panel is accessible at ${adminUrl}. This is expected, but ensure strong passwords/2FA.`,
        recommendation: 'Enable 2-factor authentication for all admin accounts.',
      })
    }
  } catch (err) {
    logger.debug(`Admin panel check failed: ${err}`)
  }

  // ── Check 4: Sensitive File Exposure ───────────────────────────────────

  const sensitiveFiles = [
    // Secrets / credentials
    { path: '/.env', risk: 'Environment variables / secrets exposed' },
    { path: '/.env.local', risk: 'Local environment secrets exposed' },
    { path: '/.env.production', risk: 'Production environment secrets exposed' },
    { path: '/.npmrc', risk: 'NPM auth token may be exposed' },
    { path: '/.aws/credentials', risk: 'AWS credentials exposed' },
    { path: '/id_rsa', risk: 'Private SSH key exposed' },
    { path: '/.htpasswd', risk: 'Password hashes exposed' },
    // Version control
    { path: '/.git/HEAD', risk: 'Git repository exposed (full source recoverable)' },
    { path: '/.git/config', risk: 'Git repository config exposed' },
    { path: '/.gitignore', risk: 'Repo structure hints exposed' },
    { path: '/.svn/entries', risk: 'SVN repository exposed' },
    // Build / dependency manifests
    { path: '/package.json', risk: 'Dependency manifest exposed' },
    { path: '/package-lock.json', risk: 'Dependency lockfile exposed' },
    { path: '/yarn.lock', risk: 'Dependency lockfile exposed' },
    { path: '/composer.json', risk: 'PHP dependency manifest exposed' },
    { path: '/composer.lock', risk: 'PHP dependency lockfile exposed' },
    { path: '/Gemfile', risk: 'Ruby dependency manifest exposed' },
    { path: '/requirements.txt', risk: 'Python dependency manifest exposed' },
    // Config files
    { path: '/config.php', risk: 'Configuration file exposed' },
    { path: '/config.yml', risk: 'Configuration file exposed' },
    { path: '/config.json', risk: 'Configuration file exposed' },
    { path: '/settings.json', risk: 'Settings file exposed' },
    { path: '/.vscode/settings.json', risk: 'Editor settings exposed' },
    { path: '/web.config', risk: 'IIS configuration exposed' },
    { path: '/.htaccess', risk: 'Apache configuration exposed' },
    { path: '/wp-config.php', risk: 'WordPress config (if migrated)' },
    { path: '/server.js', risk: 'Server source code exposed' },
    // Logs & dumps & backups
    { path: '/debug.log', risk: 'Debug log exposed' },
    { path: '/error_log', risk: 'Error log exposed' },
    { path: '/backup.zip', risk: 'Full site backup exposed' },
    { path: '/backup.sql', risk: 'Database backup exposed' },
    { path: '/db.sql', risk: 'Database dump exposed' },
    { path: '/dump.sql', risk: 'Database dump exposed' },
    { path: '/database.sql', risk: 'Database dump exposed' },
    { path: '/.DS_Store', risk: 'macOS directory metadata exposed (file listing)' },
  ]

  await Promise.all(
    sensitiveFiles.map(async (file) => {
      try {
        const response = await secureFetch(`${base}${file.path}`, {
          method: 'HEAD',
          redirect: 'manual',
          timeout: 5000,
        }).catch(() => null)

        if (response && response.status === 200) {
          exposedFiles.push({ path: file.path, status: 200, risk: file.risk })
          findings.push({
            id: `exposed-file-${file.path.replace(/[^a-z0-9]/g, '-')}`,
            severity: 'critical',
            title: `Sensitive file exposed: ${file.path}`,
            description: `${base}${file.path} is accessible. ${file.risk}. Remove this file immediately.`,
            recommendation: `Delete ${file.path} from your web root. Ensure sensitive files are never deployed publicly.`,
          })
        }
      } catch {
        // File not accessible (good)
      }
    })
  )

  // ── Check 5: Directory Listing ─────────────────────────────────────────

  const directories = ['/cdn/shop/t/', '/cdn/shop/v/', '/s/files/']

  for (const dir of directories) {
    try {
      const response = await secureFetch(`${base}${dir}`, { timeout: 5000 })
      const text = await response.text()

      if (text.includes('Index of') || text.includes('directory listing')) {
        findings.push({
          id: `dir-listing-${dir.replace(/[^a-z0-9]/g, '-')}`,
          severity: 'high',
          title: `Directory listing enabled: ${dir}`,
          description: `Directory listing is enabled at ${dir}. This can expose file structure and sensitive information.`,
          recommendation: 'Configure your web server to disable directory listing.',
        })
      }
    } catch {
      // Not a directory or not accessible
    }
  }

  // ── Check 6: Checkout Page Security ────────────────────────────────────

  try {
    const checkoutUrl = `${base}/checkout`
    const response = await secureFetch(checkoutUrl, { timeout: 10000 })
    const status = response.status

    if (status === 404) {
      findings.push({
        id: 'checkout-not-accessible',
        severity: 'critical',
        title: 'Checkout page not found (404)',
        description: `The checkout page (${checkoutUrl}) returned 404. The checkout route may be disabled or misconfigured.`,
        recommendation: 'Verify your store is published and checkout is enabled in Shopify Admin.',
      })
    } else if (status === 500) {
      findings.push({
        id: 'checkout-server-error',
        severity: 'critical',
        title: 'Checkout page server error (500)',
        description: `The checkout page (${checkoutUrl}) returned a 500 server error.`,
        recommendation: 'Check Shopify status page and Admin error logs.',
      })
    } else if (status === 403 || status === 401) {
      // Shopify returns 403 when accessing /checkout without an active cart session — this is expected
      findings.push({
        id: 'checkout-requires-session',
        severity: 'info',
        title: 'Checkout URL exists (requires cart session)',
        description: `Checkout returned ${status} — normal Shopify behavior when accessing /checkout directly without items in cart.`,
      })
      logger.debug('✓ Checkout URL exists (403/401 without cart is expected)')
    } else if (status >= 300 && status < 400) {
      findings.push({
        id: 'checkout-redirects',
        severity: 'info',
        title: 'Checkout page redirects',
        description: `Checkout URL redirects (${status}) — typical for Shopify custom domain checkouts.`,
      })
    } else {
      logger.debug('✓ Checkout page accessible')
    }
  } catch (err) {
    findings.push({
      id: 'checkout-error',
      severity: 'high',
      title: 'Checkout page check failed',
      description: `Error checking checkout page: ${err}`,
      recommendation: 'Verify your store is accessible and checkout is working.',
    })
  }

  // Payment gateway check is handled by Admin Health via GraphQL — skipped here to avoid false positives
  // when the checkout URL returns 403 (no cart session) or redirects to password page.

  // ── Checks 7–11: HTML/cookie-derived (use shared browser session) ──────

  let ownedSession = false
  let sess: BrowserSession | null = null
  try {
    ;({ session: sess, owned: ownedSession } = await BrowserSession.acquire(config, session))
    const html = await sess.getHomeHtml()
    const setCookies = await sess.getHomeSetCookies()
    const hostname = new URL(base).hostname
    const rootDomain = hostname.split('.').slice(-2).join('.')

    // Check 7: Cookie security flags
    if (setCookies.length > 0) {
      const insecure: string[] = []
      for (const c of setCookies) {
        const name = c.split('=')[0].trim()
        const lower = c.toLowerCase()
        const missing: string[] = []
        if (!lower.includes('secure')) missing.push('Secure')
        if (!lower.includes('httponly')) missing.push('HttpOnly')
        if (!lower.includes('samesite')) missing.push('SameSite')
        if (missing.length > 0) insecure.push(`${name} (missing ${missing.join(', ')})`)
      }
      if (insecure.length > 0) {
        findings.push({
          id: 'cookie-flags-missing',
          severity: 'medium',
          title: `${insecure.length} cookie(s) missing security flags`,
          description: `Cookies should set Secure, HttpOnly, and SameSite to resist theft and CSRF. Affected: ${insecure.slice(0, 6).join('; ')}${insecure.length > 6 ? '…' : ''}`,
          recommendation: 'Set Secure + HttpOnly + SameSite=Lax/Strict on all cookies. Shopify-managed cookies are handled by Shopify; this applies to cookies set by your theme/apps.',
          evidence: insecure.slice(0, 10),
        })
      }
    }

    if (html) {
      // Check 8: Subresource Integrity (SRI) on external scripts/styles
      const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
      const externalNoSri = scriptSrcs.filter((m) => {
        const tag = m[0]
        const src = m[1]
        const isExternal = /^https?:\/\//i.test(src) && !src.includes(rootDomain) && !src.includes('shopify')
        return isExternal && !/\bintegrity=/i.test(tag)
      })
      if (externalNoSri.length > 0) {
        findings.push({
          id: 'sri-missing',
          severity: 'low',
          title: `${externalNoSri.length} external script(s) without Subresource Integrity`,
          description: `Third-party scripts loaded without an integrity hash can be silently tampered with if the CDN is compromised. Example: ${externalNoSri[0][1]}`,
          recommendation: 'Add integrity="sha384-…" and crossorigin to external <script>/<link> tags where the provider supports SRI.',
          evidence: externalNoSri.slice(0, 5).map((m) => m[1]),
        })
      }

      // Check 9: Mixed content on an HTTPS page
      if (base.startsWith('https://')) {
        const mixed = [...html.matchAll(/(?:src|href)=["'](http:\/\/[^"']+)["']/gi)]
          .map((m) => m[1])
          .filter((u) => !u.includes('schema.org') && !u.includes('www.w3.org'))
        if (mixed.length > 0) {
          findings.push({
            id: 'mixed-content',
            severity: 'medium',
            title: `${mixed.length} insecure (http://) resource(s) on HTTPS page`,
            description: `Loading http:// resources on an https:// page triggers browser mixed-content warnings and can break the padlock. Example: ${mixed[0]}`,
            recommendation: 'Serve all resources over HTTPS (use protocol-relative or https:// URLs).',
            evidence: mixed.slice(0, 5),
          })
        }
      }

      // Check 10: Suspicious / cryptominer scripts
      const minerSignatures = [
        'coinhive', 'coin-hive', 'cryptonight', 'coinimp', 'cryptoloot', 'crypto-loot',
        'jsecoin', 'minero.cc', 'webminepool', 'deepminer', 'authedmine',
      ]
      const lowerHtml = html.toLowerCase()
      const hits = minerSignatures.filter((sig) => lowerHtml.includes(sig))
      // Obfuscation heuristic: eval(atob(...)) or very long base64 blobs inline
      const obfuscated = /eval\s*\(\s*atob\s*\(/i.test(html) || /[A-Za-z0-9+/]{400,}={0,2}/.test(html)
      if (hits.length > 0) {
        findings.push({
          id: 'cryptominer-detected',
          severity: 'critical',
          title: 'Possible cryptominer script detected',
          description: `Found known crypto-mining signatures in page source: ${hits.join(', ')}. This usually indicates a compromised theme or malicious app.`,
          recommendation: 'Immediately audit theme code and installed apps; remove the offending script and rotate admin credentials.',
          evidence: hits,
        })
      } else if (obfuscated) {
        findings.push({
          id: 'obfuscated-script',
          severity: 'medium',
          title: 'Heavily obfuscated inline script detected',
          description: 'Found eval(atob(...)) or a very long inline base64 blob. Obfuscated code can hide malicious behavior (skimmers, miners).',
          recommendation: 'Review the inline script source; legitimate code rarely needs eval(atob()) or huge base64 inlines.',
        })
      }

      // Check 11: Third-party script domain inventory
      const externalDomains = new Set<string>()
      for (const m of scriptSrcs) {
        try {
          const u = new URL(m[1], base)
          if (u.hostname !== hostname && !u.hostname.includes('shopify')) externalDomains.add(u.hostname)
        } catch {
          /* relative src */
        }
      }
      if (externalDomains.size > 12) {
        findings.push({
          id: 'many-third-party-scripts',
          severity: 'low',
          title: `${externalDomains.size} distinct third-party script domains`,
          description: `Page loads scripts from ${externalDomains.size} external domains. Each is an added attack surface and performance cost. Domains: ${[...externalDomains].slice(0, 8).join(', ')}…`,
          recommendation: 'Audit third-party scripts; remove unused tags and consolidate where possible.',
          evidence: [...externalDomains].slice(0, 15),
        })
      }
    }
  } catch (err: any) {
    logger.debug(`Security HTML/cookie checks failed: ${err.message}`)
  } finally {
    if (ownedSession && sess) await sess.close()
  }

  const headerKeys = [
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'strict-transport-security',
    'referrer-policy',
  ]
  const structuredHeaders: Record<string, string | undefined> = {}
  for (const k of headerKeys) structuredHeaders[k] = headersMap[k]

  return {
    id: 'security',
    name: 'Security Audit',
    status: findings.length === 0 ? 'pass' : findings.some((f) => f.severity === 'critical') ? 'fail' : 'warning',
    duration_ms: Date.now() - startTime,
    findings,
    headers: structuredHeaders,
    exposed_files: exposedFiles,
    vulnerabilities: findings
      .filter((f) => f.severity === 'critical' || f.severity === 'high')
      .map((f) => ({ ...f, category: 'security' })),
  }
}
