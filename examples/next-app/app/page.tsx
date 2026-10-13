import Link from 'next/link'
import { SaveButton } from '../components/SaveButton'

// Server component: no 'use client'.
export default function Home() {
  return (
    <main>
      <h1>Next App Router</h1>
      <Link href="/second" id="to-second">Go to second</Link>
      <SaveButton />
    </main>
  )
}
