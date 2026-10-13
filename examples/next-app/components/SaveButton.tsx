'use client'
import { useState } from 'react'

export function SaveButton() {
  const [out, setOut] = useState('')
  const [toast, setToast] = useState('')
  return (
    <div>
      <button id="save" onClick={async () => {
        const r = await fetch('/api/fail', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } })
        setOut(`save -> ${r.status}`)
      }}>Save</button>
      <button id="toast" onClick={() => setToast('Could not save booking')}>Show error toast</button>
      <p id="out">{out}</p>
      {toast && <div className="toast-error" role="alert">{toast}</div>}
    </div>
  )
}
