// Links in answers. Tools return in-app paths ("/d/...", "/explore?..."). This module decides which links in
// model output point into this Grafana (R1: only those stay clickable) and handles Grafana served under a
// sub-path (root_url like https://example.com/grafana/).
import { config } from '@grafana/runtime';

const toolLinks = new Set<string>();

/** Record a link a tool returned, so it can be recognised even if the model writes it with a made-up host. */
export function rememberToolLink(url: unknown) {
  if (typeof url === 'string' && url.startsWith('/')) {
    toolLinks.add(url);
  }
}

/**
 * The in-app path (without the sub-path) for a link in model output, or null when it does not point into this
 * Grafana. A link to another host is accepted only when its path and query are exactly a link a tool returned.
 */
export function appPath(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) {
    return null;
  }
  const sub = config.appSubUrl ?? '';
  let path = url.pathname + url.search;
  if (url.origin === window.location.origin) {
    if (sub && (path === sub || path.startsWith(`${sub}/`))) {
      path = path.slice(sub.length) || '/';
    }
    return path + url.hash;
  }
  return toolLinks.has(path) ? path : null;
}

/** A browser URL for an in-app path. */
export function withSubUrl(path: string): string {
  return `${config.appSubUrl ?? ''}${path}`;
}
