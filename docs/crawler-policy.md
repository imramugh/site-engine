# Reviewed crawler policy

Contract 1.7 snapshots may include three reviewed crawler preferences. The
public renderer translates them into `robots.txt` groups after the ordinary
editorial review and publication lifecycle:

- Search engines controls the generic `User-agent: *` group. This includes
  ordinary search crawlers such as Googlebot and bingbot.
- AI search and answers adds explicit rules for `OAI-SearchBot`,
  `Claude-SearchBot`, `Claude-User`, and `PerplexityBot`.
- AI model training adds explicit rules for `GPTBot`, `ClaudeBot`, and
  `Google-Extended`.

Every allowed group repeats the exclusions for `/admin/`, `/preview/`,
`/api/`, `/oauth/`, and `/mcp/`. Mounted preview builds always emit a generic
`Disallow: /`; reviewed settings cannot make a preview crawlable. Snapshots
from contracts before 1.7 retain the prior public behavior, which allows
public crawling while excluding those protected paths.

Robots directives are requests to cooperating crawlers. They do not authorize
access, keep a URL out of an index, or protect confidential content. Private
routes still require authentication and authorization. OpenAI documents that
`ChatGPT-User` is user initiated and robots rules may not apply. Perplexity
similarly documents that `Perplexity-User` generally ignores robots rules.
Neither token is presented as a supported control. `llms.txt` remains public
descriptive output; the reviewed short site description is included there and
in organization structured data.

The supported token mapping was reviewed against the vendor documentation on
2026-10-05:

- [OpenAI crawlers](https://developers.openai.com/api/docs/bots)
- [Anthropic bots](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)
- [Google common crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers)
- [Perplexity crawlers](https://docs.perplexity.ai/docs/resources/perplexity-crawlers)
- [Bing robots guidance](https://www.bing.com/webmasters/help/how-to-create-a-robots-txt-file-cb7c31ec)
