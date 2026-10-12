// Fake app + settings box for the Azure DevOps (no server) mode. The widget comes from ./dalil.global.js.
const KEY = 'dalil-ado-test'
const $ = (id) => document.getElementById(id)
const status = $('status')
let booted = false

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}

function boot(s) {
  const destination = { type: 'azure-devops', org: s.org, project: s.project, workItemType: s.workItemType || 'Bug' }
  if (s.areaPath) destination.areaPath = s.areaPath
  const config = {
    project: 'ado-test',
    destination,
    apiOrigins: [location.origin],
    enabled: true,
    theme: 'system',
  }
  if (booted) Dalil.update(config)
  else {
    Dalil.init(config)
    booted = true
  }
  status.textContent = `Ready: ${s.org} / ${s.project} (${destination.workItemType}). Press Ctrl/Cmd+Shift+B to report.`
}

const saved = load()
if (saved) {
  $('org').value = saved.org || ''
  $('project').value = saved.project || ''
  $('wit').value = saved.workItemType || 'Bug'
  $('area').value = saved.areaPath || ''
  if (saved.org && saved.project) boot(saved)
}

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const s = {
    org: $('org').value.trim(),
    project: $('project').value.trim(),
    workItemType: $('wit').value.trim() || 'Bug',
    areaPath: $('area').value.trim(),
  }
  if (!s.org || !s.project) return
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {}
  boot(s)
})

const out = $('out')
const guests = []
$('step').addEventListener('click', () => {
  const name = $('guest').value.trim() || 'Guest'
  guests.push(name)
  out.textContent = `Guests: ${guests.join(', ')}`
})
// A same-origin path that does not exist: the host answers 404, which Dalil records as a failed request.
$('book').addEventListener('click', () => {
  fetch('./api/bookings/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guests }) })
    .then((r) => (out.textContent = `Save booking -> HTTP ${r.status}`))
    .catch((err) => (out.textContent = `Save booking failed: ${err.message}`))
})
$('toast').addEventListener('click', () => {
  document.querySelectorAll('.toast-error').forEach((n) => n.remove())
  const t = document.createElement('div')
  t.className = 'toast-error'
  t.setAttribute('role', 'alert')
  t.textContent = 'Could not save the booking. Please try again.'
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 8000)
})
