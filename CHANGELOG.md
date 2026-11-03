# Changelog

## Unreleased

- Build and edit dashboards from chat: create a dashboard, add, change or remove panels, add variables, and set
  the time range. Changes are shown as a proposal with live previews and saved only when you click Apply; Undo
  restores the previous version. Works with dashboards stored in the classic and the v2 schema; provisioned and
  Git Sync dashboards are saved as a copy. See `docs/design/dashboard-editing.md`.
- Dashboard API calls use the current organisation's namespace instead of always `default`.

## 0.1.0 (2026-11-03)

First public version.

- Chat with your Grafana data from a side panel on any dashboard, the panel menu ("Ask AI", "Explain with AI"),
  the command palette, or a full page. Answers come with links to dashboard panels or Explore.
- Previews under answers: a picture of linked dashboard panels (needs the Grafana Image Renderer) and live charts
  for Explore metric links.
- Follows the dashboard you are looking at: variable, time range and dashboard changes between questions.
- Tools for Prometheus-compatible metrics (Prometheus, Mimir, VictoriaMetrics, Thanos), Loki and Quickwit logs,
  Tempo traces, and dashboards. Everything runs as the signed-in user.
- Setup page: configure the model (OpenRouter, OpenAI, Ollama or any OpenAI-compatible endpoint), test tool
  calling, and see which data sources Lookout can use.
