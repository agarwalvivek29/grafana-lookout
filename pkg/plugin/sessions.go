package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Conversation history (ROADMAP 0.2). Sessions are stored in a Postgres database the admin configures on the
// Setup page; Grafana gives plugins no shared database of their own. A session belongs to one user in one org
// and is private until its owner shares it, after which anyone in the same org can open it by link.

// ErrNotFound means the session does not exist or the caller may not see it (the two are not told apart).
var ErrNotFound = errors.New("session not found")

// ErrForbidden means the session exists but belongs to someone else.
var ErrForbidden = errors.New("session belongs to another user")

// ErrConflict means the session was saved from somewhere else (another tab) since the caller last read it.
var ErrConflict = errors.New("this conversation was changed elsewhere since it was loaded")

// Owner identifies the signed-in Grafana user making a request.
type Owner struct {
	// Namespace is Grafana's name for the organization ("default" for the main org, "org-2", ...).
	Namespace string
	Login     string
	Name      string
}

// SessionSummary is one row of the history list.
type SessionSummary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Shared    bool      `json:"shared"`
	TurnCount int       `json:"turn_count"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Session is a full saved conversation. Data is the browser's own JSON (turns and model history), stored as is.
type Session struct {
	SessionSummary
	OwnerName string `json:"owner_name"`
	IsOwner   bool   `json:"is_owner"`
	// Version goes up by one on every save; a save must name the version it builds on.
	Version int64           `json:"version"`
	Data    json.RawMessage `json:"data"`
}

// SessionUpdate is a save from the browser. An empty Title keeps the stored one. BaseVersion is the version
// the browser loaded or last saved (0 for a conversation it has never saved); a mismatch is ErrConflict.
type SessionUpdate struct {
	BaseVersion int64           `json:"base_version"`
	Title       string          `json:"title"`
	TurnCount   int             `json:"turn_count"`
	Data        json.RawMessage `json:"data"`
}

// SessionPatch changes metadata only. Nil fields are left as they are.
type SessionPatch struct {
	Title  *string `json:"title"`
	Shared *bool   `json:"shared"`
}

// SessionStore is the storage behind the /sessions routes.
type SessionStore interface {
	List(ctx context.Context, o Owner, query string, limit int) ([]SessionSummary, error)
	Get(ctx context.Context, o Owner, id string) (*Session, error)
	// Save stores the conversation and returns its new version.
	Save(ctx context.Context, o Owner, id string, u SessionUpdate) (int64, error)
	Patch(ctx context.Context, o Owner, id string, p SessionPatch) error
	Delete(ctx context.Context, o Owner, id string) error
	Close()
}

const schema = `
CREATE TABLE IF NOT EXISTS lookout_sessions (
	id          text PRIMARY KEY,
	namespace   text NOT NULL,
	owner       text NOT NULL,
	owner_name  text NOT NULL DEFAULT '',
	title       text NOT NULL DEFAULT '',
	shared      boolean NOT NULL DEFAULT false,
	turn_count  integer NOT NULL DEFAULT 0,
	created_at  timestamptz NOT NULL DEFAULT now(),
	updated_at  timestamptz NOT NULL DEFAULT now(),
	version     bigint NOT NULL DEFAULT 1,
	data        jsonb NOT NULL
);
ALTER TABLE lookout_sessions ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS lookout_sessions_owner_idx ON lookout_sessions (namespace, owner, updated_at DESC);
`

type pgStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore connects to the database and creates the table if it is missing.
func NewPostgresStore(ctx context.Context, url string) (SessionStore, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		// pgx echoes the URL (with the password) in parse errors; keep it out of logs and the UI.
		return nil, errors.New("the history database URL is not a valid Postgres connection string")
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, err
	}
	return &pgStore{pool: pool}, nil
}

func (s *pgStore) Close() { s.pool.Close() }

func (s *pgStore) List(ctx context.Context, o Owner, query string, limit int) ([]SessionSummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, title, shared, turn_count, created_at, updated_at
		FROM lookout_sessions
		WHERE namespace = $1 AND owner = $2 AND ($3 = '' OR title ILIKE '%' || $3 || '%')
		ORDER BY updated_at DESC
		LIMIT $4`, o.Namespace, o.Login, escapeLike(query), limit)
	if err != nil {
		return nil, err
	}
	out := []SessionSummary{}
	for rows.Next() {
		var r SessionSummary
		if err := rows.Scan(&r.ID, &r.Title, &r.Shared, &r.TurnCount, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *pgStore) Get(ctx context.Context, o Owner, id string) (*Session, error) {
	var r Session
	var owner string
	err := s.pool.QueryRow(ctx, `
		SELECT id, title, shared, turn_count, created_at, updated_at, owner, owner_name, version, data
		FROM lookout_sessions
		WHERE id = $1 AND namespace = $2 AND (owner = $3 OR shared)`, id, o.Namespace, o.Login).
		Scan(&r.ID, &r.Title, &r.Shared, &r.TurnCount, &r.CreatedAt, &r.UpdatedAt, &owner, &r.OwnerName, &r.Version, &r.Data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.IsOwner = owner == o.Login
	return &r, nil
}

func (s *pgStore) Save(ctx context.Context, o Owner, id string, u SessionUpdate) (int64, error) {
	// The conflict branch only updates a session this user owns, at the version the browser built on, so two tabs
	// continuing the same conversation cannot silently overwrite each other.
	var version int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO lookout_sessions (id, namespace, owner, owner_name, title, turn_count, data)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE SET
			title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE lookout_sessions.title END,
			owner_name = excluded.owner_name,
			turn_count = excluded.turn_count,
			data = excluded.data,
			version = lookout_sessions.version + 1,
			updated_at = now()
		WHERE lookout_sessions.namespace = excluded.namespace AND lookout_sessions.owner = excluded.owner
			AND lookout_sessions.version = $8
		RETURNING version`,
		id, o.Namespace, o.Login, o.Name, u.Title, u.TurnCount, u.Data, u.BaseVersion).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		// Nothing written: either someone else's session, or a newer version exists.
		var mine bool
		if err := s.pool.QueryRow(ctx,
			`SELECT namespace = $2 AND owner = $3 FROM lookout_sessions WHERE id = $1`, id, o.Namespace, o.Login,
		).Scan(&mine); err != nil {
			return 0, err
		}
		if !mine {
			return 0, ErrForbidden
		}
		return 0, ErrConflict
	}
	return version, err
}

func (s *pgStore) Patch(ctx context.Context, o Owner, id string, p SessionPatch) error {
	// Renaming or sharing does not move a session up the list, so updated_at is left alone.
	tag, err := s.pool.Exec(ctx, `
		UPDATE lookout_sessions SET
			title = COALESCE($4, title),
			shared = COALESCE($5, shared)
		WHERE id = $1 AND namespace = $2 AND owner = $3`, id, o.Namespace, o.Login, p.Title, p.Shared)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) Delete(ctx context.Context, o Owner, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM lookout_sessions WHERE id = $1 AND namespace = $2 AND owner = $3`,
		id, o.Namespace, o.Login)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// escapeLike makes the user's search text match literally inside ILIKE.
func escapeLike(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\\' || r == '%' || r == '_' {
			out = append(out, '\\')
		}
		out = append(out, r)
	}
	return string(out)
}
