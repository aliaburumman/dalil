// Assembles site/ado-test/: the Azure DevOps test page + the built widget (run `npm run build` first).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(repo, 'site', 'ado-test')
const dist = path.join(repo, 'dist')
for (const f of ['dalil.global.js', 'assets']) {
  if (!fs.existsSync(path.join(dist, f))) {
    console.error(`dist/${f} not found. Run \`npm run build\` first.`)
    process.exit(1)
  }
}
fs.rmSync(path.join(repo, 'site'), { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.cpSync(path.join(repo, 'examples', 'ado-direct'), out, { recursive: true })
fs.copyFileSync(path.join(dist, 'dalil.global.js'), path.join(out, 'dalil.global.js'))
fs.cpSync(path.join(dist, 'assets'), path.join(out, 'assets'), { recursive: true })
console.log(`site assembled at ${path.relative(repo, out)}`)
