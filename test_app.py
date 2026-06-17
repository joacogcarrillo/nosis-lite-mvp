import unittest
import os

os.environ["BCRA_MODE"] = "fixture"
from app import CheckService, calculate_check_digit, format_tax_id, infer_subject_kind, is_valid_cuit, normalize_tax_id


class TaxIdTests(unittest.TestCase):
    def test_normalize_tax_id(self):
        self.assertEqual(normalize_tax_id("30-70767203-6"), "30707672036")

    def test_valid_checksum(self):
        self.assertTrue(is_valid_cuit("30-70767203-6"))
        self.assertEqual(calculate_check_digit("30-70767203-6"), 6)

    def test_invalid_checksum(self):
        self.assertFalse(is_valid_cuit("30-70767203-5"))

    def test_format_tax_id(self):
        self.assertEqual(format_tax_id("30707672036"), "30-70767203-6")

    def test_kind(self):
        self.assertEqual(infer_subject_kind("30707672036"), "company")
        self.assertEqual(infer_subject_kind("20304050609"), "person")


class CheckServiceTests(unittest.TestCase):
    def test_build_subject(self):
        service = CheckService()
        result = service.build_subject("30-70767203-6")
        self.assertTrue(result["valid"])
        self.assertEqual(result["subject"]["registration_status"], "active")
        self.assertEqual(result["risk"]["bcra_worst_situation"], 1)
        self.assertEqual(result["risk"]["bcra_worst_situation_label"], "normal")
        self.assertEqual(result["risk"]["bcra_worst_situation_description"], "Normal")
        self.assertEqual(result["checks"]["format"]["formatted_tax_id"], "30-70767203-6")
        self.assertEqual(result["checks"]["arca_registration"]["activity_count"], 2)
        self.assertEqual(result["checks"]["bcra_debtors"]["debt_amount_ars"], 1250000)

    def test_rejected_check_totals(self):
        service = CheckService()
        result = service.build_subject("20-30405060-9")
        self.assertEqual(result["checks"]["bcra_debtors"]["worst_situation_label"], "medium_risk")
        self.assertEqual(result["checks"]["bcra_debtors"]["rejected_checks_count"], 1)
        self.assertEqual(result["checks"]["bcra_debtors"]["rejected_checks_amount_ars"], 80000)

    def test_create_check(self):
        service = CheckService()
        result = service.create_check({"tax_id": "30-70767203-6"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["tax_id"], "30707672036")

    def test_bulk_flags_duplicate_occurrences(self):
        service = CheckService()
        result = service.create_bulk_check({"tax_ids": ["30-70767203-6", "30707672036"]})
        self.assertFalse(result["results"][0]["checks"]["local_integrity"]["duplicate_in_request"])
        self.assertTrue(result["results"][1]["checks"]["local_integrity"]["duplicate_in_request"])
        self.assertEqual(result["results"][1]["checks"]["local_integrity"]["request_occurrence"], 2)

    def test_bcra_history_uses_latest_period_for_current_debt(self):
        risk = CheckService._build_risk({
            "summary": "test",
            "debts": [
                {"entity": "BANCO A", "period": "2026-05", "situation": 1, "amount_ars": 100},
                {"entity": "BANCO B", "period": "2026-05", "situation": 2, "amount_ars": 200},
                {"entity": "BANCO A", "period": "2026-04", "situation": 3, "amount_ars": 900},
            ],
            "rejected_checks": [],
        })
        self.assertEqual(risk["latest_period"], "2026-05")
        self.assertEqual(risk["period_count"], 2)
        self.assertEqual(risk["reporting_entities"], 2)
        self.assertEqual(risk["debt_amount_ars"], 300)


if __name__ == "__main__":
    unittest.main()
