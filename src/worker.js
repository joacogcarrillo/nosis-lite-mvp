import arcaSubjects from "../fixtures/arca_subjects.json" with { type: "json" };
import bcraFixtures from "../fixtures/bcra_debtors.json" with { type: "json" };

const APP_VERSION = "0.6.0-worker";
const BCRA_SITUATION_LABELS = {
  1: "normal",
  2: "low_risk",
  3: "medium_risk",
  4: "high_risk",
  5: "irrecoverable",
  6: "irrecoverable_technical",
};
const BCRA_SITUATION_DESCRIPTIONS = {
  1: "Normal",
  2: "Riesgo bajo",
  3: "Riesgo medio",
  4: "Riesgo alto",
  5: "Irrecuperable",
  6: "Irrecuperable por disposición técnica",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", version: APP_VERSION, runtime: "cloudflare-worker", time: utcNow() });
    }

    if (request.method === "GET" && url.pathname === "/version") {
      return json({ name: "nosis-lite-mvp", version: APP_VERSION, runtime: "cloudflare-worker" });
    }

    const subjectMatch = url.pathname.match(/^\/v1\/subjects\/([^/]+)$/);
    if (request.method === "GET" && subjectMatch) {
      return handleErrors(async () => json(await buildSubject(decodeURIComponent(subjectMatch[1]), env, ctx)));
    }

    if (request.method === "POST" && url.pathname === "/v1/checks") {
      return handleErrors(async () => {
        const payload = await request.json();
        const taxId = normalizeTaxId(String(payload.tax_id || ""));
        return json(
          {
            id: `chk_${taxId}_${timestampId()}`,
            created_at: utcNow(),
            requested_checks: payload.checks || ["format", "arca_registration", "bcra_debtors"],
            status: "completed",
            result: await buildSubject(taxId, env, ctx),
          },
          201,
        );
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/bulk-checks") {
      return handleErrors(async () => {
        const payload = await request.json();
        return json(await createBulkCheck(payload, env, ctx), 201);
      });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;
    return json({ error: { code: "not_found", message: "Endpoint not found" } }, 404);
  },
};

export function normalizeTaxId(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 11) throw new Error("tax_id must contain exactly 11 digits");
  return digits;
}

export function calculateCheckDigit(value) {
  const digits = normalizeTaxId(value);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const total = weights.reduce((sum, weight, index) => sum + Number(digits[index]) * weight, 0);
  const check = 11 - (total % 11);
  if (check === 11) return 0;
  if (check === 10) return 9;
  return check;
}

export function isValidCuit(value) {
  const digits = normalizeTaxId(value);
  return calculateCheckDigit(digits) === Number(digits.at(-1));
}

