-- Firefly schema (Tiger Data: Postgres + TimescaleDB), database "firefly".
-- Owner: P3. Reconcile column names with the team plan's "Database: Tiger Data" section.
-- Safe to re-run: every statement is idempotent.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------- Regular tables ----------

CREATE TABLE IF NOT EXISTS users (
  user_id          TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  contacts         JSONB NOT NULL,            -- [{ "name": "Mom", "phone": "+15551234567" }]
  code_phrase      TEXT NOT NULL,
  pin_hash         TEXT NOT NULL,
  duress_pin_hash  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS walks (
  walk_id          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  start_lat        DOUBLE PRECISION NOT NULL,
  start_lng        DOUBLE PRECISION NOT NULL,
  dest_lat         DOUBLE PRECISION NOT NULL,
  dest_lng         DOUBLE PRECISION NOT NULL,
  dest_label       TEXT,
  route            JSONB NOT NULL,            -- [[lat, lng], ...]
  distance_m       INTEGER NOT NULL,
  eta_s            INTEGER NOT NULL,
  share_token      TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'walking'
                   CHECK (status IN ('walking', 'alert', 'home_safe', 'ended')),
  clip_url         TEXT,
  last_alert_at    TIMESTAMPTZ,               -- 60-second duplicate-alert guard
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS walks_user_idx ON walks (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  memory_id        BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  walk_id          TEXT REFERENCES walks(walk_id),
  fact             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, created_at DESC);

-- Alert clips when not using S3 (e.g. hosted on Render). Max 2 MB each; removed after 2 days.
CREATE TABLE IF NOT EXISTS clips (
  walk_id          TEXT NOT NULL REFERENCES walks(walk_id) ON DELETE CASCADE,
  file             TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  data             BYTEA NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (walk_id, file)
);

-- Open WebSocket connections from tracking pages (API Gateway WebSocket API).
CREATE TABLE IF NOT EXISTS ws_connections (
  connection_id    TEXT PRIMARY KEY,
  walk_id          TEXT NOT NULL REFERENCES walks(walk_id) ON DELETE CASCADE,
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ws_connections_walk_idx ON ws_connections (walk_id);

-- ---------- Hypertables ----------

CREATE TABLE IF NOT EXISTS locations (
  ts               TIMESTAMPTZ NOT NULL,
  walk_id          TEXT NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  accuracy_m       REAL,
  off_route_m      REAL,
  remaining_m      REAL,
  eta_s            INTEGER
);
SELECT create_hypertable('locations', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS locations_walk_ts_idx ON locations (walk_id, ts DESC);

CREATE TABLE IF NOT EXISTS walk_events (
  ts               TIMESTAMPTZ NOT NULL,
  walk_id          TEXT NOT NULL,
  type             TEXT NOT NULL,             -- check_in, countdown_*, alert_sent, duress, arrived, ...
  source           TEXT,                      -- scream, code_phrase, countdown, manual, ...
  confidence       REAL,
  clip_url         TEXT,
  texted           TEXT[],                    -- phone numbers texted for this event
  data             JSONB                      -- anything else the client sent
);
SELECT create_hypertable('walk_events', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS walk_events_walk_ts_idx ON walk_events (walk_id, ts DESC);

CREATE TABLE IF NOT EXISTS conversation_turns (
  ts               TIMESTAMPTZ NOT NULL,
  walk_id          TEXT NOT NULL,
  role             TEXT NOT NULL,             -- user | assistant
  text             TEXT NOT NULL,
  data             JSONB
);
SELECT create_hypertable('conversation_turns', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS conversation_turns_walk_ts_idx ON conversation_turns (walk_id, ts DESC);

CREATE TABLE IF NOT EXISTS detector_scores (
  ts               TIMESTAMPTZ NOT NULL,
  walk_id          TEXT NOT NULL,
  score            REAL NOT NULL,             -- numbers only, never audio
  label            TEXT
);
SELECT create_hypertable('detector_scores', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS detector_scores_walk_ts_idx ON detector_scores (walk_id, ts DESC);

-- ---------- Continuous aggregates ----------
-- materialized_only = false: real-time aggregation, so fresh rows show up before the refresh job runs.

CREATE MATERIALIZED VIEW IF NOT EXISTS alerts_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket,
       type,
       count(*)                           AS events,
       count(DISTINCT walk_id)            AS walks
FROM walk_events
WHERE type IN ('alert_sent', 'duress')
GROUP BY bucket, type
WITH NO DATA;

SELECT add_continuous_aggregate_policy('alerts_hourly',
  start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS scores_minutely
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       walk_id,
       max(score)  AS max_score,
       avg(score)  AS avg_score,
       count(*)    AS samples
FROM detector_scores
GROUP BY bucket, walk_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('scores_minutely',
  start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- ---------- Retention ----------

SELECT add_retention_policy('conversation_turns', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('detector_scores',    INTERVAL '7 days', if_not_exists => TRUE);
