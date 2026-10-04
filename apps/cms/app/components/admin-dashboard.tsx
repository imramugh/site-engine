import { headers } from 'next/headers'
import { getPayload } from 'payload'
import config from '../../payload.config'
import { getAdminDashboardData } from '../../src/admin-dashboard'
import { serverSessionStrategy } from '../../src/identity'

function date(value?: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return 'Time not recorded'
  return new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto', timeZoneName: 'short' }).format(new Date(value))
}
function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat('en-CA', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Toronto' }).format(new Date()))
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

export async function AdminDashboard() {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  const data = await getAdminDashboardData(payload, authenticated.user as never)
  const reviews = data.pendingReviews
  const pageIssues = data.pages?.withIssues
  const has = (href: string) => data.shortcuts.some(link => link.href === href)
  const endpoint = new URL('/mcp', process.env.PAYLOAD_PUBLIC_SERVER_URL || 'http://localhost:3000').href
  const summary = [reviews ? `${reviews.total} review${reviews.total === 1 ? '' : 's'} waiting` : '', data.leads ? `${data.leads.new} new lead${data.leads.new === 1 ? '' : 's'}${data.leads.urgent ? `, including ${data.leads.urgent} urgent` : ''}` : ''].filter(Boolean).join(' · ')

  return <main className="admin-dashboard" aria-labelledby="admin-dashboard-title">
    <header data-dashboard-greeting>
      <div><h2 id="admin-dashboard-title">{greeting()}</h2><p>{summary || 'Your workspace is ready.'}</p></div>
      {data.actions.length > 0 && <div data-dashboard-actions>{data.actions.map(action => action.href === '/integrations' ? <details key={action.href} data-dashboard-connect><summary>Connect an assistant</summary><div><h3>Connect your MCP client</h3><p>Add a remote MCP connection using this address, then sign in with your staff account and approve the requested access.</p><label>Server address<input readOnly value={endpoint} /></label><p>Microsoft or Google login is not required when your local account is enabled.</p></div></details> : <a key={action.href} href={action.href}>{action.label}</a>)}</div>}
    </header>
    {data.message && <p data-dashboard-empty role={data.state === 'error' ? 'alert' : 'status'}>{data.message}</p>}
    <div data-dashboard-metrics aria-label="Dashboard summary">
      <a href={has('/editorial') ? '/editorial' : undefined} data-dashboard-metric="reviews"><span data-metric-label>Reviews waiting</span><strong data-metric-value>{reviews?.total ?? '—'}</strong><small data-metric-note>{reviews?.items[0] ? `Oldest: ${date(reviews.items[0].updatedAt)}` : reviews ? 'No reviews waiting' : 'Not available for this role'}</small></a>
      <a href={has('/leads') ? '/leads' : undefined} data-dashboard-metric="leads"><span data-metric-label>New leads</span><strong data-metric-value>{data.leads?.new ?? '—'}</strong><small data-metric-note>{data.leads ? `${data.leads.urgent} active incident${data.leads.urgent === 1 ? '' : 's'}` : 'Not available for this role'}</small></a>
      <a href={has('/content-tree') ? '/content-tree' : undefined} data-dashboard-metric="issues"><span data-metric-label>Pages with issues</span><strong data-metric-value>{pageIssues?.state === 'available' ? pageIssues.total : '—'}</strong><small data-metric-note>{pageIssues?.message ?? 'Not available for this role'}</small></a>
      <a href={has('/operations') ? '/operations' : undefined} data-dashboard-metric="publish"><span data-metric-label>Last publish</span><strong data-metric-value>{data.latestRelease ? 'Published' : '—'}</strong><small data-metric-note>{data.latestRelease ? date(data.latestRelease.activatedAt) : data.pages ? 'No published release yet' : 'Not available for this role'}</small></a>
    </div>
    <div data-dashboard-columns>
      <div data-dashboard-editorial-panels>
        <section data-dashboard-reviews aria-labelledby="dashboard-reviews-title">
          <header data-dashboard-panel-header><h3 id="dashboard-reviews-title">Reviews waiting</h3>{has('/editorial') && <a href="/editorial">All reviews</a>}</header>
          {reviews?.items.length ? reviews.items.map(review => <div data-dashboard-row key={review.id}><div><strong>{review.name}</strong><small>{review.changes} change{review.changes === 1 ? '' : 's'} · {date(review.updatedAt)}</small></div><div data-dashboard-review-controls><span data-dashboard-badge="waiting">Waiting</span><a data-dashboard-review-action href={`/editorial?changeSet=${encodeURIComponent(review.id)}`}>Review</a></div></div>) : <p data-dashboard-empty>{reviews ? 'No reviews are waiting. Submitted change sets will appear here.' : 'Reviews are not available for this role.'}</p>}
        </section>
        <section data-dashboard-issues aria-labelledby="dashboard-issues-title">
          <header data-dashboard-panel-header><h3 id="dashboard-issues-title">Pages with issues</h3></header>
          {pageIssues?.items.length ? pageIssues.items.map(page => <div data-dashboard-row key={page.id}><a href={`/admin/collections/pages/${encodeURIComponent(page.id)}`}>{page.title}</a><span data-dashboard-issue={page.severity} title={page.messages.join(" · ")}>{page.summary}{page.messages.length > 1 ? ` (+${page.messages.length - 1})` : ''}</span></div>) : <p data-dashboard-empty>{pageIssues?.state === 'available' ? 'No issues found in the latest published content.' : pageIssues?.message ?? 'Page checks are not available for this role.'}</p>}
        </section>
      </div>
      <div>
        <section data-dashboard-leads aria-labelledby="dashboard-leads-title">
          <header data-dashboard-panel-header><h3 id="dashboard-leads-title">Leads needing action</h3>{has('/leads') && <a href="/leads">Pipeline</a>}</header>
          {data.leads?.items.length ? data.leads.items.map(lead => <a data-dashboard-row data-dashboard-lead={lead.tag.toLowerCase()} key={lead.id} href={`/admin/collections/inquiries/${encodeURIComponent(lead.id)}`}><span><strong>{lead.name}{lead.company ? ` · ${lead.company}` : ''}</strong><small>{lead.note}</small></span><span data-dashboard-lead-tag>{lead.tag}</span></a>) : <p data-dashboard-empty>{data.leads ? 'No leads need action. New inquiries will appear here.' : 'Leads are not available for this role.'}</p>}
        </section>
        <section data-dashboard-site-status aria-labelledby="dashboard-status-title">
          <h3 id="dashboard-status-title">Site status</h3>
          <dl>
            <div><dt>Latest release</dt><dd data-status={data.latestRelease ? 'ready' : 'unknown'}>{data.latestRelease ? `Published · ${data.latestRelease.sequence}` : 'Not recorded'}</dd></div>
            <div><dt>Email delivery</dt><dd data-status="unknown">Not configured in CMS</dd></div>
            <div><dt>AI providers</dt><dd data-status={data.providers?.connected ? 'ready' : 'unknown'}>{data.providers ? data.providers.configured ? `${data.providers.connected} of ${data.providers.configured} verified` : 'Not configured' : 'Owner access required'}</dd></div>
            <div><dt>Backups</dt><dd data-status="unknown">Not reported to CMS</dd></div>
          </dl>
        </section>
      </div>
    </div>
  </main>
}
