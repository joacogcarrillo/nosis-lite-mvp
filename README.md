# Nosis Lite MVP

Lightweight API for checking Argentine CUIT/CUIL/CDI identifiers against:

- CUIT/CUIL format and checksum rules
- ARCA/AFIP registration and registered activities
- BCRA Central de Deudores situation

The default implementation runs in fixture mode so the API contract can be sold, tested, and demoed while live data-source access is finalized.

## Why this MVP

Nosis is a known Argentine business-information provider: identity, fiscal, commercial, and credit-risk lookups. A narrow substitute should avoid trying to clone the whole product and instead sell one reliable workflow:

> Given a CUIT/CUIL, return whether the subject exists, what activities it is registered for, and whether it appears with debt situations in BCRA Central de Deudores.

## Run

```powershell
python .\app.py
```

For staging or any hosted environment, bind to all interfaces:

```powershell
$env:HOST="0.0.0.0"
$env:PORT="8080"
$env:BCRA_MODE="auto"
python .\app.py
```

If port 8080 is busy:

```powershell
$env:PORT=8081; python .\app.py
```

Run with the BCRA live adapter enabled:

```powershell
$env:PORT=8084
$env:BCRA_MODE="auto"
python .\app.py
```

`BCRA_MODE` values:

- `fixture`: never calls BCRA, only local fixtures
- `live`: calls BCRA and returns not found/error if unavailable
- `auto`: calls BCRA, then falls back to fixtures when available

Bulk/reliability knobs:

```powershell
$env:BCRA_MAX_RETRIES="3"
$env:BCRA_BACKOFF_SECONDS="1.0"
$env:BCRA_MIN_INTERVAL_SECONDS="1.0"
$env:BCRA_CACHE_TTL_SECONDS="86400"
$env:BULK_MAX_IDS="500"
```

Then call:

```powershell
curl http://localhost:8080/health
curl http://localhost:8080/v1/subjects/30-70767203-6
```

Create a check:

```powershell
curl -X POST http://localhost:8080/v1/checks `
  -H "Content-Type: application/json" `
  -d "{\"tax_id\":\"30-70767203-6\",\"checks\":[\"format\",\"arca_registration\",\"bcra_debtors\"]}"
```

Manual high-signal checks:

```powershell
curl http://localhost:8080/v1/subjects/30-70767203-6
curl http://localhost:8080/v1/subjects/20-30405060-9
```

The first fixture returns a company with normal BCRA situation. The second fixture returns a person with medium-risk BCRA situation and rejected checks.

Run tests:

```powershell
python .\test_app.py
```

## API surface

- `GET /health`
- `GET /v1/subjects/{tax_id}`
- `POST /v1/checks`
- `POST /v1/bulk-checks`

`tax_id` may include hyphens or spaces. Responses always include a normalized 11-digit identifier.

Each subject response includes a `checks` object with:

- `format`: normalized ID, formatted ID, checksum result, expected/actual verifier digit, inferred subject kind
- `arca_registration`: registration presence, active flag, activity count, main activity, tax tags
- `bcra_debtors`: debt flag, worst BCRA situation, label, reporting entities, debt total, rejected-check count and amount
- `source_freshness`: source status summary and fetch timestamp

## Live adapters to add next

The code currently uses fixture-backed adapters:

- `FixtureArcaProvider`
- `FixtureBcraProvider`

Replace or wrap them with live adapters once you confirm the source path:

- ARCA/AFIP: authorized web service or approved lookup integration for constancia/registration data.
- BCRA: Central de Deudores public consultation/API path, respecting rate limits and terms.

## Real API setup guide

### BCRA Central de Deudores

The live MVP uses:

```text
https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/{CUIT_CUIL_CDI}
```

Example public test identifier:

```text
30-50001091-2
```

That endpoint may occasionally close or reset connections. Keep timeout, retry, cache, and fallback status visible in the product.

### ARCA/AFIP registration and activities

Treat ARCA as an authenticated integration, not an anonymous public API.

Minimum path:

1. Get an ARCA/AFIP web service certificate for your CUIT.
2. Enable the relevant padrón/constancia web service in Administrador de Relaciones.
3. Implement WSAA authentication to get `token` and `sign`.
4. Call the selected padrón/constancia SOAP service.
5. Normalize the returned registration status, tax tags, and activity codes into the same `subject` shape used by this MVP.

Until those credentials exist, keep ARCA in fixture/manual mode and make the UI label it clearly.

## Staging deploy

The app is ready for Docker-based staging and Cloudflare Workers.

Included deploy files:

- `Dockerfile`
- `wrangler.jsonc`
- `render.yaml`
- `railway.json`
- `fly.toml`

## Cloudflare Worker deploy

Cloudflare Worker files:

- `src/worker.js`
- `public/index.html`
- `public/app.css`
- `public/app.js`
- `wrangler.jsonc`
- `package.json`

The Worker exposes the same UI and API paths:

- `/ui`
- `/health`
- `/v1/subjects/{tax_id}`
- `/v1/checks`
- `/v1/bulk-checks`

### Connect GitHub to Cloudflare

1. Create a GitHub repo named `nosis-lite-mvp`.
2. Push this local repo to GitHub.
3. Open Cloudflare Dashboard.
4. Go to Workers & Pages.
5. Create an application.
6. Choose the GitHub repository.
7. Use these build settings:

