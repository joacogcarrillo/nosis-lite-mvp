const CHUNK_SIZE = 5;
const CHUNK_PAUSE_MS = 500;
const MAX_ROWS = 500;

const state = {
  records: [],
  uniqueValid: [],
  resultsByTaxId: new Map(),
  running: false,
};

const fileTab = document.querySelector("#file-tab");
const pasteTab = document.querySelector("#paste-tab");
const filePanel = document.querySelector("#file-panel");
const pastePanel = document.querySelector("#paste-panel");
const fileInput = document.querySelector("#file-input");
const fileName = document.querySelector("#file-name");
const dropZone = document.querySelector("#drop-zone");
const pasteInput = document.querySelector("#paste-input");
const loadPasteButton = document.querySelector("#load-paste");
const validationBox = document.querySelector("#validation");
const runButton = document.querySelector("#run-checks");
const statusBox = document.querySelector("#status");
const progressWrap = document.querySelector("#progress-wrap");
const progressBar = document.querySelector("#progress-bar");
const progressLabel = document.querySelector("#progress-label");
const resultsSection = document.querySelector("#results");
const resultSummary = document.querySelector("#result-summary");
const resultRows = document.querySelector("#result-rows");
const downloadResultsButton = document.querySelector("#download-results");
const downloadTemplateButton = document.querySelector("#download-template");

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

function normalizeTaxId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function calculateCheckDigit(taxId) {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const total = weights.reduce((sum, weight, index) => sum + Number(taxId[index]) * weight, 0);
  const check = 11 - (total % 11);
  if (check === 11) return 0;
  if (check === 10) return 9;
  return check;
}

function isValidTaxId(taxId) {
  return taxId.length === 11 && calculateCheckDigit(taxId) === Number(taxId.at(-1));
}

function formatTaxId(taxId) {
  if (taxId.length !== 11) return taxId;
  return `${taxId.slice(0, 2)}-${taxId.slice(2, 10)}-${taxId.slice(10)}`;
}

function normalizeHeader(value) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function valueFromCell(cell) {
  const value = cell?.value;
  if (value && typeof value === "object") {
    if ("result" in value) return value.result;
    if ("text" in value) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  }
  return value ?? "";
}

function switchMode(mode) {
  const fileMode = mode === "file";
  fileTab.classList.toggle("active", fileMode);
  pasteTab.classList.toggle("active", !fileMode);
  fileTab.setAttribute("aria-selected", String(fileMode));
  pasteTab.setAttribute("aria-selected", String(!fileMode));
  filePanel.classList.toggle("hidden", !fileMode);
  pastePanel.classList.toggle("hidden", fileMode);
}

function prepareRecords(rows) {
  const seen = new Map();
  state.records = rows.slice(0, MAX_ROWS).map((row, index) => {
    const taxId = normalizeTaxId(row.taxId);
    const valid = isValidTaxId(taxId);
    const duplicate = valid && seen.has(taxId);
    if (valid && !duplicate) seen.set(taxId, index);
    return {
      rowNumber: row.rowNumber ?? index + 1,
      rawTaxId: String(row.taxId ?? ""),
      taxId,
      reference: String(row.reference ?? ""),
      valid,
      duplicate,
      result: null,
      error: valid ? null : "Invalid CUIT/CUIL",
    };
  });
  state.uniqueValid = state.records.filter((record) => record.valid && !record.duplicate);
  state.resultsByTaxId.clear();
  renderValidation(rows.length > MAX_ROWS);
}

function renderValidation(truncated) {
  const valid = state.records.filter((record) => record.valid).length;
  const invalid = state.records.length - valid;
  const duplicates = state.records.filter((record) => record.duplicate).length;
  validationBox.innerHTML = `
    ${stat("Rows", state.records.length)}
    ${stat("Valid", valid, "ok")}
    ${stat("Invalid", invalid, invalid ? "danger" : "")}
    ${stat("Duplicates", duplicates, duplicates ? "warning" : "")}
  `;
  validationBox.classList.remove("hidden");
  runButton.disabled = state.uniqueValid.length === 0;
  statusBox.textContent = truncated ? `Only the first ${MAX_ROWS} rows were loaded` : `${state.uniqueValid.length} unique CUITs ready`;
  resultsSection.classList.add("hidden");
}

function stat(label, value, tone = "") {
  return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value ${tone}">${escapeHtml(value)}</div></div>`;
}

