# Roadmap

Lookout is an open-source AI assistant for self-hosted Grafana. This roadmap says what we are building next
and why, so contributors can pick work that will land. It is a plan, not a promise: priorities change with
feedback. Comment on the linked issue or open a [discussion](https://github.com/agarwalvivek29/grafana-lookout/discussions)
to argue for something.

## Principles

These decide what gets built and how.

1. **No proprietary middle layer.** Lookout talks to the model you choose through the open-source Grafana
   LLM plugin. No Grafana Cloud account and no hosted Lookout service, ever.
2. **Read as the user, change only with consent.** Every tool runs with the signed-in user's Grafana
   permissions. Anything that changes Grafana (a dashboard, an alert) is shown as a preview and applied only
   when the user clicks Apply.
3. **Answers you can check.** Every answer ends with links to the panel or query it came from, and says what
   was measured and what is a guess.
4. **Use Grafana, don't rebuild it.** Build on Grafana's own APIs, dashboards, search and extension points
   instead of copying them.
5. **Vendor neutral.** Data sources plug in through adapters; company-specific context (service catalogs,
   investigation tools) plugs in through small, documented interfaces.

## Now: 0.1 (first public release)

- Chat in a side panel on any dashboard, from the panel menu, the command palette or a full page.
- Read-only tools for Prometheus-compatible metrics, Loki and Quickwit logs, Tempo traces, and dashboards.
- Follows the dashboard being viewed (variables, time range) between questions.
- Link previews: panel images (with the image renderer) and live Explore charts.
- Setup page with a model test; quickstart stack with demo data.
- Published in the Grafana plugin catalog with a community signature.

## Next: 0.2 (better answers)

- **Trends over time.** A range-query tool so "is this normal?" compares a whole window, not two instant
  values, and answers always state the window they used.
- **Honest limits.** When results are truncated (top-N series, sampled traces), say so in the answer.
- **Correct "slowest" and "most" questions.** Search enough traces or aggregate in the backend before
  ranking, instead of ranking a small recent sample.
- **Panels over raw IDs.** Link panels by title instead of naming internal panel keys.
- **Evaluation suite.** A fixed set of questions against the quickstart stack, run in CI, to catch answer
  regressions when prompts or tools change.
- **Conversation history.** Keep recent conversations per user across page loads.

## Later: 0.3 (build and fix dashboards)

- **Natural language to query.** "Show p95 latency for checkout by endpoint" becomes a PromQL, LogQL or
  TraceQL query in Explore or a panel editor.
- **Create and edit dashboards.** The assistant proposes a dashboard or a change, shows a preview, and saves
  it only on Apply. Works with Git Sync-managed dashboards.
- **Service catalog context.** A small provider interface so teams can plug in their own catalog (owners,
  runbooks, dependencies), starting with a file-based provider.
- **More data sources.** Elasticsearch/OpenSearch logs, VictoriaLogs, Jaeger traces. Each is a contained
  adapter; good first contributions.
- **Docked sidebar.** Use Grafana's built-in extension sidebar once third-party apps are allowed in it.

## Future: 1.0 and beyond

- **Investigations.** Hand a question like "why did checkout errors spike at 14:05?" to an investigation
  provider: Lookout's own multi-step workflow, or an external agent you already run.
- **Anomaly hints.** Point out unusual changes on the dashboard being viewed.
- **Chat integrations.** Ask Lookout from Slack and similar tools, with the same permission model.
- **Admin controls.** Per-team limits on which data sources and tools the assistant may use, and an audit log
  of questions and tool calls.
- **Older Grafana versions.** Support Grafana 12 if there is demand.

## Not planned

- A coding agent that edits application code.
- Bundling or hosting models. Bring your own endpoint (including local models via Ollama or vLLM).
- Features that only work with Grafana Cloud.
