import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DalilProvider, useDalil } from '../src/react'

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer demo.jwt.token' },
    body: JSON.stringify({ query: body }),
  })

/** Mimics sonner's DOM: Dalil watches for [data-sonner-toast][data-type="error"]. */
function showErrorToast(message: string) {
  const el = document.createElement('li')
  el.setAttribute('data-sonner-toast', '')
  el.setAttribute('data-type', 'error')
  el.setAttribute('data-id', String(Date.now()))
  el.textContent = message
  Object.assign(el.style, {
    position: 'fixed', right: '16px', top: '16px', listStyle: 'none', padding: '12px 16px',
    background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: '8px', zIndex: '50',
  })
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

function Demo() {
  const { open } = useDalil()
  const [rows, setRows] = useState(0)
  const [rtl, setRtl] = useState(false)
  return (
    <main dir={rtl ? 'rtl' : 'ltr'}>
      <h1>dalil demo</h1>
      <p>Trigger a failure, then press the floating button or Ctrl/⌘+Shift+B.</p>
      <div className="row">
        <button
          onClick={() => {
            void post('/api/server-error', { playerGuid: 'abc', amount: 50 }).then(() => showErrorToast('Failed to save payment'))
          }}
        >
          500 fetch (+ error toast)
        </button>
        <button onClick={() => post('/api/validation', { amount: -1, password: 'hunter2' })}>400 validation</button>
        <button onClick={() => post('/api/app-error', { playerGuid: 'missing' })}>200 success:false</button>
        <button
          onClick={() => {
            throw new Error('Cannot read properties of undefined (reading "name")')
          }}
        >
          Throw JS error
        </button>
        <button onClick={() => setRows(rows ? 0 : 500)}>{rows ? 'Hide' : 'Show'} big table</button>
        <button onClick={() => setRtl((v) => !v)}>Toggle RTL</button>
        <button onClick={open}>Open from host menu</button>
      </div>
      {/* Cross-origin image with no CORS headers: used to sink every screenshot before 0.2.0. */}
      <p>
        <img src="https://example.com/logo-without-cors.png" alt="cross-origin logo" width={120} height={32} />{' '}
        <span>(cross-origin image: the screenshot must still succeed)</span>
      </p>
      <p className="secret" data-dalil-mask>
        Masked area: card 4111 1111 1111 1111 (should be a grey box in the screenshot)
      </p>
      {rows > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th><th>Player</th><th>Plan</th><th>Balance</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i}>
                <td>{i + 1}</td><td>Player {i + 1}</td><td>Monthly</td><td>{(i * 7) % 120} JOD</td>
                <td>{i % 3 ? 'Active' : 'Expired'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <DalilProvider
        project="demo"
        publicKey="pk_demo"
        endpoint="/v1/reports"
        apiOrigins={[location.origin]}
        enabled
        dir={rtl ? 'rtl' : 'ltr'}
        getContext={() => ({ userId: 'u-1', userName: 'Demo Owner', role: 'Owner', tenant: 'Demo Academy' })}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
)
