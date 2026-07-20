/**
 * Typosquat similarity + low-trust "new package" heuristic.
 *
 * The low-trust signal (package age / maintainer count) is only ever evaluated
 * for a name that already matched a popular package by edit distance — running
 * it standalone would flag most legitimately-new packages on npm.
 */

import { fileURLToPath } from 'url'
import * as fs from 'fs'

export interface PackageRiskFinding {
  name: string
  version: string
  reasons: string[]
  severity: 'low' | 'high'
}

interface PopularPackagesFile {
  names: string[]
}

// Fixed ASCII homoglyph map — covers the common substitution/transposition
// tricks seen in real npm typosquats. Not a full Unicode confusables table;
// broaden this only if a real incident shows ASCII coverage is insufficient.
const HOMOGLYPHS: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '5': 's',
}

export function normalizePackageName(name: string): string {
  let n = name.toLowerCase().replace(/^@[^/]+\//, '')
  n = n.replace(/[-_.]/g, '')
  n = n.replace(/rn/g, 'm')
  n = n.replace(/[0135]/g, ch => HOMOGLYPHS[ch] ?? ch)
  return n
}

// Damerau-Levenshtein: plain Levenshtein plus adjacent-transposition awareness,
// since a swapped pair of letters ("epxress") is the single most common
// typosquat pattern and plain Levenshtein counts it as distance 2, not 1.
// Flat array + get/set helpers (rather than d[i][j]!) so every cell read stays
// a safe `?? 0` default instead of a forbidden non-null assertion.
function damerauLevenshtein(a: string, b: string): number {
  const al = a.length
  const bl = b.length
  const width = bl + 1
  const d = new Array<number>((al + 1) * width).fill(0)
  const get = (i: number, j: number): number => d[i * width + j] ?? 0
  const set = (i: number, j: number, value: number): void => { d[i * width + j] = value }

  for (let i = 0; i <= al; i++) set(i, 0, i)
  for (let j = 0; j <= bl; j++) set(0, j, j)

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(
        get(i - 1, j) + 1,       // deletion
        get(i, j - 1) + 1,       // insertion
        get(i - 1, j - 1) + cost, // substitution
      )
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
      ) {
        best = Math.min(best, get(i - 2, j - 2) + 1) // transposition
      }
      set(i, j, best)
    }
  }
  return get(al, bl)
}

interface PopularNames {
  bare: Set<string>              // lowercased, scope stripped only — "this literally IS the popular package"
  normalized: Map<string, string> // fully normalized -> original — for fuzzy matching
}

let popularNames: PopularNames | null = null

// Scope-strip + lowercase only, no hyphen/homoglyph collapsing — used to
// recognize the literal popular package so it's never flagged against itself.
function bareName(name: string): string {
  return name.toLowerCase().replace(/^@[^/]+\//, '')
}

function loadPopularNames(): PopularNames {
  if (popularNames) return popularNames
  const dataPath = fileURLToPath(new URL('../data/popular-packages.json', import.meta.url))
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as PopularPackagesFile
  const bare = new Set<string>()
  const normalized = new Map<string, string>()
  for (const name of raw.names) {
    bare.add(bareName(name))
    normalized.set(normalizePackageName(name), name)
  }
  popularNames = { bare, normalized }
  return popularNames
}

export interface TyposquatMatch {
  popularName: string
  distance: number
}

const MIN_NORMALIZED_LENGTH = 4
const MAX_FLAGGED_DISTANCE = 2
// A short popular name (e.g. "pg", "koa", "ws") is within MAX_FLAGGED_DISTANCE
// of nearly any similarly-short string by pure length arithmetic — fuzzy-matching
// against it is almost all false positives. Only exact/bare matches count for
// short names; fuzzing is restricted to popular names distinctive enough for
// edit distance to mean something.
const MIN_POPULAR_MATCH_LENGTH = 5

export function typosquatMatch(name: string): TyposquatMatch | null {
  const normalized = normalizePackageName(name)
  if (normalized.length < MIN_NORMALIZED_LENGTH) return null

  const popular = loadPopularNames()
  if (popular.bare.has(bareName(name))) return null // it IS the popular package, not a squat on it

  // Anything reaching here has a genuinely different literal name. A distance
  // of 0 in NORMALIZED space is the most dangerous case, not a false alarm:
  // it means hyphen/underscore/homoglyph tricks made an impostor name collapse
  // to an exact match with a popular package (e.g. "expres5" vs "express").
  let closest: TyposquatMatch | null = null
  for (const [popularNorm, popularName] of popular.normalized) {
    if (popularNorm.length < MIN_POPULAR_MATCH_LENGTH) continue
    // Cheap length-gap pre-filter before paying for the O(n*m) distance calc.
    if (Math.abs(popularNorm.length - normalized.length) > MAX_FLAGGED_DISTANCE) continue
    const distance = damerauLevenshtein(normalized, popularNorm)
    if (distance <= MAX_FLAGGED_DISTANCE) {
      if (!closest || distance < closest.distance) {
        closest = { popularName, distance }
      }
    }
  }
  return closest
}

const NEW_PACKAGE_MAX_AGE_DAYS = 90
const LOW_MAINTAINER_THRESHOLD = 1

export interface RiskPackument {
  versions: Record<string, unknown>
  time?: Record<string, string>
  maintainers?: { name: string }[]
}

export function checkPackageRisk(
  name: string,
  version: string,
  packument: RiskPackument,
  trustedPackages: string[],
): PackageRiskFinding | null {
  if (trustedPackages.includes(name)) return null

  const match = typosquatMatch(name)
  if (!match) return null

  const reasons: string[] = [`typosquat:${match.popularName}(distance=${match.distance})`]

  let isNew = false
  const createdRaw = packument.time?.['created']
  if (createdRaw) {
    const ageDays = (Date.now() - new Date(createdRaw).getTime()) / (1000 * 60 * 60 * 24)
    if (ageDays < NEW_PACKAGE_MAX_AGE_DAYS) {
      isNew = true
      reasons.push(`new-package(${Math.max(0, Math.round(ageDays))} days old)`)
    }
  } else if (Object.keys(packument.versions).length <= 2) {
    isNew = true
    reasons.push('new-package(few published versions)')
  }

  let lowMaintainers = false
  const maintainerCount = packument.maintainers?.length ?? 0
  if (maintainerCount <= LOW_MAINTAINER_THRESHOLD) {
    lowMaintainers = true
    reasons.push(`low-maintainer-count(${maintainerCount})`)
  }

  return {
    name,
    version,
    reasons,
    severity: isNew || lowMaintainers ? 'high' : 'low',
  }
}
