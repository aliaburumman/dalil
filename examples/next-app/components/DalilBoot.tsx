'use client'
import { useSearchParams } from 'next/navigation'
import { DalilClient, type DalilWebConfig } from 'dalil/next'

// Client module: builds the config (functions and searchParams are client-side concerns).
export function DalilBoot() {
  const ado = useSearchParams().get('ado') === '1'
  const config: DalilWebConfig = {
    project: 'next-app',
    publicKey: process.env.NEXT_PUBLIC_DALIL_KEY ?? 'pk_test',
    endpoint: process.env.NEXT_PUBLIC_DALIL_ENDPOINT ?? 'http://localhost:4410/v1/reports',
    ...(ado ? { destination: { type: 'azure-devops' as const, org: 'o', project: 'p' } } : {}),
    apiOrigins: typeof window === 'undefined' ? [] : [window.location.origin],
  }
  return <DalilClient config={config} />
}