function formatTaxId(value) {
  const digits = normalizeTaxId(value);
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function inferSubjectKind(taxId) {
  const prefix = taxId.slice(0, 2);
  if (["20", "23", "24", "27"].includes(prefix)) return "person";
  if (["30", "33", "34"].includes(prefix)) return "company";
  return "unknown";
}

async function buildSubject(rawTaxId, env, ctx) {
  const taxId = normalizeTaxId(rawTaxId);
  const valid = isValidCuit(taxId);
  const arca = arcaSubjects[taxId] || null;
  const arcaTrace = sourceTrace("arca", arca ? "ok" : "not_found", "fixture");
  const [bcra, bcraTrace] = await getBcraSituation(taxId, env, ctx);

  const subject = {
    tax_id: taxId,
    formatted_tax_id: formatTaxId(taxId),
    valid,
    kind: inferSubjectKind(taxId),
    name: arca?.name || bcra?.denomination || null,
    registration_status: arca?.registration_status || "unknown",
    activities: arca?.activities || [],
    tax_tags: arca?.tax_tags || [],
  };

  const risk = buildRisk(bcra);
  const sources = [arcaTrace, bcraTrace];
  return {
    tax_id: taxId,
    valid,
    subject,
    risk,
    checks: buildEasyChecks(taxId, subject, risk, sources),
    sources,
  };
}

async function createBulkCheck(payload, env, ctx) {
  let rawTaxIds = payload.tax_ids || [];
  if (typeof rawTaxIds === "string") rawTaxIds = rawTaxIds.split(/[\s,;]+/);
  if (!Array.isArray(rawTaxIds)) throw new Error("tax_ids must be an array or a text list");

  const maxIds = Number(env.BULK_MAX_IDS || 500);
  const cleaned = rawTaxIds.map((item) => String(item).trim()).filter(Boolean);
  if (!cleaned.length) throw new Error("At least one tax_id is required");
  if (cleaned.length > maxIds) throw new Error(`Bulk checks are limited to ${maxIds} identifiers per request`);

  const results = [];
  const errors = [];
  for (const rawTaxId of cleaned) {
    try {
      results.push(await buildSubject(rawTaxId, env, ctx));
    } catch (error) {
      errors.push({ tax_id: rawTaxId, error: error.message });
    }
  }

  return {
    id: `bulk_${timestampId()}`,
    created_at: utcNow(),
    requested_count: cleaned.length,
    completed_count: results.length,
    error_count: errors.length,
    results,
    errors,
  };
}

async function getBcraSituation(taxId, env, ctx) {
  const mode = String(env.BCRA_MODE || "auto").toLowerCase();
  if (mode === "fixture") {
    const fixture = bcraFixtures[taxId] || null;
    return [fixture, sourceTrace("bcra", fixture ? "ok" : "not_found", "fixture")];
  }

  const cache = caches.default;
  const baseUrl = String(env.BCRA_API_BASE_URL || "https://api.bcra.gob.ar/centraldedeudores/v1.0").replace(/\/$/, "");
  const liveUrl = `${baseUrl}/Deudas/${taxId}`;
  const cacheRequest = new Request(`https://nosis-lite-cache.local/bcra/${taxId}`);
  const cached = await cache.match(cacheRequest);
  if (cached) {
    return [await cached.json(), sourceTrace("bcra", "cache", "cache", "Cloudflare cache hit")];
  }

  const maxRetries = Number(env.BCRA_MAX_RETRIES || 3);
  const backoffSeconds = Number(env.BCRA_BACKOFF_SECONDS || 1);
  let lastError = "";
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(liveUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "NosisLiteMvp/0.5-worker",
        },
      });
      if (response.status === 404) {
        return fallbackOrNone(taxId, mode, `BCRA live returned 404 for ${taxId}`, "not_found");
      }
      if (!response.ok) throw new Error(`BCRA live HTTP ${response.status}`);
      const payload = await response.json();
      const normalized = normalizeBcraResponse(payload);
      const ttl = Number(env.BCRA_CACHE_TTL_SECONDS || 86400);
      ctx.waitUntil(cache.put(cacheRequest, json(normalized, 200, { "Cache-Control": `max-age=${ttl}` })));
      return [normalized, sourceTrace("bcra", "ok", "live", `Fetched from ${liveUrl} on attempt ${attempt}`)];
    } catch (error) {
      lastError = `BCRA live unavailable: ${error.message}`;
      if (attempt < maxRetries) {
        const jitterMs = Math.floor(Math.random() * 500);
        await sleep(backoffSeconds * attempt * 1000 + jitterMs);
      }
    }
  }
  return fallbackOrNone(taxId, mode, lastError, "error");
}

function fallbackOrNone(taxId, mode, message, missingStatus) {
  if (mode === "auto") {
    const fixture = bcraFixtures[taxId] || null;
    return [fixture, sourceTrace("bcra", fixture ? "fallback" : missingStatus, fixture ? "fixture" : "live", message)];
  }
  return [null, sourceTrace("bcra", missingStatus, "live", message)];
}

