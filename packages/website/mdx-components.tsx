import type { MDXComponents } from 'mdx/types'

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    code: ({ children, className, ...props }) => {
      // Fenced code blocks get a `language-*` class from the MDX pipeline;
      // leave those to the surrounding <pre> styling and only badge inline code.
      if (className) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }
      return (
        <code
          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
          {...props}
        >
          {children}
        </code>
      )
    },
    table: ({ children, ...props }) => (
      <div className="not-prose my-6 overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }) => (
      <thead className="bg-muted" {...props}>
        {children}
      </thead>
    ),
    th: ({ children, ...props }) => (
      <th
        className="whitespace-nowrap border-b border-border px-4 py-3 text-left font-heading text-xs font-medium uppercase tracking-wide text-muted-foreground"
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td
        className="border-b border-border/60 px-4 py-3 align-top text-foreground first:whitespace-nowrap last:w-full"
        {...props}
      >
        {children}
      </td>
    ),
    tr: ({ children, ...props }) => (
      <tr className="last:[&>td]:border-b-0 even:bg-card/40" {...props}>
        {children}
      </tr>
    ),
    ...components,
  }
}