async function parseXlsx(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The workbook has no worksheets");

  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    headers[column] = normalizeHeader(valueFromCell(cell));
  });
  const taxHeaders = new Set(["cuit", "cuil", "cuitcuil", "taxid", "identificacion"]);
  const taxColumn = headers.findIndex((header) => taxHeaders.has(header));
  const referenceColumn = headers.findIndex((header) => ["reference", "referencia", "cliente", "clientid", "idcliente"].includes(header));
  if (taxColumn < 1) throw new Error("No CUIT/CUIL column was found");

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const taxId = valueFromCell(row.getCell(taxColumn));
    if (String(taxId ?? "").trim() === "") return;
    rows.push({
      taxId,
      reference: referenceColumn > 0 ? valueFromCell(row.getCell(referenceColumn)) : "",
      rowNumber,
    });
  });
  return rows;
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = [";", ",", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? "\n";
    if (char === '"' && quoted && text[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { row.push(field); field = ""; continue; }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (!rows.length) return [];
  const headers = rows[0].map(normalizeHeader);
  const taxHeaders = new Set(["cuit", "cuil", "cuitcuil", "taxid", "identificacion"]);
  const taxColumn = headers.findIndex((header) => taxHeaders.has(header));
  const referenceColumn = headers.findIndex((header) => ["reference", "referencia", "cliente", "clientid", "idcliente"].includes(header));
  if (taxColumn < 0) throw new Error("No CUIT/CUIL column was found");
  return rows.slice(1).filter((values) => values.some(Boolean)).map((values, index) => ({
    taxId: values[taxColumn],
    reference: referenceColumn >= 0 ? values[referenceColumn] : "",
    rowNumber: index + 2,
  }));
}

async function loadFile(file) {
  if (!file) return;
  fileName.textContent = file.name;
  statusBox.textContent = "Reading file...";
  try {
    const extension = file.name.split(".").pop().toLowerCase();
    const rows = extension === "xlsx" ? await parseXlsx(file) : parseCsv(await file.text());
    if (!rows.length) throw new Error("No data rows were found");
    prepareRecords(rows);
  } catch (error) {
    statusBox.textContent = error.message;
    runButton.disabled = true;
    validationBox.classList.add("hidden");
  }
}

function loadPaste() {
  const rows = pasteInput.value.split(/[\n,;]+/).map((taxId, index) => ({ taxId: taxId.trim(), reference: "", rowNumber: index + 1 })).filter((row) => row.taxId);
  if (!rows.length) { statusBox.textContent = "Paste at least one CUIT/CUIL"; return; }
  prepareRecords(rows);
}

async function requestChunk(taxIds) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch("/v1/bulk-checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_ids: taxIds }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(800);
    }
  }
  throw lastError;
}

async function runChecks() {
  if (state.running || !state.uniqueValid.length) return;
  state.running = true;
  runButton.disabled = true;
  resultsSection.classList.add("hidden");
  progressWrap.classList.remove("hidden");
  updateProgress(0, state.uniqueValid.length);

  let completed = 0;
  for (let start = 0; start < state.uniqueValid.length; start += CHUNK_SIZE) {
    const chunk = state.uniqueValid.slice(start, start + CHUNK_SIZE);
    statusBox.textContent = `Checking ${start + 1}-${Math.min(start + CHUNK_SIZE, state.uniqueValid.length)} of ${state.uniqueValid.length}`;
    try {
      const payload = await requestChunk(chunk.map((record) => record.taxId));
      for (const result of payload.results) state.resultsByTaxId.set(result.tax_id, { result, error: null });
      for (const error of payload.errors) state.resultsByTaxId.set(normalizeTaxId(error.tax_id), { result: null, error: error.error });
    } catch (error) {
      for (const record of chunk) state.resultsByTaxId.set(record.taxId, { result: null, error: error.message });
    }
    completed += chunk.length;
    updateProgress(completed, state.uniqueValid.length);
    if (completed < state.uniqueValid.length) await sleep(CHUNK_PAUSE_MS);
  }

  for (const record of state.records) {
    if (record.valid) record.result = state.resultsByTaxId.get(record.taxId) || { result: null, error: "No result" };
  }
  state.running = false;
  runButton.disabled = false;
  statusBox.textContent = "Checks completed";
  renderResults();
}

function updateProgress(done, total) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = `${done} / ${total}`;
}

