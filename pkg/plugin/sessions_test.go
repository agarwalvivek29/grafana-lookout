package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// memStore mirrors pgStore's rules so the HTTP behaviour can be tested without a database.
// The same scenario runs against Postgres when LOOKOUT_TEST_DATABASE_URL is set.
type memRow struct {
	Session
	ns    string
	owner string
}

type memStore struct {
	mu   sync.Mutex
	rows map[string]*memRow
}

func newMemStore() *memStore { return &memStore{rows: map[string]*memRow{}} }

func (m *memStore) Close() {}

func (m *memStore) List(_ context.Context, o Owner, q string, limit int) ([]SessionSummary, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []SessionSummary{}
	for _, r := range m.rows {
		if r.ns == o.Namespace && r.owner == o.Login && strings.Contains(strings.ToLower(r.Title), strings.ToLower(q)) {
			out = append(out, r.SessionSummary)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *memStore) Get(_ context.Context, o Owner, id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.ns != o.Namespace || (r.owner != o.Login && !r.Shared) {
		return nil, ErrNotFound
	}
	s := r.Session
	s.IsOwner = r.owner == o.Login
	return &s, nil
}

func (m *memStore) Save(_ context.Context, o Owner, id string, u SessionUpdate) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	r, ok := m.rows[id]
	if !ok {
		r = &memRow{ns: o.Namespace, owner: o.Login}
		r.ID, r.CreatedAt = id, now
		m.rows[id] = r
	} else if r.ns != o.Namespace || r.owner != o.Login {
		return 0, ErrForbidden
	} else if r.Version != u.BaseVersion {
		return 0, ErrConflict
	}
	if u.Title != "" {
		r.Title = u.Title
	}
	r.Version++
	r.OwnerName, r.TurnCount, r.Data, r.UpdatedAt = o.Name, u.TurnCount, u.Data, now
	return r.Version, nil
}

func (m *memStore) Patch(_ context.Context, o Owner, id string, p SessionPatch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.ns != o.Namespace || r.owner != o.Login {
		return ErrNotFound
	}
	if p.Title != nil {
		r.Title = *p.Title
	}
	if p.Shared != nil {
		r.Shared = *p.Shared
	}
	return nil
}

func (m *memStore) Delete(_ context.Context, o Owner, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.ns != o.Namespace || r.owner != o.Login {
		return ErrNotFound
	}
	delete(m.rows, id)
	return nil
}

func appWithStore(store SessionStore) *App {
	app := &App{sessions: store}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)
	return app
}

type caller struct {
	t    *testing.T
	app  *App
	user *backend.User
	ns   string
}

func (c caller) do(method, path, body string) (int, string) {
	c.t.Helper()
	var r mockCallResourceResponseSender
	err := c.app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{Namespace: c.ns, User: c.user},
		Method:        method,
		Path:          path,
		Body:          []byte(body),
	}, &r)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	return r.response.Status, string(r.response.Body)
}

func (c caller) expect(method, path, body string, status int) string {
	c.t.Helper()
	got, resp := c.do(method, path, body)
	if got != status {
		c.t.Fatalf("%s %s: status %d, want %d (body %s)", method, path, got, status, resp)
	}
	return resp
}

