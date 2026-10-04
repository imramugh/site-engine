import { headers } from 'next/headers'
import { getPayload } from 'payload'
import config from '../../payload.config'
import { getAdminDashboardData } from '../../src/admin-dashboard'
import { serverSessionStrategy } from '../../src/identity'

function date(value: string | undefined): string {
  if (!value) return 'Recorded release time unavailable'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Recorded release time unavailable' : new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto', timeZoneName: 'short' }).format(parsed)
}

/** Server component intentionally has no props so the shell cannot pass untrusted dashboard data. */
export async function AdminDashboard() {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  const data = await getAdminDashboardData(payload, authenticated.user as never)

  return <main className="admin-dashboard" aria-labelledby="admin-dashboard-title">
    <header className="admin-dashboard__header"><h1 id="admin-dashboard-title">Dashboard</h1><p>Current work and release status from the CMS.</p></header>
    {data.state === 'error' ? <p className="admin-dashboard__status" role="alert">{data.message}</p> : null}
    {data.state === 'unconfigured' ? <p className="admin-dashboard__status" role="status">{data.message}</p> : null}
    {data.pendingReviews !== undefined || data.pages ? <section className="admin-dashboard__section" aria-labelledby="admin-dashboard-content"><h2 id="admin-dashboard-content">Content readiness</h2><dl className="admin-dashboard__metrics">
      {data.pendingReviews !== undefined ? <div data-admin-metric="number"><dt>Pending reviews</dt><dd>{data.pendingReviews.total}</dd></div> : null}
      {data.pages ? <><div data-admin-metric="number"><dt>Saved pages</dt><dd>{data.pages.total}</dd></div><div data-admin-metric="number"><dt>Draft pages</dt><dd>{data.pages.draft}</dd></div><div className="admin-dashboard__readiness" data-admin-metric="status"><dt>Recorded checks</dt><dd>{data.pages.readiness.state === 'available' ? `Issues in the latest five submitted reviews: ${data.pages.readiness.issues}` : 'Not run for submitted reviews'}</dd></div><div className="admin-dashboard__readiness" data-admin-metric="status"><dt>Pages with identified issues</dt><dd>{data.pages.withIssues.state === 'unavailable' ? `Unavailable — ${data.pages.withIssues.message}` : ''}</dd></div></> : null}
      <div data-admin-metric="status"><dt>Latest release</dt><dd>{data.latestRelease ? <>Release {data.latestRelease.sequence}<span className="admin-dashboard__detail">{date(data.latestRelease.activatedAt)}</span></> : 'No published release yet'}</dd></div>
    </dl></section> : null}
    {data.pendingReviews?.items.length ? <section className="admin-dashboard__section admin-dashboard__queue" aria-labelledby="admin-dashboard-review-queue"><h2 id="admin-dashboard-review-queue">Review queue</h2><ul>{data.pendingReviews.items.map((review) => <li className="admin-dashboard__review" key={review.id}><span>{review.name} · {review.state} · {review.readiness === 'not-run' ? 'recorded checks not run' : review.readiness === 'blocked' ? `${review.issues} recorded issue${review.issues === 1 ? '' : 's'} blocking review` : 'recorded checks passed'}</span> <a href="/editorial">Open review queue</a></li>)}</ul></section> : null}
    {data.leads ? <section className="admin-dashboard__section" aria-labelledby="admin-dashboard-leads"><h2 id="admin-dashboard-leads">Lead queue</h2><dl className="admin-dashboard__metrics"><div><dt>New leads</dt><dd>{data.leads.new}</dd></div><div><dt>Urgent leads</dt><dd>{data.leads.urgent}</dd></div></dl></section> : null}
    <nav className="admin-dashboard__shortcuts" aria-label="Dashboard shortcuts"><h2>Shortcuts</h2>{data.shortcuts.length ? <ul>{data.shortcuts.map((item) => <li key={item.href}><a href={item.href}>{item.label}</a></li>)}</ul> : <p>No staff shortcuts are available for this session.</p>}</nav>
  </main>
}
