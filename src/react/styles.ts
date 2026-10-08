// One injected <style> for the whole widget. Every class is `dalil-` prefixed and
// colours are custom properties so light/dark follows prefers-color-scheme.
const CSS = `
.dalil-root{--dalil-bg:#fff;--dalil-fg:#111827;--dalil-muted:#6b7280;--dalil-border:#d1d5db;--dalil-accent:#2563eb;--dalil-accent-fg:#fff;--dalil-danger:#b91c1c;--dalil-surface:#f3f4f6;--dalil-backdrop:rgba(0,0,0,.45);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;color:var(--dalil-fg)}
@media (prefers-color-scheme:dark){.dalil-root{--dalil-bg:#1f2937;--dalil-fg:#f9fafb;--dalil-muted:#9ca3af;--dalil-border:#4b5563;--dalil-accent:#3b82f6;--dalil-surface:#111827;--dalil-danger:#f87171;--dalil-backdrop:rgba(0,0,0,.6)}}
.dalil-root[data-theme=light]{--dalil-bg:#fff;--dalil-fg:#111827;--dalil-muted:#6b7280;--dalil-border:#d1d5db;--dalil-accent:#2563eb;--dalil-surface:#f3f4f6;--dalil-danger:#b91c1c;--dalil-backdrop:rgba(0,0,0,.45);color-scheme:light}
.dalil-root[data-theme=dark]{--dalil-bg:#1f2937;--dalil-fg:#f9fafb;--dalil-muted:#9ca3af;--dalil-border:#4b5563;--dalil-accent:#3b82f6;--dalil-surface:#111827;--dalil-danger:#f87171;--dalil-backdrop:rgba(0,0,0,.6);color-scheme:dark}
.dalil-root *,.dalil-root *::before,.dalil-root *::after{box-sizing:border-box}
.dalil-fab{position:fixed;inset-block-end:16px;inset-inline-end:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:0;border-radius:999px;background:var(--dalil-accent);color:var(--dalil-accent-fg);font:inherit;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.85}
.dalil-fab:hover,.dalil-fab:focus-visible{opacity:1}
.dalil-fab[data-pos=bottom-start]{inset-inline-end:auto;inset-inline-start:16px}
.dalil-backdrop{position:fixed;inset:0;z-index:2147483001;background:var(--dalil-backdrop);display:flex;align-items:center;justify-content:center;padding:12px}
.dalil-dialog{background:var(--dalil-bg);color:var(--dalil-fg);border-radius:10px;width:100%;max-width:560px;max-height:calc(100vh - 24px);overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.dalil-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dalil-head h2{margin:0;font-size:17px}
.dalil-x{border:0;background:none;color:var(--dalil-muted);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}
.dalil-field{display:flex;flex-direction:column;gap:4px}
.dalil-label{font-weight:600}
.dalil-textarea{font:inherit;color:inherit;background:var(--dalil-bg);border:1px solid var(--dalil-border);border-radius:6px;padding:8px;min-height:64px;resize:vertical;width:100%}
.dalil-textarea:focus{outline:2px solid var(--dalil-accent);outline-offset:0}
.dalil-sev{display:flex;flex-wrap:wrap;gap:12px;border:0;margin:0;padding:0}
.dalil-sev legend{font-weight:600;padding:0;margin-block-end:4px}
.dalil-sev label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dalil-notice{background:var(--dalil-surface);border-radius:6px;padding:8px;color:var(--dalil-muted)}
.dalil-error{color:var(--dalil-danger)}
.dalil-tools{display:flex;flex-wrap:wrap;gap:6px;margin-block-end:6px}
.dalil-btn{font:inherit;border:1px solid var(--dalil-border);background:var(--dalil-bg);color:var(--dalil-fg);border-radius:6px;padding:6px 12px;cursor:pointer}
.dalil-btn[aria-pressed=true]{background:var(--dalil-accent);color:var(--dalil-accent-fg);border-color:var(--dalil-accent)}
.dalil-btn:disabled{opacity:.5;cursor:not-allowed}
.dalil-primary{background:var(--dalil-accent);color:var(--dalil-accent-fg);border-color:var(--dalil-accent)}
.dalil-canvas{display:block;width:100%;height:auto;border:1px solid var(--dalil-border);border-radius:6px;touch-action:none;cursor:crosshair}
.dalil-drop{border:1px dashed var(--dalil-border);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:8px}
.dalil-drop[data-over=true]{border-color:var(--dalil-accent)}
.dalil-thumbs{display:flex;flex-wrap:wrap;gap:8px}
.dalil-thumb{position:relative;width:64px;height:64px}
.dalil-thumb img{width:100%;height:100%;object-fit:cover;border-radius:4px;border:1px solid var(--dalil-border)}
.dalil-thumb button{position:absolute;inset-block-start:-6px;inset-inline-end:-6px;width:20px;height:20px;border-radius:50%;border:0;background:var(--dalil-fg);color:var(--dalil-bg);font-size:12px;line-height:20px;padding:0;cursor:pointer}
.dalil-autos{display:flex;gap:8px;overflow-x:auto;padding-block:4px}
.dalil-auto{position:relative;margin:0;flex:0 0 132px;display:flex;flex-direction:column;gap:4px}
.dalil-auto img{width:132px;height:80px;object-fit:cover;object-position:top;border-radius:4px;border:1px solid var(--dalil-border)}
.dalil-auto figcaption{font-size:12px;color:var(--dalil-muted);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dalil-auto button{position:absolute;inset-block-start:-6px;inset-inline-end:-6px;width:20px;height:20px;border-radius:50%;border:0;background:var(--dalil-fg);color:var(--dalil-bg);font-size:12px;line-height:20px;padding:0;cursor:pointer}
.dalil-rec{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dalil-summary summary{cursor:pointer;font-weight:600}
.dalil-summary ul{margin:6px 0 0;padding-inline-start:18px;color:var(--dalil-muted)}
.dalil-actions{display:flex;justify-content:flex-end;gap:8px}
.dalil-toast{position:fixed;inset-block-end:64px;inset-inline-end:16px;z-index:2147483002;background:var(--dalil-fg);color:var(--dalil-bg);padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:calc(100vw - 32px)}
.dalil-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`

export type DalilTheme = 'light' | 'dark' | 'system'

export interface Appearance {
  theme?: DalilTheme
  accent?: string
  accentForeground?: string
}

/** Attributes for every `.dalil-root`: forced theme and brand colour overrides. */
export function rootAttrs(a: Appearance): { 'data-theme'?: 'light' | 'dark'; style?: Record<string, string> } {
  const style: Record<string, string> = {}
  if (a.accent) style['--dalil-accent'] = a.accent
  if (a.accentForeground) style['--dalil-accent-fg'] = a.accentForeground
  return {
    ...(a.theme === 'light' || a.theme === 'dark' ? { 'data-theme': a.theme } : {}),
    ...(Object.keys(style).length ? { style } : {}),
  }
}

const STYLE_ID = 'dalil-styles'

/** Inject the stylesheet once into `root`: document.head (light DOM, default) or a ShadowRoot. */
export function ensureStyles(root?: Document | ShadowRoot): void {
  if (typeof document === 'undefined') return
  const target: ParentNode | null = root ? root : document.head
  if (!target) return
  const has = root ? root.querySelector(`#${STYLE_ID}`) : document.getElementById(STYLE_ID)
  if (has) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.setAttribute('data-dalil-ignore', '')
  el.textContent = CSS
  target.appendChild(el)
}
