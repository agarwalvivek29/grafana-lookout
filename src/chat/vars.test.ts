import { toRecord, urlVariables } from './vars';

describe('dashboard variables from the URL', () => {
  test('reads var-* and joins multi-value variables', () => {
    expect(toRecord(urlVariables('?var-env=prod&var-svc=a&var-svc=b&from=now-1h'))).toEqual({
      env: 'prod',
      svc: 'a,b',
    });
  });

  test('ignores names that could reach the object prototype', () => {
    const vars = toRecord(urlVariables('?var-__proto__=x&var-constructor=y&var-prototype=z&var-ok=1'));
    expect(vars).toEqual({ ok: '1' });
    expect(Object.getPrototypeOf(vars)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
