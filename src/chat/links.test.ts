const mockConfig = { appSubUrl: '' };
jest.mock('@grafana/runtime', () => ({
  get config() {
    return mockConfig;
  },
}));

import { escapeApproxTildes, safeHtml } from './SafeMarkdown';
import { appPath, rememberToolLink, withSubUrl } from './links';

describe('links in answers', () => {
  beforeEach(() => {
    mockConfig.appSubUrl = '';
  });

  test('relative and same-origin links stay clickable', () => {
    expect(appPath('/d/abc?var-x=1')).toBe('/d/abc?var-x=1');
    expect(appPath(`${window.location.origin}/explore?a=1`)).toBe('/explore?a=1');
  });

  test('links to other hosts are blocked', () => {
    expect(appPath('https://evil.example/steal?q=secret')).toBeNull();
    expect(appPath('https://evil.example/api/users')).toBeNull();
    expect(appPath('javascript:alert(1)')).toBeNull();
    const html = safeHtml('[click](https://evil.example/steal)');
    expect(html).not.toContain('<a');
    expect(html).toContain('external link not opened for safety');
  });

  test('a tool link written with a made-up host is restored to the exact tool path only', () => {
    rememberToolLink('/d/lookout-demo?orgId=1&var-service=checkout');
    expect(appPath('https://grafana.com/d/lookout-demo?orgId=1&var-service=checkout')).toBe(
      '/d/lookout-demo?orgId=1&var-service=checkout'
    );
    expect(appPath('https://grafana.com/login?next=x')).toBeNull();
  });

  test('Grafana page paths on a made-up host are rewritten to this Grafana', () => {
    expect(appPath('https://grafana.url/d/abc/shop?var-service=catalog')).toBe('/d/abc/shop?var-service=catalog');
    expect(appPath('http://localhost:3000/explore?panes=x')).toBe('/explore?panes=x');
    expect(safeHtml('[x](https://grafana.url/d/abc)')).toContain('href="/d/abc"');
  });

  test('Grafana under a sub-path: links get the prefix once', () => {
    mockConfig.appSubUrl = '/grafana';
    expect(appPath('/grafana/d/abc')).toBe('/d/abc');
    expect(appPath('/d/abc')).toBe('/d/abc');
    expect(withSubUrl('/d/abc')).toBe('/grafana/d/abc');
    expect(safeHtml('[panel](/d/abc?viewPanel=panel-1)')).toContain('href="/grafana/d/abc?viewPanel=panel-1"');
  });
});

describe('approximate values', () => {
  test('single tildes are not strikethrough, code and ~~real~~ strikethrough are kept', () => {
    expect(safeHtml('about ~55ms and ~19ms')).not.toMatch(/<del|<s>/);
    expect(safeHtml('about ~55ms and ~19ms')).toContain('~55ms');
    expect(escapeApproxTildes('`a ~ b` and ~~gone~~')).toBe('`a ~ b` and ~~gone~~');
  });
});
