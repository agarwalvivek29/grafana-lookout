// Safe rendering of model output (R1/D3): Grafana's sanitizing markdown renderer, then
// - only links into this Grafana stay clickable (see links.ts); others become plain text
// - images are removed (no remote image loads)
import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, renderMarkdown } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { appPath, withSubUrl } from './links';

export function safeHtml(markdown: string): string {
  const html = renderMarkdown(markdown);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement;
  root.querySelectorAll('img, iframe, object, embed, video, audio, form, script, style').forEach((el) => el.remove());
  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    const path = appPath(href);
    if (path === null) {
      const span = doc.createElement('span');
      span.textContent = `${a.textContent ?? ''} (external link not opened for safety)`;
      span.setAttribute('title', href);
      a.replaceWith(span);
    } else {
      a.setAttribute('href', withSubUrl(path));
      a.removeAttribute('target');
      a.setAttribute('rel', 'noopener');
    }
  });
  return root.innerHTML;
}

export function SafeMarkdown({ markdown }: { markdown: string }) {
  const s = useStyles2(getStyles);
  const html = useMemo(() => safeHtml(markdown), [markdown]);
  return <div className={s.md} dangerouslySetInnerHTML={{ __html: html }} />;
}

const getStyles = (theme: GrafanaTheme2) => ({
  md: css`
    overflow-wrap: anywhere;
    p {
      margin-bottom: ${theme.spacing(1)};
    }
    ul,
    ol {
      padding-left: ${theme.spacing(3)};
      margin-bottom: ${theme.spacing(1)};
    }
    a {
      color: ${theme.colors.text.link};
      text-decoration: underline;
    }
    code {
      font-family: ${theme.typography.fontFamilyMonospace};
      font-size: ${theme.typography.bodySmall.fontSize};
      background: ${theme.colors.background.secondary};
      padding: 0 ${theme.spacing(0.5)};
      border-radius: ${theme.shape.radius.default};
    }
    h1,
    h2,
    h3,
    h4 {
      font-size: ${theme.typography.h5.fontSize};
      margin: ${theme.spacing(1, 0)};
    }
    table {
      border-collapse: collapse;
      margin-bottom: ${theme.spacing(1)};
    }
    th,
    td {
      border: 1px solid ${theme.colors.border.weak};
      padding: ${theme.spacing(0.5, 1)};
    }
  `,
});
