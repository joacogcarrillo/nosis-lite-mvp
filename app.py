from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
APP_VERSION = "0.7.0"
BCRA_API_BASE_URL = os.environ.get("BCRA_API_BASE_URL", "https://api.bcra.gob.ar/centraldedeudores/v1.0")
BCRA_MODE = os.environ.get("BCRA_MODE", "auto").lower()
BCRA_CACHE_TTL_SECONDS = int(os.environ.get("BCRA_CACHE_TTL_SECONDS", "86400"))
BCRA_MAX_RETRIES = int(os.environ.get("BCRA_MAX_RETRIES", "3"))
BCRA_BACKOFF_SECONDS = float(os.environ.get("BCRA_BACKOFF_SECONDS", "1.0"))
BCRA_MIN_INTERVAL_SECONDS = float(os.environ.get("BCRA_MIN_INTERVAL_SECONDS", "1.0"))
BULK_MAX_IDS = int(os.environ.get("BULK_MAX_IDS", "500"))
BCRA_SITUATION_LABELS = {
    1: "normal",
    2: "low_risk",
    3: "medium_risk",
    4: "high_risk",
    5: "irrecoverable",
    6: "irrecoverable_technical",
}
BCRA_SITUATION_DESCRIPTIONS = {
    1: "Normal",
    2: "Riesgo bajo",
    3: "Riesgo medio",
    4: "Riesgo alto",
    5: "Irrecuperable",
    6: "Irrecuperable por disposición técnica",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_tax_id(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) != 11:
        raise ValueError("tax_id must contain exactly 11 digits")
    return digits


def is_valid_cuit(value: str) -> bool:
    return calculate_check_digit(value) == int(normalize_tax_id(value)[-1])


def calculate_check_digit(value: str) -> int:
    digits = normalize_tax_id(value)
    weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
    total = sum(int(digits[i]) * weights[i] for i in range(10))
    check = 11 - (total % 11)
    if check == 11:
        check = 0
    elif check == 10:
        check = 9
    return check


def format_tax_id(tax_id: str) -> str:
    digits = normalize_tax_id(tax_id)
    return f"{digits[:2]}-{digits[2:10]}-{digits[10]}"


def infer_subject_kind(tax_id: str) -> str:
    prefix = tax_id[:2]
    if prefix in {"20", "23", "24", "27"}:
        return "person"
    if prefix in {"30", "33", "34"}:
        return "company"
    return "unknown"


def infer_tax_id_type(tax_id: str) -> str:
    """Return the Argentine identifier family implied by its prefix."""
    prefix = normalize_tax_id(tax_id)[:2]
    if prefix in {"20", "23", "24", "27"}:
        return "CUIL"
    if prefix in {"30", "33", "34"}:
        return "CUIT"
    return "unknown"


def period_sort_key(period: str | None) -> str:
    return re.sub(r"\D", "", period or "")


def source_age_seconds(fetched_at: str) -> int | None:
    try:
        parsed = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
    except (TypeError, ValueError):
        return None


def normalize_rejected_checks(value: Any, context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    context = context or {}
    if not value:
        return []
    if isinstance(value, list):
        return [item for entry in value for item in normalize_rejected_checks(entry, context)]
    if not isinstance(value, dict):
        return []
    next_context = {
        "reason": value.get("causal") or value.get("detalle") or context.get("reason"),
        "entity": value.get("entidad") or value.get("denominacionEntidad") or context.get("entity"),
    }
    nested = []
    for key in ("causales", "entidades", "rechazados", "cheques", "chequesRechazados", "cheques_rechazados"):
        nested.extend(normalize_rejected_checks(value.get(key), next_context))
    is_check = any(value.get(key) is not None for key in (
        "fechaRechazo", "periodo", "nroCheque", "numeroCheque", "monto", "importe", "cantidad", "count"
    ))
    if not is_check:
        return nested
    return [{
        "period": value.get("periodo") or value.get("fechaRechazo"),
        "entity": next_context["entity"],
        "reason": next_context["reason"],
        "count": value.get("cantidad", value.get("count", 1)),
        "amount_ars": value.get("monto", value.get("importe", 0)),
        "check_number": value.get("nroCheque") or value.get("numeroCheque"),
        "paid_at": value.get("fechaPago"),
    }, *nested]


def load_fixture(name: str) -> dict[str, Any]:
    path = FIXTURES / name
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


class ResponseCache:
    def __init__(self, path: Path) -> None:
        DATA.mkdir(exist_ok=True)
        self.path = path
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS response_cache (
                    provider TEXT NOT NULL,
                    tax_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    fetched_at REAL NOT NULL,
                    PRIMARY KEY (provider, tax_id)
                )
                """
            )

    def get(self, provider: str, tax_id: str, ttl_seconds: int) -> tuple[dict[str, Any] | None, float | None]:
        with sqlite3.connect(self.path) as conn:
            row = conn.execute(
                "SELECT payload, fetched_at FROM response_cache WHERE provider = ? AND tax_id = ?",
                (provider, tax_id),
            ).fetchone()
        if not row:
            return None, None
        payload, fetched_at = row
        if time.time() - fetched_at > ttl_seconds:
            return None, fetched_at
        return json.loads(payload), fetched_at

    def set(self, provider: str, tax_id: str, payload: dict[str, Any]) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                """
                INSERT INTO response_cache (provider, tax_id, payload, fetched_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(provider, tax_id) DO UPDATE SET
                    payload = excluded.payload,
                    fetched_at = excluded.fetched_at
                """,
                (provider, tax_id, json.dumps(payload, ensure_ascii=False), time.time()),
            )


class RateLimiter:
    def __init__(self, min_interval_seconds: float) -> None:
        self.min_interval_seconds = min_interval_seconds
        self.last_call = 0.0

    def wait(self) -> None:
        elapsed = time.time() - self.last_call
        remaining = self.min_interval_seconds - elapsed
        if remaining > 0:
            time.sleep(remaining)
        self.last_call = time.time()


@dataclass
class SourceTrace:
    name: str
    status: str
    fetched_at: str
    mode: str = "fixture"
    message: str | None = None


class FixtureArcaProvider:
    def __init__(self) -> None:
        self.records = load_fixture("arca_subjects.json")

    def get_registration(self, tax_id: str) -> tuple[dict[str, Any] | None, SourceTrace]:
        record = self.records.get(tax_id)
        trace = SourceTrace(name="arca", status="ok" if record else "not_found", fetched_at=utc_now())
        return record, trace


class FixtureBcraProvider:
    def __init__(self) -> None:
        self.records = load_fixture("bcra_debtors.json")

    def get_debtor_situation(self, tax_id: str) -> tuple[dict[str, Any] | None, SourceTrace]:
        record = self.records.get(tax_id)
        trace = SourceTrace(name="bcra", status="ok" if record else "not_found", fetched_at=utc_now())
        return record, trace


class LiveBcraProvider:
    def __init__(self, fallback: FixtureBcraProvider | None = None) -> None:
        self.fallback = fallback
        self.base_url = BCRA_API_BASE_URL.rstrip("/")
        self.cache = ResponseCache(DATA / "cache.db")
        self.rate_limiter = RateLimiter(BCRA_MIN_INTERVAL_SECONDS)

    def get_debtor_situation(self, tax_id: str) -> tuple[dict[str, Any] | None, SourceTrace]:
        cached, cached_at = self.cache.get("bcra", tax_id, BCRA_CACHE_TTL_SECONDS)
        if cached:
            return cached, SourceTrace(
                name="bcra",
                status="cache",
                fetched_at=datetime.fromtimestamp(cached_at, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                mode="cache",
                message=f"Cache hit from {datetime.fromtimestamp(cached_at, timezone.utc).isoformat()}",
            )

        url = f"{self.base_url}/Deudas/{tax_id}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "NosisLiteMvp/0.3 (+local-mvp)",
            },
        )
        last_error = ""
        for attempt in range(1, BCRA_MAX_RETRIES + 1):
            self.rate_limiter.wait()
            try:
                with urllib.request.urlopen(request, timeout=12) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                checks_payload = self._fetch_rejected_checks(tax_id)
                normalized = self._normalize_response(payload, checks_payload)
                self.cache.set("bcra", tax_id, normalized)
                return normalized, SourceTrace(
                    name="bcra",
                    status="ok",
                    fetched_at=utc_now(),
                    mode="live",
                    message=f"Fetched from {url} on attempt {attempt}",
                )
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    return self._fallback_or_none(tax_id, f"BCRA live returned 404 for {tax_id}")
                last_error = f"BCRA live HTTP {exc.code}"
            except (TimeoutError, urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
                last_error = f"BCRA live unavailable: {exc}"
            if attempt < BCRA_MAX_RETRIES:
                time.sleep(BCRA_BACKOFF_SECONDS * attempt)

        stale, stale_at = self.cache.get("bcra", tax_id, 10 * 365 * 24 * 60 * 60)
        if stale:
            return stale, SourceTrace(
                name="bcra",
                status="stale_cache",
                fetched_at=utc_now(),
                mode="cache",
                message=f"{last_error}; served stale cache from {datetime.fromtimestamp(stale_at, timezone.utc).isoformat()}",
            )
        return self._fallback_or_none(tax_id, last_error)

    def _fetch_rejected_checks(self, tax_id: str) -> dict[str, Any]:
        """Rejected checks are exposed by BCRA as a separate product."""
        url = f"{self.base_url}/ChequesRechazados/{tax_id}"
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "NosisLiteMvp/0.7"})
        try:
            self.rate_limiter.wait()
            with urllib.request.urlopen(request, timeout=12) as response:
                return {"status": "ok", "payload": json.loads(response.read().decode("utf-8"))}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {"status": "not_found", "payload": None}
            return {"status": "unavailable", "payload": None, "message": f"HTTP {exc.code}"}
        except (TimeoutError, urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            return {"status": "unavailable", "payload": None, "message": str(exc)}

    def _fallback_or_none(self, tax_id: str, message: str) -> tuple[dict[str, Any] | None, SourceTrace]:
        if self.fallback:
            record, _trace = self.fallback.get_debtor_situation(tax_id)
            return record, SourceTrace(
                name="bcra",
                status="fallback" if record else "not_found",
                fetched_at=utc_now(),
                mode="fixture",
                message=message,
            )
        return None, SourceTrace(name="bcra", status="not_found", fetched_at=utc_now(), mode="live", message=message)

    @staticmethod
    def _normalize_response(
        payload: dict[str, Any], checks_payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        result = payload.get("results") or {}
        periods = result.get("periodos") or []
        debts = []
        for period in periods:
            period_id = str(period.get("periodo", ""))
            formatted_period = f"{period_id[:4]}-{period_id[4:]}" if len(period_id) == 6 else period_id
            for entity in period.get("entidades") or []:
                debts.append(
                    {
                        "entity": entity.get("entidad"),
                        "period": formatted_period,
                        "situation": entity.get("situacion"),
                        "amount_ars": entity.get("monto", 0),
                        "days_late": entity.get("diasAtrasoPago"),
                        "refinanced": entity.get("refinanciaciones"),
                    }
                )

        checks_response = checks_payload if checks_payload and "status" in checks_payload else {
            "status": "ok" if checks_payload else "not_found", "payload": checks_payload
        }
        raw_checks = (checks_response.get("payload") or {}).get("results") or result.get("chequesRechazados") or result.get("cheques_rechazados") or []
        rejected_checks = normalize_rejected_checks(raw_checks)

        return {
            "summary": f"BCRA live record for {result.get('denominacion') or result.get('identificacion')}.",
            "denomination": result.get("denominacion"),
            "debts": debts,
            "rejected_checks": rejected_checks,
            "rejected_checks_status": checks_response["status"],
            "rejected_checks_message": checks_response.get("message"),
            "raw_period_count": len(periods),
        }


class CheckService:
    def __init__(self) -> None:
        self.arca = FixtureArcaProvider()
        fixture_bcra = FixtureBcraProvider()
        self.bcra = LiveBcraProvider(fallback=fixture_bcra) if BCRA_MODE in {"auto", "live"} else fixture_bcra

    def build_subject(self, raw_tax_id: str) -> dict[str, Any]:
        tax_id = normalize_tax_id(raw_tax_id)
        valid = is_valid_cuit(tax_id)
        arca, arca_trace = self.arca.get_registration(tax_id)
        bcra, bcra_trace = self.bcra.get_debtor_situation(tax_id)

        subject = {
            "tax_id": tax_id,
            "formatted_tax_id": format_tax_id(tax_id),
            "valid": valid,
            "kind": infer_subject_kind(tax_id),
            "name": (arca.get("name") if arca else None) or (bcra.get("denomination") if bcra else None),
            "registration_status": arca.get("registration_status") if arca else "unknown",
            "activities": arca.get("activities", []) if arca else [],
            "tax_tags": arca.get("tax_tags", []) if arca else [],
        }

        risk = self._build_risk(bcra)
        sources = [asdict(arca_trace), asdict(bcra_trace)]
        return {
            "tax_id": tax_id,
            "valid": valid,
            "subject": subject,
            "risk": risk,
            "checks": self._build_easy_checks(tax_id, subject, risk, sources),
            "sources": sources,
        }

    def create_check(self, payload: dict[str, Any]) -> dict[str, Any]:
        tax_id = normalize_tax_id(str(payload.get("tax_id", "")))
        requested = payload.get("checks") or ["format", "arca_registration", "bcra_debtors"]
        subject = self.build_subject(tax_id)
        result = {
            "id": f"chk_{tax_id}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "created_at": utc_now(),
            "requested_checks": requested,
            "status": "completed",
            "result": subject,
        }
        return result

    def create_bulk_check(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_tax_ids = payload.get("tax_ids", [])
        if isinstance(raw_tax_ids, str):
            raw_tax_ids = re.split(r"[\s,;]+", raw_tax_ids)
        if not isinstance(raw_tax_ids, list):
            raise ValueError("tax_ids must be an array or a text list")

        cleaned = [str(item).strip() for item in raw_tax_ids if str(item).strip()]
        if not cleaned:
            raise ValueError("At least one tax_id is required")
        if len(cleaned) > BULK_MAX_IDS:
            raise ValueError(f"Bulk checks are limited to {BULK_MAX_IDS} identifiers per request")

        results = []
        errors = []
        seen: dict[str, int] = {}
        for raw_tax_id in cleaned:
            try:
                normalized = normalize_tax_id(raw_tax_id)
                seen[normalized] = seen.get(normalized, 0) + 1
                result = self.build_subject(normalized)
                result["checks"]["local_integrity"]["duplicate_in_request"] = seen[normalized] > 1
                result["checks"]["local_integrity"]["request_occurrence"] = seen[normalized]
                results.append(result)
            except ValueError as exc:
                errors.append({"tax_id": raw_tax_id, "error": str(exc)})

        return {
            "id": f"bulk_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "created_at": utc_now(),
            "requested_count": len(cleaned),
            "completed_count": len(results),
            "error_count": len(errors),
            "results": results,
            "errors": errors,
        }

    @staticmethod
    def _build_risk(bcra: dict[str, Any] | None) -> dict[str, Any]:
        if not bcra:
            return {
                "has_bcra_debt": False,
                "bcra_worst_situation": None,
                "bcra_worst_situation_label": None,
                "bcra_worst_situation_description": None,
                "reporting_entities": 0,
                "has_rejected_checks": False,
                "rejected_checks_count": 0,
                "rejected_checks_amount_ars": 0,
                "debt_amount_ars": 0,
                "summary": "No fixture BCRA record found.",
            }

        situations = [item.get("situation", 0) for item in bcra.get("debts", [])]
        historical_worst = max(situations) if situations else None
        rejected_checks = bcra.get("rejected_checks", [])
        debts = bcra.get("debts", [])
        entities = {item.get("entity") for item in debts if item.get("entity")}
        periods = sorted({item.get("period") for item in debts if item.get("period")}, key=period_sort_key, reverse=True)
        latest_period = periods[0] if periods else None
        latest_debts = [item for item in debts if item.get("period") == latest_period] if latest_period else debts
        worst = max((item.get("situation", 0) for item in latest_debts), default=None)
        historical = []
        for period in periods:
            rows = [item for item in debts if item.get("period") == period]
            historical.append({
                "period": period,
                "entity_count": len({item.get("entity") for item in rows if item.get("entity")}),
                "debt_amount_ars": sum(item.get("amount_ars", 0) for item in rows),
                "worst_situation": max((item.get("situation", 0) for item in rows), default=None),
            })
        return {
            "has_bcra_debt": bool(bcra.get("debts")),
            "bcra_worst_situation": worst,
            "bcra_worst_situation_label": BCRA_SITUATION_LABELS.get(worst),
            "bcra_worst_situation_description": BCRA_SITUATION_DESCRIPTIONS.get(worst),
            "bcra_historical_worst_situation": historical_worst,
            "reporting_entities": len(entities),
            "has_rejected_checks": bool(rejected_checks),
            "rejected_checks_count": sum(item.get("count", 0) for item in rejected_checks),
            "rejected_checks_amount_ars": sum(item.get("amount_ars", 0) for item in rejected_checks),
            "debt_amount_ars": sum(item.get("amount_ars", 0) for item in latest_debts),
            "latest_period": latest_period,
            "period_count": len(periods),
            "history": historical,
            "entities": sorted(entities),
            "entity_details": debts,
            "rejected_checks": rejected_checks,
            "rejected_checks_status": bcra.get("rejected_checks_status", "fixture"),
            "rejected_checks_message": bcra.get("rejected_checks_message"),
            "summary": bcra.get("summary"),
        }

    @staticmethod
    def _build_easy_checks(
        tax_id: str,
        subject: dict[str, Any],
        risk: dict[str, Any],
        sources: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "format": {
                "normalized_tax_id": tax_id,
                "formatted_tax_id": format_tax_id(tax_id),
                "is_valid_checksum": is_valid_cuit(tax_id),
                "expected_check_digit": calculate_check_digit(tax_id),
                "actual_check_digit": int(tax_id[-1]),
                "kind": subject["kind"],
            },
            "arca_registration": {
                "is_registered": subject["registration_status"] != "unknown",
                "is_active": subject["registration_status"] == "active",
                "activity_count": len(subject["activities"]),
                "main_activity": subject["activities"][0] if subject["activities"] else None,
                "tax_tags": subject["tax_tags"],
            },
            "bcra_debtors": {
                "has_debt": risk["has_bcra_debt"],
                "worst_situation": risk["bcra_worst_situation"],
                "worst_situation_label": risk["bcra_worst_situation_label"],
                "worst_situation_description": risk["bcra_worst_situation_description"],
                "historical_worst_situation": risk.get("bcra_historical_worst_situation"),
                "reporting_entities": risk["reporting_entities"],
                "debt_amount_ars": risk["debt_amount_ars"],
                "has_rejected_checks": risk["has_rejected_checks"],
                "rejected_checks_count": risk["rejected_checks_count"],
                "rejected_checks_amount_ars": risk["rejected_checks_amount_ars"],
                "latest_period": risk.get("latest_period"),
                "period_count": risk.get("period_count", 0),
                "history": risk.get("history", []),
                "entities": risk.get("entities", []),
                "entity_details": risk.get("entity_details", []),
                "rejected_checks": risk.get("rejected_checks", []),
                "rejected_checks_status": risk.get("rejected_checks_status", "unknown"),
                "rejected_checks_message": risk.get("rejected_checks_message"),
            },
            "local_integrity": {
                "tax_id_type": infer_tax_id_type(tax_id),
                "recognized_prefix": infer_tax_id_type(tax_id) != "unknown",
                "is_valid_checksum": is_valid_cuit(tax_id),
                "duplicate_in_request": False,
                "request_occurrence": 1,
                "has_period_changes": len({
                    (item.get("debt_amount_ars"), item.get("worst_situation"))
                    for item in risk.get("history", [])
                }) > 1,
            },
            "source_freshness": {
                "source_count": len(sources),
                "ok_sources": [
                    source["name"] for source in sources if source["status"] in {"ok", "fallback", "cache", "stale_cache"}
                ],
                "not_found_sources": [source["name"] for source in sources if source["status"] == "not_found"],
                "fetched_at": max(source["fetched_at"] for source in sources),
                "mode": ", ".join(sorted({source["mode"] for source in sources})),
                "sources": [{
                    "name": source["name"],
                    "status": source["status"],
                    "fetched_at": source["fetched_at"],
                    "mode": source["mode"],
                    "is_stale": source["status"] == "stale_cache",
                    "age_seconds": source_age_seconds(source["fetched_at"]),
                } for source in sources],
                "has_stale_sources": any(source["status"] == "stale_cache" for source in sources),
                "oldest_source_age_seconds": max(
                    (source_age_seconds(source["fetched_at"]) or 0 for source in sources), default=0
                ),
            },
        }


SERVICE = CheckService()


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "NosisLiteMvp/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in {"/", "/ui"}:
            self.send_file(PUBLIC / "index.html", "text/html; charset=utf-8")
            return

        if parsed.path == "/health":
            self.send_json({"status": "ok", "version": APP_VERSION, "time": utc_now()})
            return

        if parsed.path == "/version":
            self.send_json({"name": "nosis-lite-mvp", "version": APP_VERSION})
            return

        match = re.fullmatch(r"/v1/subjects/([^/]+)", parsed.path)
        if match:
            self.handle_subject(unquote(match.group(1)))
            return

        if parsed.path in {"/public/app.css", "/app.css"}:
            self.send_file(PUBLIC / "app.css", "text/css; charset=utf-8")
            return

        if parsed.path in {"/public/app.js", "/app.js"}:
            self.send_file(PUBLIC / "app.js", "application/javascript; charset=utf-8")
            return

        if parsed.path == "/vendor/exceljs.min.js":
            self.send_file(PUBLIC / "vendor" / "exceljs.min.js", "application/javascript; charset=utf-8")
            return

        self.send_error_json(404, "not_found", "Endpoint not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/v1/checks":
            self.handle_create_check()
            return

        if parsed.path == "/v1/bulk-checks":
            self.handle_create_bulk_check()
            return

        self.send_error_json(404, "not_found", "Endpoint not found")

    def handle_subject(self, raw_tax_id: str) -> None:
        try:
            self.send_json(SERVICE.build_subject(raw_tax_id))
        except ValueError as exc:
            self.send_error_json(400, "invalid_tax_id", str(exc))

    def handle_create_check(self) -> None:
        try:
            payload = self.read_json_body()
            self.send_json(SERVICE.create_check(payload), status=201)
        except ValueError as exc:
            self.send_error_json(400, "bad_request", str(exc))
        except json.JSONDecodeError:
            self.send_error_json(400, "bad_json", "Request body must be valid JSON")

    def handle_create_bulk_check(self) -> None:
        try:
            payload = self.read_json_body()
            self.send_json(SERVICE.create_bulk_check(payload), status=201)
        except ValueError as exc:
            self.send_error_json(400, "bad_request", str(exc))
        except json.JSONDecodeError:
            self.send_error_json(400, "bad_json", "Request body must be valid JSON")

    def read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("Request body is required")
        raw = self.rfile.read(content_length).decode("utf-8")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object")
        return payload

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self.send_error_json(404, "not_found", "File not found")
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, code: str, message: str) -> None:
        self.send_json({"error": {"code": code, "message": message}}, status=status)

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer((host, port), ApiHandler)
    print(f"Nosis Lite MVP listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
