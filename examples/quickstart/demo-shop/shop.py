"""Simulated online shop that sends OpenTelemetry traces and logs, for trying Lookout.

Services: frontend -> catalog, frontend -> checkout -> payments -> external payment provider.
Every INCIDENT_EVERY_MIN minutes the payment provider slows down and times out for INCIDENT_DURATION_MIN
minutes, so checkout fails. Some errors are expected (products that do not exist), to show the difference
between noise and real failures.
"""

import logging
import os
import random
import time

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode, set_span_in_context

ENDPOINT = os.environ.get("OTLP_ENDPOINT", "lgtm:4317")
RATE = float(os.environ.get("REQUESTS_PER_SECOND", "12"))
EVERY = float(os.environ.get("INCIDENT_EVERY_MIN", "15"))
DURATION = float(os.environ.get("INCIDENT_DURATION_MIN", "6"))
FIRST = float(os.environ.get("INCIDENT_FIRST_AFTER_MIN", "3"))
START = time.time()

SERVICES = ["frontend", "catalog", "checkout", "payments"]
tracers = {}
loggers = {}
for name in SERVICES:
    resource = Resource.create({"service.name": name, "service.namespace": "shop", "deployment.environment": "demo"})
    tp = TracerProvider(resource=resource)
    tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=ENDPOINT, insecure=True)))
    tracers[name] = tp.get_tracer("demo-shop")
    lp = LoggerProvider(resource=resource)
    lp.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=ENDPOINT, insecure=True)))
    log = logging.getLogger(name)
    log.setLevel(logging.INFO)
    log.addHandler(LoggingHandler(level=logging.INFO, logger_provider=lp))
    log.propagate = False
    loggers[name] = log


def incident_active() -> bool:
    minutes = (time.time() - START) / 60 - FIRST
    return minutes >= 0 and (minutes % EVERY) < DURATION


class Clock:
    """Builds spans with explicit timestamps so a whole request can be emitted instantly."""

    def __init__(self):
        self.now = time.time_ns() - 1_500_000_000  # keep the whole request in the past

    def advance(self, ms: float) -> int:
        self.now += int(ms * 1_000_000)
        return self.now


def span(service, name, kind, parent, start, attrs=None):
    ctx = set_span_in_context(parent) if parent is not None else None
    return tracers[service].start_span(name, context=ctx, kind=kind, start_time=start, attributes=attrs or {})


def fail(s, exc_type, message, code=None):
    s.set_status(Status(StatusCode.ERROR, message))
    s.record_exception(Exception(message), attributes={"exception.type": exc_type, "exception.message": message})
    if code:
        s.set_attribute("http.response.status_code", code)


def emit(service, level, message, s):
    with trace.use_span(s, end_on_exit=False):
        loggers[service].log(level, message)


def view_product(clock):
    product = random.randint(1, 400)
    missing = random.random() < 0.04  # links to products that were removed: expected 404s
    root = span("frontend", "GET /product/{id}", SpanKind.SERVER, None, clock.now, {"http.request.method": "GET", "http.route": "/product/{id}"})
    call = span("frontend", "GET catalog /products/{id}", SpanKind.CLIENT, root, clock.advance(2))
    srv = span("catalog", "GET /products/{id}", SpanKind.SERVER, call, clock.advance(1), {"http.route": "/products/{id}"})
    db = span("catalog", "SELECT products", SpanKind.CLIENT, srv, clock.advance(1), {"db.system": "postgresql", "db.operation.name": "SELECT"})
    clock.advance(random.uniform(3, 12))
    if missing:
        fail(db, "NoResultException", f"No product with id {product}")
        emit("catalog", logging.INFO, f"product {product} not found, returning 404", srv)
    db.end(end_time=clock.now)
    srv.set_attribute("http.response.status_code", 404 if missing else 200)
    srv.end(end_time=clock.advance(2))
    call.end(end_time=clock.advance(1))
    root.set_attribute("http.response.status_code", 404 if missing else 200)
    root.end(end_time=clock.advance(random.uniform(5, 20)))


