/**
 * Parses `strace -f -tt -s 0 -e trace=network,file` output into a SandboxReport.
 * Pure text parsing — no Docker/child_process access, so it's cheap to unit-test.
 */
import type { SandboxReport } from './index.js'

const BLOCKED_ERRNOS = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EPERM', 'ETIMEDOUT'])

const CONNECT_RE = /^(?:\[pid\s+\d+\]\s+)?(?:[\d:.]+\s+)?(?:connect|sendto)\(.*?sin_addr=inet_addr\("([^"]+)"\).*?\)\s*=\s*(-?\d+)(?:\s+(\w+))?/
const PORT_RE = /sin_port=htons\((\d+)\)/
const WRITE_OPEN_RE = /^(?:\[pid\s+\d+\]\s+)?(?:[\d:.]+\s+)?(?:open|openat)\(.*?"([^"]+)".*?(O_WRONLY|O_RDWR|O_CREAT)/
const UNLINK_RENAME_RE = /^(?:\[pid\s+\d+\]\s+)?(?:[\d:.]+\s+)?(?:unlink|unlinkat|rename|renameat)\(.*?"([^"]+)"/
const EPERM_RE = /^(?:\[pid\s+\d+\]\s+)?(?:[\d:.]+\s+)?(\w+)\(.*?\)\s*=\s*-1\s+EPERM/

export function parseStraceLog(
  log: string,
  opts: { packageDir: string; expectedWriteRoots?: string[] },
): SandboxReport {
  const expectedRoots = opts.expectedWriteRoots ?? [opts.packageDir, '/tmp', '/home/sandbox']

  const networkConnections: string[] = []
  const blockedConnections: string[] = []
  const filesWritten: string[] = []
  const unexpectedActivity: string[] = []

  for (const line of log.split('\n')) {
    if (line.trim() === '') continue

    const connectMatch = CONNECT_RE.exec(line)
    if (connectMatch) {
      const ip = connectMatch[1]
      const port = PORT_RE.exec(line)?.[1] ?? '?'
      const errno = connectMatch[3]
      const target = `${ip}:${port}`
      if (errno !== undefined && BLOCKED_ERRNOS.has(errno)) {
        blockedConnections.push(target)
      } else {
        networkConnections.push(target)
      }
      continue
    }

    const writeMatch = WRITE_OPEN_RE.exec(line)
    if (writeMatch) {
      const filePath = writeMatch[1]
      if (filePath !== undefined) {
        filesWritten.push(filePath)
        if (!expectedRoots.some(root => filePath.startsWith(root))) {
          unexpectedActivity.push(`unexpected write outside sandbox roots: ${filePath}`)
        }
      }
      continue
    }

    const unlinkMatch = UNLINK_RENAME_RE.exec(line)
    if (unlinkMatch) {
      const filePath = unlinkMatch[1]
      if (filePath !== undefined) filesWritten.push(filePath)
      continue
    }

    const epermMatch = EPERM_RE.exec(line)
    if (epermMatch && epermMatch[1] !== 'connect' && epermMatch[1] !== 'sendto') {
      unexpectedActivity.push(`blocked syscall attempt: ${epermMatch[1]}`)
    }
  }

  const status: SandboxReport['status'] =
    blockedConnections.length > 0 || unexpectedActivity.length > 0 ? 'warned' : 'clean'

  return {
    networkConnections,
    blockedConnections,
    filesWritten,
    unexpectedActivity,
    status,
    audited: true,
  }
}
