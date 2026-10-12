// Runs wrangler against the work-account config: node scripts/work.mjs <deploy|migrate|secret|tail> [args...]
// Config path: $DALIL_WORK_CONFIG, else ../../dalil-work/wrangler.work.jsonc (relative to worker/).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = resolve(root, process.env.DALIL_WORK_CONFIG || '../../dalil-work/wrangler.work.jsonc')
const [cmd, ...rest] = process.argv.slice(2)

const COMMANDS = {
  deploy: ['deploy'],
  migrate: ['d1', 'migrations', 'apply', 'DB', '--remote'], // binding name: same in every config
  secret: ['secret', 'put'],
  tail: ['tail'],
}
if (!cmd || !COMMANDS[cmd]) {
  console.error(`usage: work.mjs <${Object.keys(COMMANDS).join('|')}> [wrangler args]`)
  process.exit(2)
}
if (!existsSync(config)) {
  console.error(`work config not found: ${config}\nCopy wrangler.work.example.jsonc to your private work repo as wrangler.work.jsonc, or set DALIL_WORK_CONFIG.`)
  process.exit(2)
}
// wrangler resolves main/assets/migrations relative to the config file, so run from worker/ with an absolute -c.
const bin = resolve(root, 'node_modules/.bin/wrangler')
const res = spawnSync(bin, [...COMMANDS[cmd], '-c', config, ...rest], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(res.status ?? 1)
