# Public conversion measurement

The public site sends no analytics request unless `PUBLIC_ANALYTICS_ENDPOINT` is set. When an endpoint is configured, consent is required by default. A consent UI can grant or revoke that choice with `window.siteAnalyticsConsent.grant()` and `window.siteAnalyticsConsent.revoke()`; revocation takes effect for subsequent events immediately.

The payload contains only an allowlisted event name, the page path, a bounded attribution category, and the form kind for outcomes. It never contains an IP address, email address, message, form fields, cookie identifier, or fingerprint. The supported events are page views, primary CTAs, internal navigation, phone taps, and accepted or failed inquiry/application submissions.

Use aggregate reports for baseline and post-launch review: date range, event count, path, attribution category, and form kind. Record report generation time and the site build/version alongside performance measures. The site does not install a vendor SDK or make a vendor request by default; any collector endpoint remains an explicit deployment configuration.
