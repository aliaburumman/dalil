import { Suspense, type ReactNode } from 'react'
import { DalilBoot } from '../components/DalilBoot'
import './globals.css'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Suspense fallback={null}>
          <DalilBoot />
        </Suspense>
      </body>
    </html>
  )
}
