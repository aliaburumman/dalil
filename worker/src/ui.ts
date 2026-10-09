// Shared look of the triage pages (list + report): design tokens, base CSS, top bar, small helpers.
// Every dynamic value that reaches HTML goes through esc().
import type { ProjectRow } from './env'
import { esc } from './util'

export const KIND_COLOR: Record<string, string> = {
  backend: '#dc2626',
  frontend: '#d97706',
  validation: '#7c3aed',
  network: '#64748b',
  permission: '#2563eb',
  ux: '#0d9488',
}

export const SEV_LABEL: Record<string, string> = { blocker: 'Blocker', annoying: 'Annoying', minor: 'Minor' }

export function statusLabel(s: string): string {
  return s === 'wontfix' ? "Won't fix" : s.charAt(0).toUpperCase() + s.slice(1)
}

export const BASE_CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--surface2:#f1f3f6;--fg:#0f172a;--muted:#64748b;--line:#e2e5ea;--accent:#4f46e5;--accent-soft:#eef0ff;--accent-fg:#fff;--blocker:#dc2626;--annoying:#d97706;--minor:#94a3b8;--bad-soft:#fef2f2;--shadow:0 1px 2px rgba(15,23,42,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e14;--surface:#12161f;--surface2:#1a1f2b;--fg:#e6e9f0;--muted:#8b95a7;--line:#252b38;--accent:#818cf8;--accent-soft:#1e2140;--accent-fg:#0b0e14;--blocker:#f87171;--annoying:#fbbf24;--minor:#64748b;--bad-soft:#2a1416;--shadow:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
svg.i{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-2px}
.topbar{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line)}
.topbar .in{max-width:1100px;margin:0 auto;padding:0 16px;height:48px;display:flex;align-items:center;gap:16px}
.brand{font-weight:800;font-size:15px;letter-spacing:-.01em;color:var(--fg);text-decoration:none}
.brand span{color:var(--accent)}
.switch{display:flex;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}
.switch::-webkit-scrollbar{display:none}
.switch a{padding:4px 10px;border-radius:6px;font-size:13px;color:var(--muted);text-decoration:none;white-space:nowrap}
.switch a:hover{background:var(--surface2);color:var(--fg)}
.switch a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.who{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:40vw}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;line-height:20px;border:1px solid var(--line);background:var(--surface2);color:var(--muted);white-space:nowrap}
.pill.new{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.pill.seen{background:#fef3c7;color:#92400e;border-color:transparent}
.pill.fixed{background:#dcfce7;color:#166534;border-color:transparent}
.pill.wontfix{background:var(--surface2);color:var(--muted)}
@media (prefers-color-scheme:dark){.pill.seen{background:#3a2a0c;color:#fcd34d}.pill.fixed{background:#0f2e1a;color:#86efac}}
.kind{display:inline-block;padding:0 7px;border-radius:5px;font-size:11.5px;font-weight:700;line-height:20px;background:color-mix(in srgb,var(--kc,#64748b) 14%,transparent);color:var(--kc,#64748b);white-space:nowrap}
.sev{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--muted)}
.sev::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--minor)}
.sev.blocker::before{background:var(--blocker)}.sev.annoying::before{background:var(--annoying)}
.btn{font:inherit;font-size:12.5px;font-weight:600;padding:4px 11px;border-radius:7px;border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer;line-height:1.4}
.btn:hover{background:var(--surface2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover{filter:brightness(1.08)}
.btn:focus-visible,a:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)}
`

/** Top bar: wordmark, project switcher, signed-in email. `activeProject` null = "All". */
export function topbar(projects: ProjectRow[], activeProject: string | null, email: string | null): string {
  const links = [`<a href="/"${activeProject === null ? ' class="on"' : ''}>All</a>`]
  for (const p of projects) {
    links.push(`<a href="/p/${esc(encodeURIComponent(p.id))}"${p.id === activeProject ? ' class="on"' : ''}>${esc(p.name)}</a>`)
  }
  const who = email ? `<span class="who" title="Signed in as ${esc(email)}">${esc(email)}</span>` : ''
  return `<header class="topbar"><div class="in"><a class="brand" href="/">Dalil<span>.</span></a><nav class="switch" aria-label="Projects">${links.join('')}</nav>${who}</div></header>`
}

const ICONS: Record<string, string> = {
  rec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  nav: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  click: '<path d="M9 3v3M4 8h3M5.5 4.5 7.6 6.6M12 12l8 3-3.5 1.5L15 20z"/>',
  input: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h5"/>',
  submit: '<path d="M4 12l16-8-6 16-2-7z"/>',
  req: '<path d="M7 17V7m0 0L3 11m4-4 4 4M17 7v10m0 0 4-4m-4 4-4-4"/>',
  err: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  log: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
}

export function icon(name: string): string {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
}

export function relAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 60 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`
}

const HEAD_SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
}

export function htmlHeaders(csp: string): HeadersInit {
  return { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, ...HEAD_SECURITY }
}

/** A safe same-site path for a post-action redirect; anything else falls back. */
export function safeNext(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length > 300) return fallback
  if (!/^\/(?!\/)[^\\\r\n]*$/.test(raw)) return fallback
  return raw
}
