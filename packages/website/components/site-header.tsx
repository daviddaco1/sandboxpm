import Link from 'next/link'
import { ShieldCheck, Github } from 'lucide-react'

import { Button } from '@/components/ui/button'

const NAV_LINKS = [
  { href: '/docs/installation', label: 'Docs' },
  { href: '/docs/cli', label: 'CLI' },
  { href: '/docs/security', label: 'Security' },
]

export function SiteHeader(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2 font-heading text-sm font-semibold tracking-tight">
          <ShieldCheck className="h-5 w-5 text-accent" aria-hidden="true" />
          sandboxpm
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <a
              href="https://github.com/daviddaco1/sandboxpm"
              target="_blank"
              rel="noreferrer"
              aria-label="View sandboxpm on GitHub"
            >
              <Github className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </Button>
          <Button asChild size="sm">
            <Link href="/docs/installation">Get Started</Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
