SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        report_json TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS projects (
        project_id BIGINT PRIMARY KEY,
        title TEXT NOT NULL,
        description_hash TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT,
        first_seen_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        score INTEGER,
        decision TEXT,
        selected_account BIGINT,
        bid_amount DOUBLE PRECISION,
        delivery_days INTEGER,
        proposal TEXT,
        api_result TEXT,
        error TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS decisions (
        project_id BIGINT PRIMARY KEY,
        run_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        decision TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        selected_account BIGINT,
        bid_amount DOUBLE PRECISION,
        delivery_days INTEGER,
        proposal TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bids (
        project_id BIGINT PRIMARY KEY,
        run_id TEXT NOT NULL,
        account_id BIGINT NOT NULL,
        status TEXT NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        delivery_days INTEGER NOT NULL,
        proposal TEXT NOT NULL,
        api_result TEXT,
        error TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS accounts (
        account_id BIGINT PRIMARY KEY,
        username TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        bids_used INTEGER NOT NULL DEFAULT 0,
        bids_remaining INTEGER,
        last_bid_at TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        profile_tags_json TEXT NOT NULL DEFAULT '[]',
        rating DOUBLE PRECISION
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_bids_created_at ON bids(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_bids_account_created ON bids(account_id, created_at)",
)

