import { describe, it, expect } from 'vitest'
import { parseStraceLog } from './trace-parser.js'

const PACKAGE_DIR = '/sandbox/package'

describe('parseStraceLog', () => {
  it('reports clean status for a benign run with only in-package writes', () => {
    const log = [
      '12:00:00.000000 openat(AT_FDCWD, "/sandbox/package/dist/out.js", O_WRONLY|O_CREAT, 0666) = 3',
      '12:00:00.000100 close(3)                = 0',
    ].join('\n')

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.status).toBe('clean')
    expect(report.audited).toBe(true)
    expect(report.filesWritten).toEqual(['/sandbox/package/dist/out.js'])
    expect(report.networkConnections).toEqual([])
    expect(report.blockedConnections).toEqual([])
    expect(report.unexpectedActivity).toEqual([])
  })

  it('records a successful outbound connection', () => {
    const log = '12:00:00.000000 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.2.3.4")}, 16) = 0\n'

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.networkConnections).toEqual(['1.2.3.4:443'])
    expect(report.blockedConnections).toEqual([])
    expect(report.status).toBe('clean')
  })

  it('flags a blocked connection attempt (network isolation) as warned', () => {
    const log = '12:00:00.000000 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("5.6.7.8")}, 16) = -1 ECONNREFUSED (Connection refused)\n'

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.blockedConnections).toEqual(['5.6.7.8:443'])
    expect(report.networkConnections).toEqual([])
    expect(report.status).toBe('warned')
  })

  it('flags a write outside the expected sandbox roots as unexpected and warned', () => {
    const log = '12:00:00.000000 openat(AT_FDCWD, "/etc/passwd", O_WRONLY, 0666) = 3\n'

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.filesWritten).toEqual(['/etc/passwd'])
    expect(report.unexpectedActivity).toEqual(['unexpected write outside sandbox roots: /etc/passwd'])
    expect(report.status).toBe('warned')
  })

  it('flags a blocked (seccomp-denied) syscall attempt as unexpected activity', () => {
    const log = '12:00:00.000000 ptrace(PTRACE_ATTACH, 123, NULL, NULL) = -1 EPERM (Operation not permitted)\n'

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.unexpectedActivity).toEqual(['blocked syscall attempt: ptrace'])
    expect(report.status).toBe('warned')
  })

  it('records file deletes and renames', () => {
    const log = [
      '12:00:00.000000 unlink("/sandbox/package/tmp.txt") = 0',
      '12:00:00.000100 rename("/sandbox/package/a.js", "/sandbox/package/b.js") = 0',
    ].join('\n')

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.filesWritten).toEqual(['/sandbox/package/tmp.txt', '/sandbox/package/a.js'])
    expect(report.status).toBe('clean')
  })

  it('falls back to "?" for the port when the connect line has no sin_port field', () => {
    const log = '12:00:00.000000 connect(3, {sa_family=AF_INET, sin_addr=inet_addr("1.2.3.4")}, 16) = 0\n'

    const report = parseStraceLog(log, { packageDir: PACKAGE_DIR })

    expect(report.networkConnections).toEqual(['1.2.3.4:?'])
  })

  it('returns an empty clean report for an empty trace', () => {
    const report = parseStraceLog('', { packageDir: PACKAGE_DIR })

    expect(report).toEqual({
      networkConnections: [],
      blockedConnections: [],
      filesWritten: [],
      unexpectedActivity: [],
      status: 'clean',
      audited: true,
    })
  })
})
