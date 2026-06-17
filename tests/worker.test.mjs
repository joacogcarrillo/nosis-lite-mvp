import assert from "node:assert/strict";
import {
  calculateCheckDigit,
  inferTaxIdType,
  isValidCuit,
  normalizeBcraResponse,
  normalizeTaxId,
} from "../src/worker.js";

assert.equal(normalizeTaxId("30-70767203-6"), "30707672036");
assert.equal(calculateCheckDigit("30-70767203-6"), 6);
assert.equal(isValidCuit("30-70767203-6"), true);
assert.equal(isValidCuit("30-70767203-5"), false);
assert.equal(inferTaxIdType("30-70767203-6"), "CUIT");
assert.equal(inferTaxIdType("20-30405060-9"), "CUIL");

const normalized = normalizeBcraResponse(
  {
    results: {
      denominacion: "TEST SA",
      periodos: [
        { periodo: "202605", entidades: [
          { entidad: "BANCO A", situacion: 1, monto: 100 },
          { entidad: "BANCO B", situacion: 2, monto: 200 },
        ] },
        { periodo: "202604", entidades: [{ entidad: "BANCO A", situacion: 3, monto: 400 }] },
      ],
    },
  },
  { results: { causales: [{ causal: "Sin fondos", entidades: [{ entidad: "BANCO A", rechazados: [
    { fechaRechazo: "2026-05-01", nroCheque: "123", importe: 500 },
  ] }] }] } },
);
assert.equal(normalized.debts.length, 3);
assert.equal(normalized.debts[0].period, "2026-05");
assert.deepEqual(normalized.rejected_checks[0], {
  period: "2026-05-01", entity: "BANCO A", reason: "Sin fondos", count: 1, amount_ars: 500,
  check_number: "123", paid_at: null,
});

console.log("worker tests OK");
