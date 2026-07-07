import { execSync } from 'child_process'
import { logger } from '../utils.js'

export interface GitHubRepo {
  owner: string
  repo: string
  defaultBranch: string
}

export interface ThemeFile {
  path: string
  content: string
  type: 'liquid' | 'javascript' | 'css' | 'json' | 'config' | 'other'
}

export interface ThemeAnalysisResult {
  hasLiquid: boolean
  hasJavaScript: boolean
  hasCSS: boolean
  hasConfig: boolean
  liquidFiles: ThemeFile[]
  jsFiles: ThemeFile[]
  cssFiles: ThemeFile[]
  configFiles: ThemeFile[]
  issues: string[]
  /**
   * True when the repository could not be fetched at all (missing gh CLI, not
   * authenticated, 404, no access). When set, "missing files" findings MUST NOT
   * be generated — we simply don't know what's in the theme.
   */
  fetchFailed: boolean
}

/**
 * Parse GitHub URL to get owner and repo
 */
export function parseGitHubUrl(url: string): GitHubRepo | null {
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w-]+)/)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    defaultBranch: 'main',
  }
}

/**
 * Fetch file content from GitHub via CLI
 */
async function fetchGitHubFile(owner: string, repo: string, filePath: string): Promise<string | null> {
  try {
    // Fetch raw JSON and decode base64 in Node.js (works on Windows/Mac/Linux)
    const json = execSync(`gh api repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
    const data = JSON.parse(json)
    if (!data.content) return null
    return Buffer.from(data.content, 'base64').toString('utf-8')
  } catch (err) {
    return null
  }
}

/**
 * Get file type from extension
 */
function getFileType(filePath: string): ThemeFile['type'] {
  if (filePath.endsWith('.liquid')) return 'liquid'
  if (filePath.endsWith('.js')) return 'javascript'
  if (filePath.endsWith('.css')) return 'css'
  if (filePath.match(/\.(json|config)/)) return 'json'
  if (filePath.match(/^(config|settings)/)) return 'config'
  return 'other'
}

/**
 * Check if GitHub CLI is available and authenticated
 */
function isGitHubCliAvailable(): boolean {
  try {
    execSync('gh --version', { stdio: 'pipe', encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

/**
 * Check if user is authenticated with GitHub CLI
 */
function isGitHubAuthenticated(): boolean {
  try {
    execSync('gh auth status', { stdio: 'pipe', encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

/**
 * Analyze GitHub theme repository
 */
export async function analyzeGitHubTheme(repoUrl: string): Promise<ThemeAnalysisResult> {
  logger.info(`🔍 Analyzing GitHub theme: ${repoUrl}`)

  // Check GitHub CLI is available
  if (!isGitHubCliAvailable()) {
    logger.error('❌ GitHub CLI not found. Please install it first:')
    logger.error('   brew install gh         # macOS')
    logger.error('   Or visit: https://cli.github.com')
    logger.error('')
    logger.error('   Then authenticate: gh auth login')
    return {
      hasLiquid: false,
      hasJavaScript: false,
      hasCSS: false,
      hasConfig: false,
      liquidFiles: [],
      jsFiles: [],
      cssFiles: [],
      configFiles: [],
      issues: ['GitHub CLI not installed. Cannot analyze theme.'],
      fetchFailed: true,
    }
  }

  // Check GitHub CLI is authenticated
  if (!isGitHubAuthenticated()) {
    logger.error('❌ GitHub CLI not authenticated. Please log in:')
    logger.error('   gh auth login')
    return {
      hasLiquid: false,
      hasJavaScript: false,
      hasCSS: false,
      hasConfig: false,
      liquidFiles: [],
      jsFiles: [],
      cssFiles: [],
      configFiles: [],
      issues: ['GitHub CLI not authenticated. Run: gh auth login'],
      fetchFailed: true,
    }
  }

  const githubRepo = parseGitHubUrl(repoUrl)
  if (!githubRepo) {
    logger.warn('Invalid GitHub URL format')
    return {
      hasLiquid: false,
      hasJavaScript: false,
      hasCSS: false,
      hasConfig: false,
      liquidFiles: [],
      jsFiles: [],
      cssFiles: [],
      configFiles: [],
      issues: ['Invalid GitHub URL format'],
      fetchFailed: true,
    }
  }

  const result: ThemeAnalysisResult = {
    hasLiquid: false,
    hasJavaScript: false,
    hasCSS: false,
    hasConfig: false,
    liquidFiles: [],
    jsFiles: [],
    cssFiles: [],
    configFiles: [],
    issues: [],
    fetchFailed: false,
  }

  try {
    // Fetch tree of files (with pagination for large repos)
    logger.debug(`Fetching file tree from ${githubRepo.owner}/${githubRepo.repo}`)

    let filePaths: string[] = []

    try {
      // Step 1: Get the repo's actual default branch (avoids main vs master guessing)
      let defaultBranch = 'main'
      try {
        const repoJson = execSync(
          `gh api repos/${githubRepo.owner}/${githubRepo.repo}`,
          { encoding: 'utf-8', maxBuffer: 1 * 1024 * 1024 }
        )
        const repoData = JSON.parse(repoJson)
        defaultBranch = repoData.default_branch || 'main'
        logger.debug(`Repo default branch: ${defaultBranch}`)
      } catch {
        logger.debug('Could not determine default branch, using main')
      }

      // Step 2: Fetch raw JSON tree (no jq needed - works on Windows)
      const treeJson = execSync(
        `gh api repos/${githubRepo.owner}/${githubRepo.repo}/git/trees/${defaultBranch}?recursive=1`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      )

      const treeData = JSON.parse(treeJson)
      filePaths = (treeData.tree || [])
        .filter((item: any) => item.type === 'blob')
        .map((item: any) => item.path)
        .slice(0, 500) // Limit to 500 files

      if (filePaths.length === 0) {
        logger.warn(`⚠️  No files found in repository. Check if:`)
        logger.warn(`   - Repository URL is correct: ${repoUrl}`)
        logger.warn(`   - You have access to the repository`)
      }

      logger.debug(`Found ${filePaths.length} files on branch '${defaultBranch}', analyzing key files...`)
    } catch (fetchErr: any) {
      logger.error(`Failed to fetch repository files: ${fetchErr.message}`)
      if (fetchErr.message.includes('Repository not found')) {
        result.issues.push('Repository not found. Check the URL and permissions.')
      } else if (fetchErr.message.includes('Unauthorized')) {
        result.issues.push('Access denied. Make sure you are authenticated: gh auth login')
      } else {
        result.issues.push(`Failed to fetch files: ${fetchErr.message}`)
      }
      result.fetchFailed = true
      return result
    }

    // Analyze key theme files
    const keyPatterns = [
      /^(layout|templates|sections|snippets)\/.*\.liquid$/,
      /^(static|assets|js)\/.*\.js$/,
      /^(static|assets|css)\/.*\.css$/,
      /^(config|settings)\/.*\.json$/,
    ]

    for (const filePath of filePaths) {
      const fileType = getFileType(filePath)
      const isKeyFile = keyPatterns.some((pattern) => pattern.test(filePath))

      if (!isKeyFile) continue

      try {
        const content = await fetchGitHubFile(githubRepo.owner, githubRepo.repo, filePath)
        if (!content) continue

        const file: ThemeFile = { path: filePath, content, type: fileType }

        if (fileType === 'liquid') {
          result.liquidFiles.push(file)
          result.hasLiquid = true
        } else if (fileType === 'javascript') {
          result.jsFiles.push(file)
          result.hasJavaScript = true
        } else if (fileType === 'css') {
          result.cssFiles.push(file)
          result.hasCSS = true
        } else if (fileType === 'json' || fileType === 'config') {
          result.configFiles.push(file)
          result.hasConfig = true
        }
      } catch (err) {
        logger.debug(`Could not fetch ${filePath}`)
      }
    }

    logger.success(
      `✓ Analyzed: ${result.liquidFiles.length} Liquid, ${result.jsFiles.length} JS, ${result.cssFiles.length} CSS files`
    )
  } catch (err: any) {
    logger.warn(`GitHub analysis error: ${err.message}`)
    result.issues.push(`Failed to analyze GitHub repo: ${err.message}`)
  }

  return result
}

/**
 * Analyze theme code for common issues
 */
export function generateThemeFindings(
  analysis: ThemeAnalysisResult
): Array<{
  id: string
  summary: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
}> {
  const findings: Array<{
    id: string
    summary: string
    severity: 'critical' | 'high' | 'medium' | 'low'
    description: string
  }> = []

  // If the repo could not be fetched at all, we know NOTHING about the theme.
  // Emit a single "skipped" finding instead of a cascade of bogus
  // missing-liquid/missing-config/missing-css findings.
  if (analysis.fetchFailed) {
    findings.push({
      id: 'theme-analysis-skipped',
      summary: 'Theme code analysis skipped — repository could not be fetched',
      severity: 'low',
      description: `The theme repository could not be fetched, so no code analysis was performed. Reason(s): ${analysis.issues.join('; ') || 'unknown'}. This is NOT a theme defect — fix repo access (URL, permissions, gh auth) and re-run.`,
    })
    return findings
  }

  // Check for required files
  if (!analysis.hasLiquid) {
    findings.push({
      id: 'missing-liquid-templates',
      summary: 'No Liquid template files found',
      severity: 'critical',
      description: 'Theme appears to be missing Liquid template files. Valid Shopify themes require Liquid files.',
    })
  }

  // Check for configuration
  if (!analysis.hasConfig) {
    findings.push({
      id: 'missing-theme-config',
      summary: 'No theme configuration found',
      severity: 'high',
      description: 'Theme config.json is missing. This is required for Online Store 2.0 features.',
    })
  } else {
    // Validate config.json structure if present
    const configFile = analysis.configFiles.find((f) => f.path.endsWith('config.json'))
    if (configFile) {
      try {
        const config = JSON.parse(configFile.content)
        const configIssues: string[] = []

        // Check for required fields
        if (!config.name) configIssues.push('Missing theme name')
        if (!config.settings) configIssues.push('Missing settings object')
        if (!config.sections) configIssues.push('Missing sections object')

        if (configIssues.length > 0) {
          findings.push({
            id: 'config-incomplete',
            summary: 'Theme config.json is incomplete',
            severity: 'medium',
            description: `config.json missing fields: ${configIssues.join(', ')}. This may limit theme functionality.`,
          })
        }
      } catch {
        findings.push({
          id: 'config-invalid-json',
          summary: 'config.json is not valid JSON',
          severity: 'high',
          description: 'Theme config.json contains invalid JSON. This will prevent the theme from loading.',
        })
      }
    }
  }

  // Check for JavaScript quality
  if (analysis.jsFiles.length > 0) {
    const jsIssues: string[] = []

    for (const file of analysis.jsFiles) {
      // Check for deprecated var usage
      const varMatches = (file.content.match(/\bvar\s+\w+\s*=/g) || []).length
      if (varMatches > 0) {
        jsIssues.push(`${file.path}: uses \`var\` (${varMatches} occurrences) — switch to \`const\`/\`let\``)
      }

      // Check for console.log statements
      if (file.content.includes('console.log')) {
        jsIssues.push(`${file.path}: contains console.log statements — remove for production`)
      }

      // Check for dangerous patterns
      if (file.content.includes('eval(') || file.content.includes('innerHTML')) {
        jsIssues.push(`${file.path}: uses potentially unsafe patterns (eval or innerHTML)`)
      }

      // Check for debugging code
      if (file.content.includes('debugger') || file.content.includes('console.error')) {
        jsIssues.push(`${file.path}: contains debugging code`)
      }
    }

    if (jsIssues.length > 0) {
      findings.push({
        id: 'javascript-quality',
        summary: `Found ${jsIssues.length} JavaScript quality issues`,
        severity: 'medium',
        description: `JavaScript files contain quality concerns:\n${jsIssues.slice(0, 5).join('\n')}${jsIssues.length > 5 ? `\n... and ${jsIssues.length - 5} more.` : ''}`,
      })
    }
  }

  // Check for CSS
  if (!analysis.hasCSS) {
    findings.push({
      id: 'missing-css',
      summary: 'No CSS files found',
      severity: 'medium',
      description: 'Theme has no dedicated CSS files. Styling may be inline or missing.',
    })
  }

  // Check for performance issues in Liquid
  if (analysis.liquidFiles.length > 0) {
    const performanceIssues: string[] = []
    const structureIssues: string[] = []

    for (const file of analysis.liquidFiles) {
      // Check for unoptimized loops
      const forLoops = (file.content.match(/\{%\s*for\s+/g) || []).length
      if (forLoops > 5) {
        performanceIssues.push(`${file.path}: has ${forLoops} loops — consider pagination`)
      }

      // Check for nested loops (N+1 patterns)
      if (file.content.match(/\{%\s*for[^%]*%\}[\s\S]*\{%\s*for/)) {
        performanceIssues.push(`${file.path}: contains nested loops (potential N+1 queries)`)
      }

      // Check for accessing all products
      if (file.content.match(/all_products|\.products\s*%\}/)) {
        performanceIssues.push(`${file.path}: iterates all products — use filters or pagination`)
      }

      // Check for missing alt text in images
      const images = (file.content.match(/<img[^>]*>/g) || []).length
      const altText = (file.content.match(/alt\s*=\s*["']/g) || []).length
      if (images > altText) {
        structureIssues.push(`${file.path}: has ${images - altText} images without alt text (accessibility)`)
      }

      // Check for hardcoded text (should use translations)
      const hardcodedText = (file.content.match(/>[\w\s]{10,}<\/|["'][\w\s]{10,}["']/g) || []).length
      if (hardcodedText > 20) {
        structureIssues.push(`${file.path}: contains hardcoded text strings (consider i18n)`)
      }
    }

    const allIssues = performanceIssues.concat(structureIssues)
    if (allIssues.length > 0) {
      findings.push({
        id: 'liquid-quality',
        summary: `Found ${allIssues.length} Liquid code quality issues`,
        severity: performanceIssues.length > 0 ? 'high' : 'medium',
        description:
          allIssues.slice(0, 5).join('\n') +
          (allIssues.length > 5
            ? `\n... and ${allIssues.length - 5} more.`
            : ''),
      })
    }
  }

  return findings
}
