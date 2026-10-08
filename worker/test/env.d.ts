// Types for `env` from cloudflare:test: the worker's Env plus the test-only migrations binding.
import type { D1Migration } from 'cloudflare:test'
import type { Env as WorkerEnv } from '../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