def add_to_cart(clock):
    root = span("frontend", "POST /cart", SpanKind.SERVER, None, clock.now, {"http.request.method": "POST", "http.route": "/cart"})
    call = span("frontend", "POST checkout /cart/items", SpanKind.CLIENT, root, clock.advance(2))
    srv = span("checkout", "POST /cart/items", SpanKind.SERVER, call, clock.advance(1), {"http.route": "/cart/items"})
    cache = span("checkout", "HSET cart", SpanKind.CLIENT, srv, clock.advance(1), {"db.system": "redis"})
    cache.end(end_time=clock.advance(random.uniform(0.5, 2)))
    srv.end(end_time=clock.advance(2))
    call.end(end_time=clock.advance(1))
    root.set_attribute("http.response.status_code", 200)
    root.end(end_time=clock.advance(random.uniform(3, 8)))


def place_order(clock):
    order = f"ord_{random.randint(100000, 999999)}"
    incident = incident_active()
    timeout = incident and random.random() < 0.35
    declined = not timeout and random.random() < 0.03  # customer's card declined: a normal business outcome

    root = span("frontend", "POST /checkout", SpanKind.SERVER, None, clock.now, {"http.request.method": "POST", "http.route": "/checkout"})
    call = span("frontend", "POST checkout /orders", SpanKind.CLIENT, root, clock.advance(2))
    srv = span("checkout", "POST /orders", SpanKind.SERVER, call, clock.advance(1), {"http.route": "/orders"})
    db = span("checkout", "INSERT orders", SpanKind.CLIENT, srv, clock.advance(1), {"db.system": "postgresql", "db.operation.name": "INSERT"})
    db.end(end_time=clock.advance(random.uniform(2, 6)))
    pcall = span("checkout", "POST payments /charges", SpanKind.CLIENT, srv, clock.advance(1))
    psrv = span("payments", "POST /charges", SpanKind.SERVER, pcall, clock.advance(1), {"http.route": "/charges"})
    provider = span("payments", "POST api.payment-provider.example/v1/charge", SpanKind.CLIENT, psrv, clock.advance(1), {"peer.service": "payment-provider", "server.address": "api.payment-provider.example"})

    if timeout:
        clock.advance(1000)
        fail(provider, "PaymentProviderTimeout", "No response from payment provider within 1000 ms")
        provider.end(end_time=clock.now)
        fail(psrv, "PaymentProviderTimeout", "Charge failed: payment provider timed out", 503)
        emit("payments", logging.ERROR, f"ERROR charge failed order_id={order} reason=provider_timeout after=1000ms", psrv)
        psrv.end(end_time=clock.advance(2))
        fail(pcall, "HttpError", "payments returned 503", 503)
        pcall.end(end_time=clock.advance(1))
        fail(srv, "PaymentFailed", f"Order {order} failed: payments returned 503", 502)
        emit("checkout", logging.ERROR, f"ERROR order failed order_id={order} payments_status=503", srv)
        srv.end(end_time=clock.advance(2))
        fail(call, "HttpError", "checkout returned 502", 502)
        call.end(end_time=clock.advance(1))
        fail(root, "HttpError", "checkout failed", 502)
        emit("frontend", logging.WARNING, f"WARN checkout failed for order_id={order}, showing retry page", root)
        root.end(end_time=clock.advance(3))
        return

    clock.advance(random.uniform(600, 950) if incident else random.uniform(80, 220))
    provider.end(end_time=clock.now)
    status = 402 if declined else 200
    psrv.set_attribute("http.response.status_code", status)
    if declined:
        emit("payments", logging.INFO, f"INFO card declined order_id={order}", psrv)
    psrv.end(end_time=clock.advance(2))
    pcall.end(end_time=clock.advance(1))
    srv.set_attribute("http.response.status_code", status)
    emit("checkout", logging.INFO, f"INFO order {'declined' if declined else 'placed'} order_id={order}", srv)
    srv.end(end_time=clock.advance(2))
    call.end(end_time=clock.advance(1))
    root.set_attribute("http.response.status_code", status)
    root.end(end_time=clock.advance(random.uniform(5, 15)))


FLOWS = [(view_product, 0.62), (add_to_cart, 0.23), (place_order, 0.15)]


def main():
    print(f"demo-shop sending to {ENDPOINT}: {RATE} req/s, incident every {EVERY} min for {DURATION} min")
    was = None
    while True:
        started = time.time()
        flow = random.choices([f for f, _ in FLOWS], weights=[w for _, w in FLOWS])[0]
        flow(Clock())
        now = incident_active()
        if now != was:
            print("payment provider incident", "started" if now else "ended", flush=True)
            was = now
        time.sleep(max(0.0, random.expovariate(RATE) - (time.time() - started)))


if __name__ == "__main__":
    main()
