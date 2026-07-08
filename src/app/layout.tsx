import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'faff harness',
  description: 'Agentic harness over SSE — nothing is charged until you confirm',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
