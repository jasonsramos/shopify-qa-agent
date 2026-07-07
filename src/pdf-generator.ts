import fs from 'fs/promises'
import path from 'path'
import { chromium } from 'playwright'
import { marked } from 'marked'
import { logger } from './utils.js'

/**
 * Convert a Markdown file to a styled PDF using Playwright.
 * Returns the path to the generated PDF.
 */
export async function markdownToPdf(mdPath: string): Promise<string> {
  const mdContent = await fs.readFile(mdPath, 'utf-8')
  const pdfPath = mdPath.replace(/\.md$/, '.pdf')

  logger.info(`Generating PDF: ${path.basename(pdfPath)}`)

  // Escape any raw HTML in the source so stray/truncated tags (e.g. axe element
  // snippets like `<button …>`) render as literal text instead of being parsed
  // as live HTML that mangles the layout. Backtick/inline-code spans are left to
  // marked, which escapes their contents anyway.
  const safeMd = escapeRawHtmlOutsideCode(mdContent)

  // Convert Markdown → HTML
  const htmlBody = await marked(safeMd, { gfm: true, breaks: true })

  // Wrap in a styled HTML document
  const html = buildHtmlDocument(htmlBody)

  // Use Playwright to render and print to PDF
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle' })
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    })
  } finally {
    await browser.close()
  }

  logger.success(`PDF saved: ${pdfPath}`)
  return pdfPath
}

/**
 * Escape `<` and `>` that are NOT inside a code span/fence so raw or truncated
 * HTML tags in the markdown can't be parsed as live HTML in the PDF. Fenced
 * (```) and inline (`…`) code segments are preserved verbatim — marked escapes
 * their contents itself.
 */
function escapeRawHtmlOutsideCode(md: string): string {
  // Split on fenced code blocks and inline code, keeping the delimiters.
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts
    .map((part, i) => {
      // Odd indices are the captured code segments — leave untouched.
      if (i % 2 === 1) return part
      return part.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
    .join('')
}

function buildHtmlDocument(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 11px;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 100%;
    padding: 0;
    /* Long selectors, URLs, and HTML snippets must wrap, never overflow the page. */
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  h1 {
    font-size: 22px;
    border-bottom: 2px solid #2c3e50;
    padding-bottom: 8px;
    margin-top: 28px;
    color: #1a1a1a;
  }

  h2 {
    font-size: 17px;
    border-bottom: 1px solid #bdc3c7;
    padding-bottom: 5px;
    margin-top: 24px;
    color: #2c3e50;
  }

  h3 {
    font-size: 14px;
    margin-top: 18px;
    color: #34495e;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 10.5px;
  }

  th, td {
    border: 1px solid #ddd;
    padding: 6px 10px;
    text-align: left;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  table { table-layout: fixed; }

  th {
    background: #f0f3f5;
    font-weight: 600;
    color: #2c3e50;
  }

  tr:nth-child(even) { background: #f9fafb; }

  code {
    background: #f0f3f5;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace;
    font-size: 10px;
    color: #c0392b;
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  pre {
    background: #f0f3f5;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  pre code {
    background: none;
    padding: 0;
    color: inherit;
  }

  ul, ol { padding-left: 20px; }
  li { margin: 3px 0; }

  blockquote {
    border-left: 3px solid #3498db;
    margin: 12px 0;
    padding: 6px 15px;
    background: #f0f7ff;
    color: #2c3e50;
  }

  strong { color: #1a1a1a; }

  a { color: #2980b9; text-decoration: none; }

  hr {
    border: none;
    border-top: 1px solid #ddd;
    margin: 20px 0;
  }

  p, li {
    break-inside: auto;
    orphans: 2;
    widows: 2;
  }

  h1, h2, h3 {
    break-after: auto;
    page-break-after: avoid;
  }

  table {
    page-break-inside: avoid;
    break-inside: avoid;
  }
</style>
</head>
<body>
${body}
</body>
</html>`
}
