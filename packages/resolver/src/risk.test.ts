import { describe, it, expect } from 'vitest'
import { normalizePackageName, typosquatMatch, checkPackageRisk, type RiskPackument } from './risk.js'

describe('normalizePackageName', () => {
  it('lowercases and strips scope', () => {
    expect(normalizePackageName('@types/Lodash')).toBe('lodash')
  })

  it('strips hyphens, underscores, and dots', () => {
    expect(normalizePackageName('lo-dash_pkg.core')).toBe('lodashpkgcore')
  })

  it('applies the fixed homoglyph map', () => {
    expect(normalizePackageName('expres5')).toBe('express')
    expect(normalizePackageName('l0dash')).toBe('lodash')
  })
})

describe('typosquatMatch', () => {
  it('returns null for the real popular package itself', () => {
    expect(typosquatMatch('lodash')).toBeNull()
    expect(typosquatMatch('@types/lodash')).toBeNull()
  })

  it('flags a single-character-edit-distance impostor', () => {
    const match = typosquatMatch('lodahs')
    expect(match?.popularName).toBe('lodash')
    expect(match?.distance).toBeLessThanOrEqual(2)
  })

  it('flags an adjacent-letter transposition as a low distance', () => {
    const match = typosquatMatch('epxress')
    expect(match?.popularName).toBe('express')
    expect(match?.distance).toBe(1)
  })

  it('flags a homoglyph impostor that collapses to an exact normalized match', () => {
    const match = typosquatMatch('expres5')
    expect(match?.popularName).toBe('express')
    expect(match?.distance).toBe(0)
  })

  it('does not flag unrelated short names', () => {
    expect(typosquatMatch('abc')).toBeNull()
  })

  it('does not flag a name that is not close to anything popular', () => {
    expect(typosquatMatch('my-totally-unrelated-internal-package')).toBeNull()
  })
})

describe('checkPackageRisk', () => {
  const basePackument: RiskPackument = {
    versions: { '1.0.0': {}, '1.0.1': {}, '1.0.2': {}, '1.0.3': {} },
    time: { created: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString() }, // 1 year old
    maintainers: [{ name: 'alice' }, { name: 'bob' }],
  }

  it('returns null when the name is not a typosquat match', () => {
    expect(checkPackageRisk('some-unrelated-pkg', '1.0.0', basePackument, [])).toBeNull()
  })

  it('returns null when the name is explicitly trusted', () => {
    expect(checkPackageRisk('lodahs', '1.0.0', basePackument, ['lodahs'])).toBeNull()
  })

  it('flags low severity for an established typosquat-adjacent name', () => {
    const finding = checkPackageRisk('lodahs', '1.0.0', basePackument, [])
    expect(finding?.severity).toBe('low')
    expect(finding?.reasons[0]).toContain('typosquat:lodash')
  })

  it('escalates to high severity for a newly-created package', () => {
    const newPackument: RiskPackument = {
      versions: { '1.0.0': {} },
      time: { created: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString() }, // 5 days old
      maintainers: [{ name: 'alice' }, { name: 'bob' }],
    }
    const finding = checkPackageRisk('lodahs', '1.0.0', newPackument, [])
    expect(finding?.severity).toBe('high')
    expect(finding?.reasons.some(r => r.includes('new-package'))).toBe(true)
  })

  it('escalates to high severity for a single-maintainer package', () => {
    const packument: RiskPackument = { ...basePackument, maintainers: [{ name: 'solo' }] }
    const finding = checkPackageRisk('lodahs', '1.0.0', packument, [])
    expect(finding?.severity).toBe('high')
    expect(finding?.reasons.some(r => r.includes('low-maintainer-count'))).toBe(true)
  })

  it('falls back to version count when the packument has no time field', () => {
    const packument: RiskPackument = {
      versions: { '1.0.0': {} },
      maintainers: [{ name: 'alice' }, { name: 'bob' }],
    }
    const finding = checkPackageRisk('lodahs', '1.0.0', packument, [])
    expect(finding?.severity).toBe('high')
    expect(finding?.reasons.some(r => r.includes('new-package'))).toBe(true)
  })
})
