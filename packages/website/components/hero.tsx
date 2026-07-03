import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'

const TERMINAL_LINES = [
  { text: '$ sandboxpm install', kind: 'command' },
  { text: '✓ Resolving dependencies... (47 packages)', kind: 'ok' },
  { text: '✓ Downloading tarballs... (12 new, 35 from store)', kind: 'ok' },
  { text: '✓ Verifying SHA-512... OK', kind: 'ok' },
  { text: '✓ Linking node_modules...', kind: 'ok' },
  { text: '', kind: 'blank' },
  { text: '⚠ 3 packages have install scripts', kind: 'warn' },
  { text: '', kind: 'blank' },
  { text: '  1. esbuild@0.19.4', kind: 'muted' },
  { text: '     Type:    postinstall', kind: 'muted' },
  { text: '     Script:  node install.js', kind: 'muted' },
  { text: '', kind: 'blank' },
  { text: '     Run this script? [y/N/inspect/always/never]', kind: 'prompt' },
] as const

export function Hero(): React.JSX.Element {
  return (
    <section className="border-b border-border">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 md:grid-cols-2 md:items-center md:py-28">
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center rounded-full border border-border bg-muted px-3 py-1 font-mono text-xs text-muted-foreground">
            zero-trust package management
          </span>
          <h1 className="font-heading text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Install packages.
            <br />
            Not backdoors.
          </h1>
          <p className="max-w-md text-lg text-muted-foreground">
            sandboxpm never runs a preinstall, install, or postinstall script without your explicit
            consent. Every download is SHA-512 verified, and every approved script runs in a
            disposable Docker sandbox — never on your machine.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Button asChild size="lg">
              <Link href="/docs/installation">
                Get Started
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/docs/architecture">How it works</Link>
            </Button>
          </div>
        </div>

        <div
          className="overflow-x-auto rounded-lg border border-border bg-card p-5 font-mono text-xs leading-relaxed shadow-lg sm:text-sm"
          role="img"
          aria-label="Terminal transcript of sandboxpm install prompting before running esbuild's postinstall script"
        >
          {TERMINAL_LINES.map((line, i) => (
            <div
              key={i}
              className={
                line.kind === 'ok'
                  ? 'text-accent'
                  : line.kind === 'warn'
                    ? 'text-yellow-400'
                    : line.kind === 'prompt'
                      ? 'font-semibold text-foreground'
                      : line.kind === 'muted'
                        ? 'text-muted-foreground'
                        : line.kind === 'blank'
                          ? 'h-4'
                          : 'text-foreground'
              }
            >
              {line.text || ' '}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
