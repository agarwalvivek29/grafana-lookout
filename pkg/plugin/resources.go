package plugin

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

const (
	// A long investigation with many tool results stays well under this; the browser trims before saving.
	maxSessionBytes = 8 << 20
	maxTitleRunes   = 200
	listLimit       = 200
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// handlePing is an example HTTP GET resource that returns a {"message": "ok"} JSON response.
func (a *App) handlePing(w http.ResponseWriter, req *http.Request) {
	w.Header().Add("Content-Type", "application/json")
	if _, err := w.Write([]byte(`{"message": "ok"}`)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// handleEcho is an example HTTP POST resource that accepts a JSON with a "message" key and
// returns to the client whatever it is sent.
func (a *App) handleEcho(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Add("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// handleHistoryStatus tells the browser whether history is available, and why not when it is not.
func (a *App) handleHistoryStatus(w http.ResponseWriter, req *http.Request) {
	status := map[string]any{"enabled": false}
	pc := backend.PluginConfigFromContext(req.Context())
	switch {
	case a.historyErr != "":
		status["error"] = a.historyErr
	case a.sessions == nil:
		status["error"] = "No history database is configured. An admin can add one on the Lookout Setup page."
	case pc.User == nil || pc.User.Login == "":
		// Anonymous viewers have no identity to keep conversations under.
		status["error"] = "Sign in to keep a history of your conversations."
	default:
		status["enabled"] = true
	}
	writeJSON(w, http.StatusOK, status)
}

func (a *App) handleListSessions(w http.ResponseWriter, req *http.Request) {
	o, ok := a.owner(w, req)
	if !ok {
		return
	}
	rows, err := a.sessions.List(req.Context(), o, strings.TrimSpace(req.URL.Query().Get("q")), listLimit)
	if err != nil {
		a.storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (a *App) handleGetSession(w http.ResponseWriter, req *http.Request) {
	o, id, ok := a.ownerAndID(w, req)
	if !ok {
		return
	}
	s, err := a.sessions.Get(req.Context(), o, id)
	if err != nil {
		a.storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (a *App) handleSaveSession(w http.ResponseWriter, req *http.Request) {
	o, id, ok := a.ownerAndID(w, req)
	if !ok {
		return
	}
	var u SessionUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, maxSessionBytes)).Decode(&u); err != nil {
		http.Error(w, "invalid session body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(u.Data) == 0 || u.Data[0] != '{' {
		http.Error(w, "data must be a JSON object", http.StatusBadRequest)
		return
	}
	u.Title = cleanTitle(u.Title)
	version, err := a.sessions.Save(req.Context(), o, id, u)
	if err != nil {
		a.storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"version": version})
}

func (a *App) handlePatchSession(w http.ResponseWriter, req *http.Request) {
	o, id, ok := a.ownerAndID(w, req)
	if !ok {
		return
	}
	var p SessionPatch
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64<<10)).Decode(&p); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if p.Title != nil {
		t := cleanTitle(*p.Title)
		if t == "" {
			http.Error(w, "title must not be empty", http.StatusBadRequest)
			return
		}
		p.Title = &t
	}
	if err := a.sessions.Patch(req.Context(), o, id, p); err != nil {
		a.storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleDeleteSession(w http.ResponseWriter, req *http.Request) {
	o, id, ok := a.ownerAndID(w, req)
	if !ok {
		return
	}
	if err := a.sessions.Delete(req.Context(), o, id); err != nil {
		a.storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// owner returns the signed-in user, or writes an error when history is off or nobody is signed in.
func (a *App) owner(w http.ResponseWriter, req *http.Request) (Owner, bool) {
	if a.sessions == nil {
		http.Error(w, "conversation history is not configured", http.StatusServiceUnavailable)
		return Owner{}, false
	}
	pc := backend.PluginConfigFromContext(req.Context())
	if pc.User == nil || pc.User.Login == "" {
		http.Error(w, "sign in to use conversation history", http.StatusUnauthorized)
		return Owner{}, false
	}
	name := pc.User.Name
	if name == "" {
		name = pc.User.Login
	}
	if pc.Namespace == "" {
		http.Error(w, "no organization in request", http.StatusBadRequest)
		return Owner{}, false
	}
	return Owner{Namespace: pc.Namespace, Login: pc.User.Login, Name: name}, true
}

func (a *App) ownerAndID(w http.ResponseWriter, req *http.Request) (Owner, string, bool) {
	o, ok := a.owner(w, req)
	if !ok {
		return Owner{}, "", false
	}
	id := req.PathValue("id")
	if !sessionIDPattern.MatchString(id) {
		http.Error(w, "invalid session id", http.StatusBadRequest)
		return Owner{}, "", false
	}
	return o, id, true
}

func (a *App) storeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, ErrForbidden):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, ErrConflict):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		log.DefaultLogger.Error("history database error", "error", err)
		http.Error(w, "history database error", http.StatusInternalServerError)
	}
}

func cleanTitle(t string) string {
	t = strings.Join(strings.Fields(t), " ")
	if utf8.RuneCountInString(t) > maxTitleRunes {
		t = string([]rune(t)[:maxTitleRunes])
	}
	return t
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.DefaultLogger.Error("write response", "error", err)
	}
}

// registerRoutes takes a *http.ServeMux and registers some HTTP handlers.
func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ping", a.handlePing)
	mux.HandleFunc("/echo", a.handleEcho)
	mux.HandleFunc("GET /history/status", a.handleHistoryStatus)
	mux.HandleFunc("GET /sessions", a.handleListSessions)
	mux.HandleFunc("GET /sessions/{id}", a.handleGetSession)
	mux.HandleFunc("PUT /sessions/{id}", a.handleSaveSession)
	mux.HandleFunc("PATCH /sessions/{id}", a.handlePatchSession)
	mux.HandleFunc("DELETE /sessions/{id}", a.handleDeleteSession)
}
