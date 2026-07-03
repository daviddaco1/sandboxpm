import type { Metadata } from 'next'
import { JetBrains_Mono, IBM_Plex_Sans } from 'next/font/google'

import { SiteHeader } from '@/components/site-header'
import './globals.css'

const fontHeading = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-heading',
})

const fontBody = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://sandboxpm.andresodev.com'),
  title: 'sandboxpm — the zero-trust Node.js package manager',
  description:
    'sandboxpm never runs install scripts without your consent, verifies every download by SHA-512, and sandboxes approved scripts in disposable Docker containers.',
  openGraph: {
    title: 'sandboxpm — the zero-trust Node.js package manager',
    description:
      'sandboxpm never runs install scripts without your consent, verifies every download by SHA-512, and sandboxes approved scripts in disposable Docker containers.',
    url: 'https://sandboxpm.andresodev.com',
    siteName: 'sandboxpm',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={`dark ${fontHeading.variable} ${fontBody.variable}`}>
      <body className="font-sans antialiased">
        <SiteHeader />
        {children}
      </body>
    </html>
  )
}
