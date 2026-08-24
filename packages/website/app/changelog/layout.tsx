export default function ChangelogLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <article className="prose prose-invert max-w-none prose-headings:font-heading prose-a:text-accent prose-code:font-mono prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-card">
        {children}
      </article>
    </div>
  )
}
