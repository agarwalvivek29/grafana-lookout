// Dashboard variables come from the URL (var-<name>=value) and from panel context. Names are user-controlled,
// so they are collected in a Map and turned into a plain object with Object.fromEntries (own properties only),
// and names that could reach the object prototype are dropped.
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeVariableName(name: string): boolean {
  return name.length > 0 && !UNSAFE.has(name);
}

/** Variables from a URL query string; repeated values (multi-value variables) are joined with commas. */
export function urlVariables(search: string, into = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of new URLSearchParams(search)) {
    if (!k.startsWith('var-')) {
      continue;
    }
    const name = k.slice(4);
    if (!isSafeVariableName(name)) {
      continue;
    }
    const prev = into.get(name);
    into.set(name, prev ? `${prev},${v}` : v);
  }
  return into;
}

export function toRecord(vars: Map<string, string>): Record<string, string> {
  return Object.fromEntries(vars);
}
