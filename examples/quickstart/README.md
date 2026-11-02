# Lookout quickstart

Grafana 13 with Lookout, Prometheus, Loki and Tempo, plus three demo services (`checkout`, `payments`,
`catalog`) sending traces and logs. `checkout` has a slow, failing path to find.

For local trial only: anyone who opens this Grafana is an admin.

```sh
# from the repository root: build the plugin once
npm ci && npm run build && go run github.com/magefile/mage@v1.15.0 -v

cd examples/quickstart
docker compose up -d
```

Open http://localhost:3000, go to **Apps → Lookout → Setup**, choose a model provider, paste an API key
and click **Save and test**. Then open **Dashboards → Quickstart → Demo services** and click **Ask Lookout AI**.

Things to ask:

- "Which service has the most errors right now?"
- "Why is checkout slow? Show me a trace."
- "Show me the error logs for checkout."
- "Explain this panel" (from a panel menu)

Span metrics take about a minute to appear after start. Stop with `docker compose down`.
