import assert from "node:assert/strict";
import { calculateCheckDigit, isValidCuit, normalizeTaxId } from "../src/worker.js";

assert.equal(normalizeTaxId("30-70767203-6"), "30707672036");
assert.equal(calculateCheckDigit("30-70767203-6"), 6);
assert.equal(isValidCuit("30-70767203-6"), true);
assert.equal(isValidCuit("30-70767203-5"), false);

console.log("worker tests OK");
