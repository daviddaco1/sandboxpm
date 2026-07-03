export interface DocsNavItem {
  href: string
  title: string
}

export const DOCS_NAV: DocsNavItem[] = [
  { href: '/docs/installation', title: 'Installation' },
  { href: '/docs/cli', title: 'CLI reference' },
  { href: '/docs/configuration', title: 'Configuration' },
  { href: '/docs/architecture', title: 'Architecture' },
  { href: '/docs/security', title: 'Security model' },
]
