# Lookout quickstart

Try Lookout in a few minutes without your own data. This starts:

- **Grafana 13** with Lookout and the Grafana LLM plugin
- **Prometheus, Loki and Tempo** (one `grafana/otel-lgtm` container); Tempo turns traces into span metrics
- **A demo shop** ([`demo-shop/shop.py`](demo-shop/shop.py)): `frontend`, `catalog`, `checkout` and `payments`
  sending traces and logs, about 12 requests per second
- **The Grafana Image Renderer**, so panel links in answers show a picture of the panel
- Two dashboards in the **Quickstart** folder: **Shop overview** and **Payments**

The demo has things worth finding:

- Three minutes after start, and then every 15 minutes, the external payment provider slows down and times out
  for 6 minutes. Orders fail, and the failure travels from `payments` through `checkout` to `frontend`.
- `catalog` records "errors" for products that do not exist. They are expected and never reach customers.
- A few customers' cards are declined. That is a normal business outcome, logged as INFO.

For local trial only: anyone who opens this Grafana is an admin.

## Run it

```sh
# from the repository root: build the plugin once
npm ci && npm run build && go run github.com/magefile/mage@v1.15.0 -v

cd examples/quickstart
docker compose up -d --build
```

1. Open http://localhost:3000 and go to **Apps → Lookout → Setup**.
2. Choose a model provider, paste an API key and click **Save and test**.
3. Open **Dashboards → Quickstart → Shop overview** and click **Ask Lookout AI** in the dashboard sidebar.

Wait about five minutes after start so the first incident has happened and there is some history.

## Things to ask

- "Checkout is failing for customers. What's going on?" (during an incident)
- "Catalog keeps recording errors on SELECT products. Is that a real problem for customers?"
- "Is there a dashboard for payment provider latency? Link me to the right panel."
- "Write me a PromQL query for the p95 latency of each checkout endpoint and open it in Explore."
- "How many errors did payments log in the last 15 minutes, and what do they have in common?"
- Panel menu → **Extensions → Explain with AI** on any panel
- Change the **Service** variable, then ask "And this one?"

## Change the demo

Set environment variables on `demo-shop` in `docker-compose.yaml`:

| Variable                   | Default | Meaning                                                       |
| -------------------------- | ------- | ------------------------------------------------------------- |
| `REQUESTS_PER_SECOND`      | `12`    | Traffic volume                                                |
| `INCIDENT_FIRST_AFTER_MIN` | `3`     | Minutes after start until the first payment provider incident |
| `INCIDENT_EVERY_MIN`       | `15`    | Minutes between incident starts                               |
| `INCIDENT_DURATION_MIN`    | `6`     | How long each incident lasts                                  |

Stop with `docker compose down`.
