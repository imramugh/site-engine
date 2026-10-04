'use client'
import { useEffect, useRef, useState } from 'react'
import styles from './workflow.module.css'

export function PreviewFrame({ title, src, width }: { title: string; src: string; width: 760 | 390 }) {
  const ref = useRef<HTMLDivElement>(null); const [available, setAvailable] = useState<number>(width)
  useEffect(() => { const node = ref.current; if (!node) return; const resize = () => setAvailable(node.clientWidth || width); resize(); const observer = new ResizeObserver(resize); observer.observe(node); return () => observer.disconnect() }, [width])
  const scale = Math.min(1, available / width)
  return <div ref={ref} className={styles.frameViewport} style={{ height: 640 * scale }}><iframe title={title} src={src} width={width} height={640} style={{ transform: `scale(${scale})` }} /></div>
}
