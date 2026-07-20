import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PackageRiskPrompt } from './risk-prompt.js'
import { defaultRc } from '@sandboxpm/config'
import type { PackageRiskFinding } from '@sandboxpm/resolver'

const { promptMock, openMock } = vi.hoisted(() => ({
  promptMock: vi.fn(),
  openMock: vi.fn(),
}))

vi.mock('inquirer', () => ({
  default: { prompt: promptMock },
}))

vi.mock('open', () => ({
  default: openMock,
}))

function makeFinding(name: string, overrides: Partial<PackageRiskFinding> = {}): PackageRiskFinding {
  return {
    name,
    version: '1.0.0',
    reasons: ['typosquat:lodash(distance=1)'],
    severity: 'low',
    ...overrides,
  }
}

beforeEach(() => {
  promptMock.mockReset()
  openMock.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PackageRiskPrompt.promptAll', () => {
  it('returns an empty array and never prompts when there are no findings', async () => {
    const prompt = new PackageRiskPrompt(defaultRc())
    const results = await prompt.promptAll([])
    expect(results).toEqual([])
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('throws immediately without prompting when onPackageRisk is "abort"', async () => {
    const rc = { ...defaultRc(), policies: { ...defaultRc().policies, onPackageRisk: 'abort' as const } }
    const prompt = new PackageRiskPrompt(rc)

    await expect(prompt.promptAll([makeFinding('lodahs')])).rejects.toThrow(/Install aborted/)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('auto-continues and records a "continue" decision when onPackageRisk is "continue"', async () => {
    const rc = { ...defaultRc(), policies: { ...defaultRc().policies, onPackageRisk: 'continue' as const } }
    const prompt = new PackageRiskPrompt(rc)
    const finding = makeFinding('lodahs')

    const results = await prompt.promptAll([finding])

    expect(results).toEqual([{ finding, decision: 'continue' }])
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('prompts and proceeds without mutating rc when the user chooses "proceed"', async () => {
    promptMock.mockResolvedValueOnce({ choice: 'proceed' })
    const rc = defaultRc()
    const prompt = new PackageRiskPrompt(rc)
    const finding = makeFinding('lodahs')

    const results = await prompt.promptAll([finding])

    expect(results).toEqual([{ finding, decision: 'proceed' }])
    expect(rc.trustedPackages).toEqual([])
    expect(rc.blockedPackages).toEqual([])
  })

  it('adds the package to trustedPackages when the user chooses "trust"', async () => {
    promptMock.mockResolvedValueOnce({ choice: 'trust' })
    const rc = defaultRc()
    const prompt = new PackageRiskPrompt(rc)

    await prompt.promptAll([makeFinding('lodahs')])

    expect(rc.trustedPackages).toContain('lodahs')
  })

  it('adds the package to blockedPackages and throws when the user chooses "block"', async () => {
    promptMock.mockResolvedValueOnce({ choice: 'block' })
    const rc = defaultRc()
    const prompt = new PackageRiskPrompt(rc)

    await expect(prompt.promptAll([makeFinding('lodahs')])).rejects.toThrow(/blocked during the risk prompt/)
    expect(rc.blockedPackages).toContain('lodahs')
  })

  it('opens the inspect URL and re-asks when the choice is "inspect"', async () => {
    promptMock
      .mockResolvedValueOnce({ choice: 'inspect' })
      .mockResolvedValueOnce({ choice: 'proceed' })
    const prompt = new PackageRiskPrompt(defaultRc())
    const finding = makeFinding('lodahs')

    const results = await prompt.promptAll([finding])

    expect(results).toEqual([{ finding, decision: 'proceed' }])
    expect(promptMock).toHaveBeenCalledTimes(2)
    expect(openMock).toHaveBeenCalledWith('https://www.npmjs.com/package/lodahs')
  })
})
