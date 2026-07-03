import Link from 'next/link'
import { ShieldCheck, Lock, GitBranch, Boxes, ArrowRight } from 'lucide-react'

import { Hero } from '@/components/hero'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Consent, every time',
    description:
      'Every preinstall, install, and postinstall script requires an explicit opt-in via an interactive prompt — inspect, always-allow, or always-block.',
  },
  {
    icon: Lock,
    title: 'SHA-512 verified',
    description:
      "Tarballs are hashed while streaming and checked against the registry's published integrity before a single file is extracted.",
  },
  {
    icon: Boxes,
    title: 'Content-addressable store',
    description:
      'Every file lives once in ~/.sandboxpm/store/, keyed by its hash, and is hard-linked into every project that needs it — zero duplicated disk space.',
  },
  {
    icon: GitBranch,
    title: 'Non-flat node_modules',
    description:
      'Only direct dependencies reach the root node_modules/. Transitive dependencies stay nested, so your code can only import what you declared.',
  },
] as const

const STEPS = [
  {
    step: '01',
    title: 'Resolve',
    description: 'A BFS dependency resolver dedupes versions pnpm-style and writes a deterministic sandboxpm.lock.',
  },
  {
    step: '02',
    title: 'Fetch & verify',
    description: 'Tarballs stream in, get hashed on the fly, and are checked against dist.integrity before extraction — never after.',
  },
  {
    step: '03',
    title: 'Link',
    description: 'Store entries are hard-linked into a pnpm-style non-flat node_modules, falling back to copies when hard links aren’t possible.',
  },
  {
    step: '04',
    title: 'Sandbox',
    description: 'Scripts you approve run in an ephemeral, capability-dropped Docker container with no host credentials or network access.',
  },
] as const

export default function HomePage(): React.JSX.Element {
  return (
    <main>
      <Hero />

      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 max-w-2xl">
          <h2 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">Why sandboxpm?</h2>
          <p className="mt-3 text-muted-foreground">
            npm, pnpm, and yarn all execute install scripts silently. A malicious package can read your
            SSH keys, exfiltrate <code className="font-mono text-sm">.env</code> files, or install
            backdoors — all during a simple install. sandboxpm closes that door.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <feature.icon className="h-6 w-6 text-accent" aria-hidden="true" />
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">How it works</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((item) => (
              <li key={item.step} className="flex flex-col gap-2">
                <span className="font-mono text-sm text-accent">{item.step}</span>
                <span className="font-heading text-lg font-medium">{item.title}</span>
                <span className="text-sm text-muted-foreground">{item.description}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">
          Stop trusting install scripts blindly.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
          Zero-trust installs, a shared content-addressable store, and Docker-sandboxed scripts — for
          every project on your machine.
        </p>
        <div className="mt-8 flex flex-col items-center gap-4">
          <code className="rounded-md border border-border bg-card px-4 py-2 font-mono text-sm">
            npm install -g sandboxpm
          </code>
          <Button asChild size="lg">
            <Link href="/docs/installation">
              Read the docs
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <span>MIT Licensed &copy; sandboxpm</span>
          <a href="https://github.com/daviddaco1/sandboxpm" target="_blank" rel="noreferrer" className="hover:text-foreground">
            github.com/daviddaco1/sandboxpm
          </a>
        </div>
      </footer>
    </main>
  )
}
