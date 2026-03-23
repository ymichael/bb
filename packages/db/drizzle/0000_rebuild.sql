PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  provider TEXT,
  external_id TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sources (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  path TEXT,
  repo_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0,
  is_git_repo INTEGER NOT NULL DEFAULT 0,
  branch_name TEXT,
  provisioner_id TEXT,
  provisioner_state TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  title TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  merge_base_branch TEXT,
  parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  archived_at INTEGER,
  last_read_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queued_thread_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  input TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  service_tier TEXT,
  reasoning_level TEXT,
  sandbox_mode TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_daemon_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER,
  active_threads TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_daemon_commands (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES host_daemon_sessions(id) ON DELETE SET NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  cursor INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_daemon_cursors (
  host_id TEXT PRIMARY KEY NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hosts_last_seen_idx ON hosts(last_seen_at);
CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(updated_at);
CREATE INDEX IF NOT EXISTS project_sources_project_idx ON project_sources(project_id);
CREATE INDEX IF NOT EXISTS project_sources_host_idx ON project_sources(host_id);
CREATE UNIQUE INDEX IF NOT EXISTS environments_host_path_idx ON environments(host_id, path);
CREATE INDEX IF NOT EXISTS environments_project_idx ON environments(project_id);
CREATE INDEX IF NOT EXISTS environments_status_idx ON environments(status);
CREATE INDEX IF NOT EXISTS threads_project_idx ON threads(project_id);
CREATE INDEX IF NOT EXISTS threads_environment_idx ON threads(environment_id);
CREATE INDEX IF NOT EXISTS threads_parent_idx ON threads(parent_thread_id);
CREATE INDEX IF NOT EXISTS threads_archived_status_idx ON threads(archived_at, status);
CREATE UNIQUE INDEX IF NOT EXISTS events_thread_seq_idx ON events(thread_id, seq);
CREATE INDEX IF NOT EXISTS events_environment_idx ON events(environment_id);
CREATE INDEX IF NOT EXISTS queued_thread_messages_thread_seq_idx ON queued_thread_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS host_daemon_sessions_host_status_idx ON host_daemon_sessions(host_id, status);
CREATE INDEX IF NOT EXISTS host_daemon_sessions_lease_idx ON host_daemon_sessions(lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS host_daemon_commands_host_cursor_idx ON host_daemon_commands(host_id, cursor);
CREATE INDEX IF NOT EXISTS host_daemon_commands_host_state_idx ON host_daemon_commands(host_id, state);
CREATE INDEX IF NOT EXISTS host_daemon_commands_environment_idx ON host_daemon_commands(environment_id);
