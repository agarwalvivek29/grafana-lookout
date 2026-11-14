package plugin

import (
	"context"
	"net/http"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// Make sure App implements required interfaces. This is important to do
// since otherwise we will only get a not implemented error response from plugin in
// runtime. Plugin should not implement all these interfaces - only those which are
// required for a particular task.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is an example app plugin with a backend which can respond to data queries.
type App struct {
	backend.CallResourceHandler

	// sessions is nil when no history database is configured or it could not be reached.
	sessions   SessionStore
	historyErr string
}

// historyDatabaseURLKey is the secure setting that holds the Postgres URL for conversation history.
const historyDatabaseURLKey = "historyDatabaseUrl"

// NewApp creates the app instance. Grafana creates a new one whenever the plugin settings change.
func NewApp(ctx context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	var app App

	if url := settings.DecryptedSecureJSONData[historyDatabaseURLKey]; url != "" {
		// A database that is down must not stop the plugin from loading: chat works without history.
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		store, err := NewPostgresStore(cctx, url)
		cancel()
		if err != nil {
			log.DefaultLogger.Error("conversation history disabled: cannot use the history database", "error", err)
			app.historyErr = "Cannot use the history database: " + err.Error()
		} else {
			app.sessions = store
		}
	}

	// Use a httpadapter (provided by the SDK) for resource calls. This allows us
	// to use a *http.ServeMux for resource calls, so we can map multiple routes
	// to CallResource without having to implement extra logic.
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	return &app, nil
}

// Dispose here tells plugin SDK that plugin wants to clean up resources when a new instance
// created.
func (a *App) Dispose() {
	if a.sessions != nil {
		a.sessions.Close()
	}
}

// CheckHealth handles health checks sent from Grafana to the plugin.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "ok",
	}, nil
}
