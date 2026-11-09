CREATE TABLE listings (
 owner_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), field_times TEXT NOT NULL DEFAULT '{}',
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, storage_version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(owner_id,source_id,external_id)
);
CREATE TABLE reviews (
 owner_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), storage_version INTEGER NOT NULL DEFAULT 1,
 last_operation TEXT NOT NULL,
 PRIMARY KEY(owner_id,source_id,external_id),
 FOREIGN KEY(owner_id,source_id,external_id) REFERENCES listings(owner_id,source_id,external_id)
);
CREATE TABLE review_events (
 owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, source_id TEXT NOT NULL,
 external_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), request_hash TEXT NOT NULL,
 PRIMARY KEY(owner_id,operation_id)
);
CREATE TABLE scan_runs (
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
 checked_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(owner_id,run_id,source_id)
);
CREATE INDEX scan_runs_latest ON scan_runs(owner_id,source_id,checked_at,recorded_at,run_id);

CREATE TABLE mail_notifications (
 owner_id TEXT NOT NULL, mailbox TEXT NOT NULL, message_id TEXT NOT NULL,
 received_at TEXT NOT NULL, recorded_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 source_id TEXT, external_id TEXT, link_status TEXT NOT NULL CHECK(link_status IN ('exact_url','unresolved','unlinked')),
 panel_viewed_at TEXT,
 PRIMARY KEY(owner_id,mailbox,message_id),
 CHECK((source_id IS NULL AND external_id IS NULL AND link_status!='exact_url') OR (source_id IS NOT NULL AND external_id IS NOT NULL AND link_status='exact_url'))
);
CREATE INDEX mail_notifications_recent ON mail_notifications(owner_id,received_at,mailbox,message_id);

-- Independent correctable accounting; existence retains automated-send guard.
CREATE TABLE delivery_records (
 owner_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), last_operation TEXT NOT NULL,
 PRIMARY KEY(owner_id,source_id,external_id)
);
CREATE TABLE delivery_events (
 owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 version INTEGER NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), request_hash TEXT NOT NULL,
 PRIMARY KEY(owner_id,operation_id)
);
CREATE UNIQUE INDEX delivery_events_version ON delivery_events(owner_id,source_id,external_id,version);
