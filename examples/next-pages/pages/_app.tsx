import type { AppProps } from 'next/app'
import { DalilClient } from 'dalil/next'
import '../styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <DalilClient config={{
        project: 'next-pages',
        publicKey: process.env.NEXT_PUBLIC_DALIL_KEY ?? 'pk_test',
        endpoint: process.env.NEXT_PUBLIC_DALIL_ENDPOINT ?? 'http://localhost:4410/v1/reports',
      }} />
    </>
  )
}