```text
Framework preset: None
Build command: npm install
Deploy command: npm run deploy
Root directory: /
```

If Cloudflare asks for a Worker config file, use:

```text
wrangler.jsonc
```

Set these Worker variables:

```text
BCRA_MODE=auto
BCRA_API_BASE_URL=https://api.bcra.gob.ar/centraldedeudores/v1.0
BCRA_MAX_RETRIES=3
BCRA_BACKOFF_SECONDS=1
BCRA_CACHE_TTL_SECONDS=86400
BULK_MAX_IDS=500
```

After deploy, open:

```text
https://nosis-lite-mvp.YOUR-SUBDOMAIN.workers.dev/ui
```

Test with:

```text
30-50001091-2
```

Success condition: the BCRA card says `live` or `cache`, not `fixture`.

### Automatic deployment from GitHub

The repository includes `.github/workflows/deploy-cloudflare.yml`.

Every push to `main` will:

1. Install dependencies on Node.js 22.
2. Run the Worker tests.
3. Deploy with Wrangler when tests pass.

Add these GitHub repository secrets under **Settings > Secrets and variables > Actions**:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Create the API token in Cloudflare with permission to edit Workers Scripts for the target account. The account ID is available in the Cloudflare dashboard account overview or Workers dashboard.

The workflow also supports manual runs from **GitHub > Actions > Deploy Cloudflare Worker > Run workflow**.

### Direct deploy from a compatible terminal

Local Wrangler install failed on this Windows ARM environment because the `workerd` package does not support `win32 arm64` here. On a compatible terminal, such as x64 Windows, macOS, Linux, WSL, or Cloudflare's GitHub build, run:

```bash
npm install
npx wrangler login
npm run deploy
```

### Fastest path: Render

1. Push this folder to a GitHub repository.
2. Go to Render and create a new Blueprint from that repository.
3. Render should detect `render.yaml`.
4. Keep these environment variables:

```text
HOST=0.0.0.0
BCRA_MODE=auto
BCRA_MAX_RETRIES=3
BCRA_BACKOFF_SECONDS=1.0
BCRA_MIN_INTERVAL_SECONDS=1.0
BCRA_CACHE_TTL_SECONDS=86400
BULK_MAX_IDS=500
```

5. After deploy, open:

```text
https://YOUR-RENDER-URL/ui
```

6. Test BCRA with:

```text
30-50001091-2
```

If staging works, the BCRA card should say `live` or `cache`, not `fixture`.

### Railway

Create a new Railway project from the GitHub repo. Railway should use `railway.json` and the `Dockerfile`.

Set the same environment variables as above. Open:

```text
https://YOUR-RAILWAY-URL/ui
```

### Fly.io

Rename the app in `fly.toml`, then run:

```powershell
fly launch
fly deploy
```

Open:

```text
https://YOUR-FLY-APP.fly.dev/ui
```

## Bulk-check reliability posture

BCRA does not publish a simple numeric quota on the Central de Deudores page. Treat it as rate-limited civic infrastructure anyway.

The MVP now uses:

- One request per second by default
- Three attempts per live BCRA request
- Linear backoff between attempts
- Persistent SQLite cache in `data/cache.db`
- 24-hour fresh cache TTL by default
- Stale-cache fallback when live BCRA is unavailable
- Clear source labels: `live`, `cache`, `fixture`
- A bulk endpoint with a default limit of 500 IDs per request

Recommended production defaults for a first customer pilot:

- Queue bulk jobs instead of doing them inside a web request
- Deduplicate CUITs before querying BCRA
- Cache by CUIT and BCRA period, not only by timestamp
- Start at 0.2 to 1 request/second globally
- Add jitter to retry delays
- Stop retrying on repeated 4xx responses
- Use daily/monthly re-check policies instead of re-querying the same CUIT repeatedly
- Keep audit logs of source, timestamp, cache age, and raw BCRA period
- Get legal review before reselling BCRA-derived data commercially

## Easy additional checks

Good MVP additions:

- CUIT/CUIL checksum validity
- Identifier kind inference: probable person/company by prefix
- BCRA worst situation and reporting entities count
- Rejected checks flag when available from BCRA output
- ARCA active/inactive registration status
- Registered activities by code and description
- Tax status tags exposed by the ARCA source, such as IVA/Monotributo where available
- Cache freshness timestamp and source traceability

Avoid for MVP unless you have a licensed source:

- Full credit scoring
- Enriched addresses/phones/emails
- PEP/sanctions matching
- Court/litigation screening
- Employment/payroll inference

## Commercial MVP packaging

Suggested first paid API:

```json
{
  "tax_id": "30707672036",
  "valid": true,
  "subject": {
    "name": "ACME S.A.",
    "kind": "company",
    "registration_status": "active",
    "activities": []
  },
  "risk": {
    "bcra_worst_situation": 1,
    "has_bcra_debt": true,
    "has_rejected_checks": false
  },
  "sources": [
    {
      "name": "arca",
      "status": "ok",
      "fetched_at": "2026-06-17T13:58:00Z"
    }
  ]
}
```

Pricing can start per successful check, with volume tiers and cached reads discounted.
