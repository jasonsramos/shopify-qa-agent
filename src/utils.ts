import chalk from 'chalk'
import pino from 'pino'
import * as fs from 'fs/promises'
import path from 'path'
import { Logger } from './types.js'

// ════════════════════════════════════════════════════════════════════════
// Logging
// ════════════════════════════════════════════════════════════════════════

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
})

export const logger: Logger = {
  info: (msg, data) => pinoLogger.info(data ? { ...data } : {}, msg),
  success: (msg, data) => console.log(chalk.green('✓ ' + msg), data ? JSON.stringify(data) : ''),
  warn: (msg, data) => console.log(chalk.yellow('⚠ ' + msg), data ? JSON.stringify(data) : ''),
  error: (msg, data) => console.log(chalk.red('✗ ' + msg), data ? JSON.stringify(data) : ''),
  debug: (msg, data) => console.log(chalk.dim('  ' + msg), data ? JSON.stringify(data) : ''),
  dim: (msg, data) => console.log(chalk.dim(msg), data ? JSON.stringify(data) : ''),
}

// ════════════════════════════════════════════════════════════════════════
// URL Helpers
// ════════════════════════════════════════════════════════════════════════

export function baseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return url
  }
}


// ════════════════════════════════════════════════════════════════════════
// File I/O
// ════════════════════════════════════════════════════════════════════════

export async function writeJson(filepath: string, data: any): Promise<void> {
  const dir = path.dirname(filepath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8')
}

export async function readJson<T>(filepath: string): Promise<T> {
  const content = await fs.readFile(filepath, 'utf-8')
  return JSON.parse(content) as T
}

export async function writeFile(filepath: string, content: string): Promise<void> {
  const dir = path.dirname(filepath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filepath, content, 'utf-8')
}

// ════════════════════════════════════════════════════════════════════════
// Fetching with Timeout
// ════════════════════════════════════════════════════════════════════════

export async function secureFetch(
  url: string,
  opts: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout: ms = 15000, ...rest } = opts
  return fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(ms),
    headers: {
      'User-Agent': 'shopify-qa-agent/1.0',
      ...(rest.headers as Record<string, string>),
    },
  })
}

// ════════════════════════════════════════════════════════════════════════
// Time Helpers
// ════════════════════════════════════════════════════════════════════════

export function timestamp(): string {
  return new Date().toISOString()
}

export function timestampHuman(): string {
  return new Date().toLocaleString()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

// ════════════════════════════════════════════════════════════════════════
// Severity Helpers
// ════════════════════════════════════════════════════════════════════════

export function severityLevel(severity: string): number {
  const levels: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    info: 0,
  }
  return levels[severity.toLowerCase()] || 0
}

export function sortBySeverity(findings: any[]): any[] {
  return findings.sort((a, b) => severityLevel(b.severity) - severityLevel(a.severity))
}
