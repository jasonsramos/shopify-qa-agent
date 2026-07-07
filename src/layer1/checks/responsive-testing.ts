import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import path from 'path'
import { screenshotWhenLoaded } from '../playwright-utils.js'
import { BrowserSession } from '../browser-session.js'

interface Viewport {
  name: string
  width: number
  height: number
  deviceScaleFactor?: number
}

const VIEWPORTS: Viewport[] = [
  { name: 'Mobile (iPhone)', width: 375, height: 667 },
  { name: 'Tablet Portrait', width: 768, height: 1024 },
  { name: 'Tablet Landscape', width: 1024, height: 768 },
  { name: 'Desktop', width: 1440, height: 900 },
  { name: 'Large Desktop', width: 1920, height: 1080 },
]

export async function runResponsiveTestingCheck(
  config: SiteConfig,
  screenshotsDir?: string,
  sharedSession?: BrowserSession
): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running responsive testing check for ${base}`)

  const pages = ['/', '/products', config.test_checkout ? '/cart' : null].filter(Boolean) as string[]

  // Only screenshot key viewports to keep the folder clean
  const SCREENSHOT_VIEWPORTS = ['Mobile (iPhone)', 'Desktop']

  let owned = false
  let session: BrowserSession | null = null
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))

    for (const page of pages) {
      for (const viewport of VIEWPORTS) {
        const browserPage = await session.newPage()
        await browserPage.setViewportSize({ width: viewport.width, height: viewport.height })

        try {
          await browserPage.goto(`${base}${page}`, { waitUntil: 'domcontentloaded', timeout: 15000 })

          // Take screenshot for key viewports (wait for full render)
          if (screenshotsDir && SCREENSHOT_VIEWPORTS.includes(viewport.name)) {
            const slug = `${page.replace(/\//g, '_') || 'home'}-${viewport.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`
            await screenshotWhenLoaded(browserPage, path.join(screenshotsDir, `responsive${slug}.png`))
          }

          // Check for layout issues
          const overflows = await browserPage.evaluate(() => {
            const docElement = document.documentElement
            const bodyElement = document.body
            const scrollWidth = Math.max(docElement.scrollWidth, bodyElement.scrollWidth)
            const clientWidth = docElement.clientWidth
            return scrollWidth > clientWidth
          })

          if (overflows) {
            findings.push({
              id: `responsive-overflow-${page}-${viewport.name.replace(/\s+/g, '-').toLowerCase()}`,
              severity: 'medium',
              title: `Horizontal overflow on ${page} at ${viewport.name}`,
              description: `Page content overflows horizontally on ${viewport.name} (${viewport.width}x${viewport.height}). This creates poor user experience on smaller screens.`,
              recommendation: 'Check CSS media queries and ensure content fits within viewport.',
            })
          }

          // Check for touch targets (mobile only)
          if (viewport.width <= 768) {
            const smallTargets = await browserPage.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, a[href], input[type="submit"], [role="button"]'))
              return buttons.filter((el: any) => {
                const rect = el.getBoundingClientRect()
                return rect.width < 44 || rect.height < 44
              }).length
            })

            if (smallTargets > 0) {
              findings.push({
                id: `responsive-touch-targets-${page}-${viewport.name.replace(/\s+/g, '-').toLowerCase()}`,
                severity: 'medium',
                title: `Small touch targets on ${page} at ${viewport.name}`,
                description: `Found ${smallTargets} interactive elements smaller than 44x44px. Touch targets should be at least 44x44px for mobile accessibility.`,
                recommendation: 'Increase padding/size of buttons and links on mobile.',
              })
            }
          }
        } catch (err: any) {
          findings.push({
            id: `responsive-test-error-${page}-${viewport.name.replace(/\s+/g, '-').toLowerCase()}`,
            severity: 'low',
            title: `Could not test ${page} at ${viewport.name}`,
            description: `Error testing viewport: ${err.message}`,
          })
        } finally {
          await browserPage.close()
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        id: 'responsive-pass',
        severity: 'info',
        title: 'Responsive design is working well',
        description: `Tested ${pages.length} pages across ${VIEWPORTS.length} viewports. No major responsive issues detected.`,
      })
    }
  } catch (err: any) {
    findings.push({
      id: 'responsive-browser-error',
      severity: 'high',
      title: 'Could not run responsive testing',
      description: `Browser automation failed: ${err.message}`,
      recommendation: 'Check Playwright installation and network connectivity.',
    })
  } finally {
    if (owned && session) await session.close()
  }

  return {
    id: 'responsive-testing',
    name: 'Responsive Testing',
    status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.some((f) => f.severity === 'high') ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
