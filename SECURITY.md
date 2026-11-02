# Security policy

## Supported versions

Lookout is young; only the latest release gets security fixes.

| Version            | Supported |
| ------------------ | --------- |
| Latest 0.x release | Yes       |
| Older releases     | No        |

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.

Report privately in either of these ways:

- **GitHub:** [open a private vulnerability report](https://github.com/agarwalvivek29/grafana-lookout/security/advisories/new).
- **Email:** agarwalvivek2902@gmail.com, with "Lookout security" in the subject.

Include what you found, the Lookout and Grafana versions, steps to reproduce, and the impact you expect.

What happens next:

- You get a reply within 3 working days.
- We confirm the problem, agree on its severity, and keep you updated at least weekly.
- Fixes are released as soon as they are ready, normally within 30 days for high or critical issues.
- We publish a GitHub security advisory once a fix is out and credit you, unless you prefer not to be named.

## What counts

In scope, for example:

- A way for model output, log lines, trace data or dashboard text to run script, open external links or images,
  or change what tools do (prompt injection that crosses a safety boundary).
- Lookout reading or changing data the signed-in user cannot already access.
- Leaking stored secrets (such as the model API key) to the browser or the model.
- Vulnerabilities in Lookout's code or in dependencies that Lookout ships in its bundle or backend binary.

Out of scope:

- Model answers that are wrong. Lookout says answers can be wrong and links to the source data.
- Issues in Grafana, the Grafana LLM plugin or your model provider. Report those to their projects.
- Findings in dependencies that Grafana provides at runtime (for example `@grafana/ui` or `react`), unless
  Lookout's use of them makes the problem exploitable.

## How Lookout is built to be safe

- Every tool runs in the browser with the signed-in user's Grafana permissions. Tools only read.
- Tool results are treated as untrusted data. Model output is rendered as sanitized Markdown, images are
  removed, and only links into the same Grafana are clickable.
- The model API key is stored encrypted by the Grafana LLM plugin and never reaches the browser.
- CI runs CodeQL, govulncheck, OSV-Scanner, npm audit, dependency review, secret scanning and OpenSSF
  Scorecard on every change and weekly.
