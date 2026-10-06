import { SiteSnapshotSchema } from '@site-engine/contract';

function quotePath(path) {
  // Contract paths exclude quotes, variables, whitespace, and control characters.
  return path;
}

/** Produces an include that can be placed inside an Nginx server block. */
export function nginxRedirectInclude(input) {
  const snapshot = SiteSnapshotSchema.parse(input);
  const redirects = [...snapshot.redirects].sort((left, right) => left.from.localeCompare(right.from));
  const sources = new Set();
  for (const redirect of redirects) {
    if (sources.has(redirect.from)) throw new Error(`Duplicate redirect source ${redirect.from}.`);
    sources.add(redirect.from);
  }
  for (const redirect of redirects) {
    if (sources.has(redirect.to)) throw new Error(`Redirect ${redirect.from} is not a one-hop destination.`);
  }
  return ['# Generated from an approved immutable snapshot. Do not edit.', ...redirects.map((redirect) => `location = ${quotePath(redirect.from)} { return 301 ${quotePath(redirect.to)}; }`), ''].join('\n');
}
