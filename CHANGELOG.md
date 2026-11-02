# Changelog

## 0.1.0 (Unreleased)

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