function resultView(record) {
  if (!record.valid) return { status: "Invalid", tone: "danger", situation: "-", name: "-", amount: 0, source: "-", note: record.error };
  const item = record.result?.result;
  if (!item) return { status: "Error", tone: "danger", situation: "Unavailable", name: "-", amount: 0, source: "-", note: record.result?.error || "No result" };
  const bcra = item.checks.bcra_debtors;
  const source = item.sources.find((entry) => entry.name === "bcra");
  const unavailable = source?.status === "error";
  const noRecord = !unavailable && bcra.worst_situation == null;
  const description = bcra.worst_situation_description || bcra.worst_situation_label || "Unknown";
  return {
    status: unavailable ? "Unavailable" : noRecord ? "No record" : "Completed",
    tone: unavailable ? "danger" : noRecord ? "warning" : bcra.worst_situation <= 1 ? "ok" : "warning",
    situation: unavailable ? "Unavailable" : noRecord ? "No record" : `Situación ${bcra.worst_situation} - ${description}`,
    name: item.subject.name || "Not found",
    amount: bcra.debt_amount_ars || 0,
    source: source?.mode || "unknown",
    note: source?.message || "OK",
    item,
  };
}

function renderResults() {
  const views = state.records.map((record) => ({ record, view: resultView(record) }));
  const completed = views.filter(({ view }) => view.status === "Completed").length;
  const unavailable = views.filter(({ view }) => view.status === "Unavailable" || view.status === "Error").length;
  const invalid = views.filter(({ view }) => view.status === "Invalid").length;
  const noRecord = views.filter(({ view }) => view.status === "No record").length;
  resultSummary.innerHTML = `${stat("Completed", completed, "ok")}${stat("Unavailable", unavailable, unavailable ? "danger" : "")}${stat("No record", noRecord, noRecord ? "warning" : "")}${stat("Invalid", invalid, invalid ? "danger" : "")}`;
  resultRows.innerHTML = views.map(({ record, view }) => `
    <tr>
      <td>${escapeHtml(record.reference || "-")}</td>
      <td>${escapeHtml(formatTaxId(record.taxId || record.rawTaxId))}${record.duplicate ? '<div class="muted">Duplicate</div>' : ""}</td>
      <td>${escapeHtml(view.name)}</td>
      <td>${escapeHtml(view.situation)}</td>
      <td>${view.amount ? escapeHtml(money.format(view.amount)) : "-"}</td>
      <td>${escapeHtml(view.source)}</td>
      <td><span class="badge ${view.tone}">${escapeHtml(view.status)}</span></td>
    </tr>
  `).join("");
  resultsSection.classList.remove("hidden");
}

async function downloadTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Requests");
  sheet.columns = [{ header: "CUIT", key: "cuit", width: 18 }, { header: "Reference", key: "reference", width: 24 }];
  sheet.addRows([{ cuit: "30715139312", reference: "Customer 001" }, { cuit: "20424596281", reference: "Customer 002" }]);
  styleHeader(sheet);
  await downloadWorkbook(workbook, "nosis-lite-template.xlsx");
}

async function downloadResults() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("BCRA Results");
  sheet.columns = [
    { header: "Reference", key: "reference", width: 22 },
    { header: "CUIT/CUIL", key: "taxId", width: 18 },
    { header: "Name", key: "name", width: 34 },
    { header: "BCRA situation", key: "situation", width: 28 },
    { header: "Situation number", key: "situationNumber", width: 17 },
    { header: "Description", key: "description", width: 28 },
    { header: "Debt amount ARS", key: "amount", width: 20 },
    { header: "Reporting entities", key: "entities", width: 19 },
    { header: "Source", key: "source", width: 12 },
    { header: "Result", key: "status", width: 15 },
    { header: "Checked at", key: "checkedAt", width: 23 },
    { header: "Source note", key: "note", width: 55 },
  ];
  for (const record of state.records) {
    const view = resultView(record);
    const bcra = view.item?.checks?.bcra_debtors;
    sheet.addRow({
      reference: record.reference,
      taxId: formatTaxId(record.taxId || record.rawTaxId),
      name: view.name,
      situation: view.situation,
      situationNumber: bcra?.worst_situation ?? "",
      description: bcra?.worst_situation_description || "",
      amount: view.amount || "",
      entities: bcra?.reporting_entities ?? "",
      source: view.source,
      status: view.status,
      checkedAt: view.item?.checks?.source_freshness?.fetched_at || "",
      note: view.note,
    });
  }
  styleHeader(sheet);
  sheet.getColumn("amount").numFmt = '#,##0';
  sheet.autoFilter = { from: "A1", to: "L1" };
  await downloadWorkbook(workbook, `nosis-lite-results-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B5B" } };
  header.height = 22;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function downloadWorkbook(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

fileTab.addEventListener("click", () => switchMode("file"));
pasteTab.addEventListener("click", () => switchMode("paste"));
fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
loadPasteButton.addEventListener("click", loadPaste);
runButton.addEventListener("click", runChecks);
downloadTemplateButton.addEventListener("click", downloadTemplate);
downloadResultsButton.addEventListener("click", downloadResults);

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); });
}
dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) loadFile(file);
});
