const css = `
[data-public-page-review]{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;min-height:52px;display:flex;align-items:center;gap:16px;padding:10px 12px 10px 18px;color:#fff;background:#0f1b26;border-left:4px solid #ffcb05;border-radius:4px;box-shadow:0 8px 30px rgb(0 0 0/.28);font:14px/1.3 system-ui,sans-serif}
[data-public-page-review]>span{min-width:0;display:grid;gap:2px;flex:1}[data-public-page-review] strong,[data-public-page-review] small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}[data-public-page-review] small{color:#d6dee5;font-size:12px}
[data-public-page-review] button,[data-public-page-review-close]{min-height:34px;padding:7px 13px;color:#01243d;background:#ffcb05;border:1px solid #ffcb05;border-radius:4px;font:600 13px/1 system-ui,sans-serif;cursor:pointer}
[data-public-page-review-dialog]{width:100vw;max-width:none;height:100vh;max-height:none;margin:0;padding:0;border:0;background:#0f1b26}[data-public-page-review-dialog]::backdrop{background:rgb(1 36 61/.72)}
[data-public-page-review-dialog] iframe{width:100%;height:100%;border:0;background:#fff}[data-public-page-review-close]{position:fixed;z-index:2;right:14px;bottom:14px;color:#fff;background:#013a63;border-color:#fff}
@media(max-width:500px){[data-public-page-review]{left:8px;right:8px;bottom:8px;align-items:stretch;flex-direction:column}[data-public-page-review] button{width:100%}}
@media(prefers-reduced-motion:reduce){[data-public-page-review],[data-public-page-review-dialog]{scroll-behavior:auto!important}}
`

export async function GET(): Promise<Response> {
  return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } })
}
