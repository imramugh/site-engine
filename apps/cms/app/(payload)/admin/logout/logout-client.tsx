'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export function LogoutClient() {
  const router = useRouter()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then((response) => {
      if (!active) return
      if (!response.ok) {
        setFailed(true)
        return
      }
      router.replace('/admin/login')
      router.refresh()
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [router])

  return <main><h1>Signing out</h1>{failed ? <p role="alert">Sign-out could not be completed. Try again.</p> : <p role="status">Ending this session.</p>}</main>
}