function normalizeBcraResponse(payload) {
  const result = payload.results || {};
  const periods = result.periodos || [];
  const debts = [];
  for (const period of periods) {
    const periodId = String(period.periodo || "");
    const formattedPeriod = periodId.length === 6 ? `${periodId.slice(0, 4)}-${periodId.slice(4)}` : periodId;
    for (const entity of period.entidades || []) {
      debts.push({
        entity: entity.entidad,
        period: formattedPeriod,
        situation: entity.situacion,
        amount_ars: entity.monto || 0,
        days_late: entity.diasAtrasoPago,
        refinanced: entity.refinanciaciones,
      });
    }
  }

  const checks = result.chequesRechazados || result.cheques_rechazados || [];
  return {
    summary: `BCRA live record for ${result.denominacion || result.identificacion}.`,
    denomination: result.denominacion,
    debts,
    rejected_checks: checks.map((check) => ({
      period: check.periodo,
      count: check.cantidad || check.count || 1,
      amount_ars: check.monto || 0,
    })),
    raw_period_count: periods.length,
  };
}

function buildRisk(bcra) {
  if (!bcra) {
    return {
      has_bcra_debt: false,
      bcra_worst_situation: null,
      bcra_worst_situation_label: null,
      bcra_worst_situation_description: null,
      reporting_entities: 0,
      has_rejected_checks: false,
      rejected_checks_count: 0,
      rejected_checks_amount_ars: 0,
      debt_amount_ars: 0,
      summary: "No BCRA record found.",
    };
  }

  const situations = (bcra.debts || []).map((item) => item.situation || 0);
  const worst = situations.length ? Math.max(...situations) : null;
  const rejectedChecks = bcra.rejected_checks || [];
  return {
    has_bcra_debt: Boolean((bcra.debts || []).length),
    bcra_worst_situation: worst,
    bcra_worst_situation_label: BCRA_SITUATION_LABELS[worst] || null,
    bcra_worst_situation_description: BCRA_SITUATION_DESCRIPTIONS[worst] || null,
    reporting_entities: (bcra.debts || []).length,
    has_rejected_checks: Boolean(rejectedChecks.length),
    rejected_checks_count: rejectedChecks.reduce((sum, item) => sum + (item.count || 0), 0),
    rejected_checks_amount_ars: rejectedChecks.reduce((sum, item) => sum + (item.amount_ars || 0), 0),
    debt_amount_ars: (bcra.debts || []).reduce((sum, item) => sum + (item.amount_ars || 0), 0),
    summary: bcra.summary,
  };
}

function buildEasyChecks(taxId, subject, risk, sources) {
  return {
    format: {
      normalized_tax_id: taxId,
      formatted_tax_id: formatTaxId(taxId),
      is_valid_checksum: isValidCuit(taxId),
      expected_check_digit: calculateCheckDigit(taxId),
      actual_check_digit: Number(taxId.at(-1)),
      kind: subject.kind,
    },
    arca_registration: {
      is_registered: subject.registration_status !== "unknown",
      is_active: subject.registration_status === "active",
      activity_count: subject.activities.length,
      main_activity: subject.activities[0] || null,
      tax_tags: subject.tax_tags,
    },
    bcra_debtors: {
      has_debt: risk.has_bcra_debt,
      worst_situation: risk.bcra_worst_situation,
      worst_situation_label: risk.bcra_worst_situation_label,
      worst_situation_description: risk.bcra_worst_situation_description,
      reporting_entities: risk.reporting_entities,
      debt_amount_ars: risk.debt_amount_ars,
      has_rejected_checks: risk.has_rejected_checks,
      rejected_checks_count: risk.rejected_checks_count,
      rejected_checks_amount_ars: risk.rejected_checks_amount_ars,
    },
    source_freshness: {
      source_count: sources.length,
      ok_sources: sources.filter((source) => ["ok", "fallback", "cache", "stale_cache"].includes(source.status)).map((source) => source.name),
      not_found_sources: sources.filter((source) => source.status === "not_found").map((source) => source.name),
      fetched_at: sources.map((source) => source.fetched_at).sort().at(-1),
      mode: [...new Set(sources.map((source) => source.mode))].sort().join(", "),
    },
  };
}

function sourceTrace(name, status, mode, message = null) {
  return { name, status, fetched_at: utcNow(), mode, message };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

async function handleErrors(handler) {
  try {
    return await handler();
  } catch (error) {
    return json({ error: { code: "bad_request", message: error.message } }, 400);
  }
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function timestampId() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
