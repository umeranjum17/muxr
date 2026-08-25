/**
 * Console logging bootstrap for React Native
 *
 * Control flow:
 *
 * console.log("msg", obj)
 * │
 * ├─ consoleOutputEnabled = false? (default for prod)
 * │  └─ return immediately ⛔  (zero cost, args untouched)
 * │
 * ├─ consoleOutputEnabled = true? (default for dev/preview, or toggled on)
 * │  ├─ call original console method ✅
 * │  ├─ capture to in-app buffer ✅
 * │
 * └─ console.error / console.warn (always, regardless of flag)
 *    ├─ call original console method ✅
 *    ├─ capture to in-app buffer ✅
 */

import { log } from '@/log';
import { MAX_APP_LOG_ENTRIES } from '@/log';
import { loadLocalSettings } from '@/sync/persistence';
import { loadAppConfig } from '@/sync/appConfig';
import { serializeForLogs } from '@/utils/truncateForLogs';

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
type ConsoleLogEntry = { timestamp: string; level: ConsoleLevel; message: string };

let logBuffer: ConsoleLogEntry[] = []
const MAX_BUFFER_SIZE = MAX_APP_LOG_ENTRIES
let isConsolePatched = false
let consoleOutputEnabled = false
let originalConsole: {
  log: typeof console.log,
  info: typeof console.info,
  warn: typeof console.warn,
  error: typeof console.error,
  debug: typeof console.debug,
} | null = null

/**
 * Toggle console output at runtime (e.g. from Dev screen toggle).
 */
export function setConsoleOutputEnabled(enabled: boolean) {
  consoleOutputEnabled = enabled
}

export function initConsoleLogging() {
  if (isConsolePatched) {
    return
  }


  // Determine initial state: user setting > build variant default > off
  try {
    const settings = loadLocalSettings();
    const config = loadAppConfig();
    consoleOutputEnabled = settings.consoleLoggingEnabled || config.consoleLoggingDefault || false;
  } catch {
    consoleOutputEnabled = false;
  }

  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  log.setConsoleCaptureEnabled(true)

  function formatArgs(args: unknown[]): string {
    return args.map(a => {
      if (a === null || a === undefined) return String(a)
      if (typeof a !== 'object') return serializeForLogs(a)
      try { return serializeForLogs(a) } catch { return String(a) }
    }).join(' ')
  }


  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    const alwaysPassThrough = level === 'error' || level === 'warn'

    console[level] = (...args: unknown[]) => {
      // Full short-circuit: when off, skip everything for log/info/debug
      if (!consoleOutputEnabled && !alwaysPassThrough) {
        return
      }

      // Pass raw args to native console (preserves interactive object inspection,
      // clickable stack traces, and multi-arg formatting in dev tools)
      originalConsole![level](...args)

      // Serialize once for buffer + remote (but NOT for native console)
      const formatted = formatArgs(args)
      log.captureFormatted(level, formatted)

      logBuffer.push({
        timestamp: new Date().toISOString(),
        level,
        message: formatted
      })
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }

    }
  })

  isConsolePatched = true

  originalConsole.log('[ConsoleLogging] Initialized', consoleOutputEnabled ? '(output enabled)' : '(output suppressed)')
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
