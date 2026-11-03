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

-- Additive delivery orchestration. Contains no provider credentials.
CREATE TABLE delivery_preflights (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 revision INTEGER NOT NULL, storage_version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 expires_at TEXT NOT NULL, used_by TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,id)
);
CREATE TABLE delivery_attempts (
 owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 revision INTEGER NOT NULL, preflight_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(owner_id,operation_id),
 UNIQUE(owner_id,source_id,external_id,revision), UNIQUE(owner_id,preflight_id)
);

CREATE TABLE IF NOT EXISTS platform_messages (
 owner_id TEXT NOT NULL, source_id TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT NOT NULL,
 received_at TEXT NOT NULL, recorded_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 external_id TEXT NOT NULL, panel_viewed_at TEXT,
 PRIMARY KEY(owner_id,source_id,account_id,message_id)
);
CREATE INDEX IF NOT EXISTS platform_messages_recent ON platform_messages(owner_id,received_at,source_id,account_id,message_id);
CREATE TABLE IF NOT EXISTS inbox_sync_state (
 owner_id TEXT NOT NULL, channel TEXT NOT NULL, config_fingerprint TEXT NOT NULL, mailbox TEXT NOT NULL,
 page_cursor TEXT, initial_complete INTEGER NOT NULL DEFAULT 0 CHECK(initial_complete IN (0,1)),
 lease_id TEXT, lease_until TEXT, status TEXT NOT NULL, last_attempt TEXT, last_success TEXT,
 error_code TEXT, retry_after_seconds INTEGER CHECK(retry_after_seconds IS NULL OR retry_after_seconds BETWEEN 0 AND 86400), imported INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
 skip_reasons TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(skip_reasons)),
 PRIMARY KEY(owner_id,channel)
);
CREATE TABLE IF NOT EXISTS mail_provider_provenance (
 owner_id TEXT NOT NULL, mailbox TEXT NOT NULL, message_id TEXT NOT NULL,
 verified_at TEXT NOT NULL, receipt_to_storage_ms INTEGER,
 PRIMARY KEY(owner_id,mailbox,message_id),
 CHECK(receipt_to_storage_ms IS NULL OR receipt_to_storage_ms>=0)
);
