import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export class RendererModuleError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_RENDERER_MODULE'; }
}

/**
 * Loads the operator-trusted renderer before a worker begins claiming work.
 * The module receives the ordinary buildSnapshot options and must return the
 * ordinary `{ output, manifest }` result. Workers still independently verify
 * every output before it can be served or activated.
 */
export async function loadRenderer({ modulePath = process.env.SITE_RENDERER_MODULE, genericRenderer }) {
  if (typeof genericRenderer !== 'function') throw new RendererModuleError('A generic renderer is required.');
  if (!modulePath) return genericRenderer;
  if (typeof modulePath !== 'string' || !isAbsolute(modulePath)) throw new RendererModuleError('SITE_RENDERER_MODULE must be an absolute path.');
  const info = await lstat(modulePath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new RendererModuleError('SITE_RENDERER_MODULE must be a real module file.');
  let module;
  try { module = await import(pathToFileURL(modulePath).href); }
  catch { throw new RendererModuleError('SITE_RENDERER_MODULE could not be loaded.'); }
  if (typeof module.buildSnapshot !== 'function') throw new RendererModuleError('SITE_RENDERER_MODULE must export buildSnapshot(options).');
  return module.buildSnapshot;
}
