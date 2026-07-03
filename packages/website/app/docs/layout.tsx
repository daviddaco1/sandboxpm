'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { DOCS_NAV } from '@/lib/docs-nav'
import { cn } from '@/lib/utils'

export default function DocsLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname()

  return (
    <div className="mx-auto flex max-w-6xl gap-10 px-6 py-12">
      <aside className="hidden w-56 shrink-0 md:block">
        <nav aria-label="Docs" className="sticky top-24 flex flex-col gap-1">
          {DOCS_NAV.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {item.title}
              </Link>
            )
          })}
        </nav>
      </aside>
      <article className="min-w-0 flex-1 pb-20">
        <div className="prose prose-invert max-w-none prose-headings:font-heading prose-a:text-accent prose-code:font-mono prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-card">
          {children}
        </div>
      </article>
    </div>
  )
}
