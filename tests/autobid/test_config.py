import json

import pytest

from autobid.config import ConfigurationError, Settings


def test_settings_are_safe_by_default(monkeypatch):
    monkeypatch.delenv("AUTOBID_ENABLED", raising=False)
    monkeypatch.delenv("DRY_RUN", raising=False)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")

    settings = Settings.from_env()

    assert settings.autobid_enabled is False
    assert settings.dry_run is True
    assert settings.auto_bid_score == 88
    assert settings.review_score == 75


def test_live_mode_requires_explicit_enabled_and_not_dry_run(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://db/autobid")
    monkeypatch.setenv("AUTOBID_ENABLED", "true")
    monkeypatch.setenv("DRY_RUN", "false")

    settings = Settings.from_env()

    assert settings.live_bidding is True


def test_invalid_boolean_is_rejected(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv("DRY_RUN", "sometimes")

    with pytest.raises(ConfigurationError, match="DRY_RUN"):
        Settings.from_env()


def test_account_config_references_token_env_without_storing_token(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.setenv(
        "FREELANCER_ACCOUNTS_JSON",
        json.dumps([
            {
                "account_id": 42,
                "username": "cad_one",
                "token_env": "FREELANCER_ACCOUNT_01_TOKEN",
                "profile_tags": ["dxf", "laser"],
            }
        ]),
    )
    monkeypatch.setenv("FREELANCER_ACCOUNT_01_TOKEN", "super-secret")

    settings = Settings.from_env()

    assert settings.accounts[0].token == "super-secret"
    assert "super-secret" not in repr(settings.accounts[0])

