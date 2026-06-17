const form = document.querySelector("#lookup-form");
const input = document.querySelector("#tax-id");
const statusBox = document.querySelector("#status");
const resultBox = document.querySelector("#result");
const bulkInput = document.querySelector("#bulk-tax-ids");
const bulkButton = document.querySelector("#bulk-check");

const money = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function riskClass(label) {
  if (!label || label === "normal") return "ok";
  if (label === "low_risk" || label === "medium_risk") return "warning";
  return "danger";
}

function render(data) {
  const checks = data.checks;
  const subject = data.subject;
  const bcra = checks.bcra_debtors;
  const arca = checks.arca_registration;
  const bcraSource = data.sources.find((source) => source.name === "bcra");
  const activityItems = subject.activities
    .map((item) => `<li><strong>${escapeHtml(item.code)}</strong> ${escapeHtml(item.description)}</li>`)
    .join("");

  resultBox.innerHTML = `
    <div class="summary">
      <article class="card metric">
        <div class="label">Identifier</div>
        <div class="value">${escapeHtml(checks.format.formatted_tax_id)}</div>
        <div class="${checks.format.is_valid_checksum ? "ok" : "danger"}">
          ${checks.format.is_valid_checksum ? "Valid checksum" : "Invalid checksum"}
        </div>
      </article>
      <article class="card metric">
        <div class="label">Subject</div>
        <div class="value">${escapeHtml(subject.name || "Not found")}</div>
        <div>${escapeHtml(subject.kind)}</div>
      </article>
      <article class="card metric">
        <div class="label">ARCA</div>
        <div class="value ${arca.is_active ? "ok" : "warning"}">${arca.is_active ? "Active" : "Unknown"}</div>
        <div>${arca.activity_count} activities</div>
      </article>
      <article class="card metric">
        <div class="label">BCRA</div>
        <div class="value ${riskClass(bcra.worst_situation_label)}">${escapeHtml(bcra.worst_situation_label || "No record")}</div>
        <div>${bcra.has_rejected_checks ? "Has rejected checks" : "No rejected checks"} · ${escapeHtml(bcraSource?.mode || "unknown")}</div>
      </article>
    </div>

    <div class="grid">
      <article class="card">
        <h2>Fiscal profile</h2>
        <dl>
          <dt>Status</dt><dd>${escapeHtml(subject.registration_status)}</dd>
          <dt>Tax tags</dt><dd>${escapeHtml(subject.tax_tags.join(", ") || "None")}</dd>
          <dt>Main activity</dt><dd>${escapeHtml(arca.main_activity?.description || "None")}</dd>
        </dl>
      </article>
      <article class="card">
        <h2>Credit situation</h2>
        <dl>
          <dt>Worst situation</dt><dd>${escapeHtml(bcra.worst_situation ?? "None")}</dd>
          <dt>Debt total</dt><dd>${money.format(bcra.debt_amount_ars)}</dd>
          <dt>Rejected checks</dt><dd>${bcra.rejected_checks_count} / ${money.format(bcra.rejected_checks_amount_ars)}</dd>
        </dl>
      </article>
      <article class="card">
        <h2>Activities</h2>
        <ul>${activityItems || "<li>No activities found</li>"}</ul>
      </article>
      <article class="card">
        <h2>Source freshness</h2>
        <dl>
          <dt>Mode</dt><dd>${escapeHtml(checks.source_freshness.mode)}</dd>
          <dt>Fetched at</dt><dd>${escapeHtml(checks.source_freshness.fetched_at)}</dd>
          <dt>Sources</dt><dd>${escapeHtml(checks.source_freshness.ok_sources.join(", "))}</dd>
          <dt>BCRA note</dt><dd>${escapeHtml(bcraSource?.message || "OK")}</dd>
        </dl>
      </article>
    </div>
  `;
}

function renderBulk(data) {
  const rows = data.results
    .map((item) => {
      const bcra = item.checks.bcra_debtors;
      const source = item.sources.find((entry) => entry.name === "bcra");
      return `
        <tr>
          <td>${escapeHtml(item.subject.formatted_tax_id)}</td>
          <td>${escapeHtml(item.subject.name || "Not found")}</td>
          <td class="${riskClass(bcra.worst_situation_label)}">${escapeHtml(bcra.worst_situation_label || "No record")}</td>
          <td>${escapeHtml(source?.mode || "unknown")}</td>
          <td>${escapeHtml(source?.message || "OK")}</td>
        </tr>
      `;
    })
    .join("");
  const errors = data.errors
    .map((item) => `<li>${escapeHtml(item.tax_id)}: ${escapeHtml(item.error)}</li>`)
    .join("");

  resultBox.innerHTML = `
    <article class="card">
      <h2>Bulk results</h2>
      <dl>
        <dt>Requested</dt><dd>${data.requested_count}</dd>
        <dt>Completed</dt><dd>${data.completed_count}</dd>
        <dt>Errors</dt><dd>${data.error_count}</dd>
      </dl>
    </article>
    <article class="card">
      <table>
        <thead>
          <tr>
            <th>CUIT/CUIL</th>
            <th>Name</th>
            <th>BCRA</th>
            <th>Mode</th>
            <th>Source note</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${errors ? `<h2>Errors</h2><ul>${errors}</ul>` : ""}
    </article>
  `;
}

async function runLookup(taxId) {
  statusBox.textContent = "Checking...";
  resultBox.innerHTML = "";
  try {
    const response = await fetch(`/v1/subjects/${encodeURIComponent(taxId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "Lookup failed");
    }
    render(data);
    statusBox.textContent = "Done";
  } catch (error) {
    statusBox.textContent = error.message;
    resultBox.innerHTML = "";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runLookup(input.value.trim());
});

document.querySelectorAll("[data-tax-id]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.taxId;
    runLookup(input.value);
  });
});

bulkButton.addEventListener("click", async () => {
  statusBox.textContent = "Running bulk check...";
  resultBox.innerHTML = "";
  try {
    const taxIds = bulkInput.value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const response = await fetch("/v1/bulk-checks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tax_ids: taxIds }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "Bulk check failed");
    }
    renderBulk(data);
    statusBox.textContent = "Bulk check done";
  } catch (error) {
    statusBox.textContent = error.message;
  }
});

runLookup(input.value);