// sessionScenario covers ownership, sharing, renaming, listing and deletion through the HTTP routes.
func sessionScenario(t *testing.T, store SessionStore, prefix string) {
	app := appWithStore(store)
	alice := caller{t, app, &backend.User{Login: prefix + "alice", Name: "Alice"}, "default"}
	bob := caller{t, app, &backend.User{Login: prefix + "bob", Name: "Bob"}, "default"}
	otherOrg := caller{t, app, &backend.User{Login: prefix + "carol", Name: "Carol"}, "org-2"}
	anon := caller{t, app, nil, "default"}
	id := prefix + "session-0001"
	path := "sessions/" + id

	anon.expect(http.MethodGet, "sessions", "", http.StatusUnauthorized)
	alice.expect(http.MethodPut, "sessions/bad!id", `{"data":{}}`, http.StatusBadRequest)
	alice.expect(http.MethodPut, path, `{"data":[1]}`, http.StatusBadRequest)

	if body := alice.expect(http.MethodPut, path, `{"base_version":0,"title":"  Checkout   5xx spike ","turn_count":1,"data":{"turns":[1]}}`, http.StatusOK); !strings.Contains(body, `"version":1`) {
		t.Fatalf("first save: %s", body)
	}
	// A later save without a title keeps the generated one.
	alice.expect(http.MethodPut, path, `{"base_version":1,"turn_count":2,"data":{"turns":[1,2]}}`, http.StatusOK)

	// Two tabs continue the same conversation from version 2: the first save wins, the second is refused
	// instead of overwriting it.
	alice.expect(http.MethodPut, path, `{"base_version":2,"turn_count":3,"data":{"turns":[1,2,3]}}`, http.StatusOK)
	alice.expect(http.MethodPut, path, `{"base_version":2,"turn_count":3,"data":{"turns":[1,2,4]}}`, http.StatusConflict)
	// A brand-new conversation must not land on an existing id either.
	alice.expect(http.MethodPut, path, `{"base_version":0,"data":{}}`, http.StatusConflict)
	alice.expect(http.MethodPut, path, `{"base_version":3,"turn_count":2,"data":{"turns":[1,2]}}`, http.StatusOK)

	var got Session
	if err := json.Unmarshal([]byte(alice.expect(http.MethodGet, path, "", http.StatusOK)), &got); err != nil {
		t.Fatal(err)
	}
	if got.Title != "Checkout 5xx spike" || got.TurnCount != 2 || got.Version != 4 || !got.IsOwner || got.Shared ||
		got.OwnerName != "Alice" {
		t.Fatalf("unexpected session %+v", got)
	}
	var data map[string][]int
	if err := json.Unmarshal(got.Data, &data); err != nil || len(data["turns"]) != 2 {
		t.Fatalf("data not stored as sent: %s", got.Data)
	}

	// Private: other users cannot read, overwrite, rename or delete it.
	bob.expect(http.MethodGet, path, "", http.StatusNotFound)
	bob.expect(http.MethodPut, path, `{"data":{}}`, http.StatusForbidden)
	bob.expect(http.MethodPatch, path, `{"shared":true}`, http.StatusNotFound)
	bob.expect(http.MethodDelete, path, "", http.StatusNotFound)
	if list := bob.expect(http.MethodGet, "sessions", "", http.StatusOK); strings.Contains(list, id) {
		t.Fatalf("bob's list shows alice's session: %s", list)
	}

	// Shared: readable by the org, still only changeable by the owner, and invisible to other orgs.
	alice.expect(http.MethodPatch, path, `{"shared":true,"title":"RCA: checkout"}`, http.StatusNoContent)
	if err := json.Unmarshal([]byte(bob.expect(http.MethodGet, path, "", http.StatusOK)), &got); err != nil {
		t.Fatal(err)
	}
	if got.IsOwner || !got.Shared || got.Title != "RCA: checkout" {
		t.Fatalf("shared view wrong: %+v", got)
	}
	bob.expect(http.MethodPut, path, `{"data":{}}`, http.StatusForbidden)
	otherOrg.expect(http.MethodGet, path, "", http.StatusNotFound)
	alice.expect(http.MethodPatch, path, `{"title":"   "}`, http.StatusBadRequest)

	// Search matches the title literally; % is not a wildcard.
	if list := alice.expect(http.MethodGet, "sessions?q=rca", "", http.StatusOK); !strings.Contains(list, id) {
		t.Fatalf("search missed the session: %s", list)
	}
	if list := alice.expect(http.MethodGet, "sessions?q=%25", "", http.StatusOK); strings.Contains(list, id) {
		t.Fatalf("%% matched as a wildcard: %s", list)
	}

	alice.expect(http.MethodDelete, path, "", http.StatusNoContent)
	alice.expect(http.MethodGet, path, "", http.StatusNotFound)
}

func TestSessionsInMemory(t *testing.T) {
	sessionScenario(t, newMemStore(), "")
}

func TestSessionsPostgres(t *testing.T) {
	url := os.Getenv("LOOKOUT_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set LOOKOUT_TEST_DATABASE_URL to run against Postgres")
	}
	store, err := NewPostgresStore(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sessionScenario(t, store, time.Now().Format("150405000")+"-")
}

func TestHistoryDisabled(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatal(err)
	}
	c := caller{t, inst.(*App), &backend.User{Login: "alice"}, "default"}
	if body := c.expect(http.MethodGet, "history/status", "", http.StatusOK); !strings.Contains(body, `"enabled":false`) {
		t.Fatalf("status: %s", body)
	}
	c.expect(http.MethodGet, "sessions", "", http.StatusServiceUnavailable)
}

func TestBadDatabaseURLDoesNotLeakPassword(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		DecryptedSecureJSONData: map[string]string{historyDatabaseURLKey: "postgres://u:s3cret@host:notaport/db"},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := caller{t, inst.(*App), &backend.User{Login: "alice"}, "default"}
	if body := c.expect(http.MethodGet, "history/status", "", http.StatusOK); strings.Contains(body, "s3cret") {
		t.Fatalf("status leaks the password: %s", body)
	}
}
