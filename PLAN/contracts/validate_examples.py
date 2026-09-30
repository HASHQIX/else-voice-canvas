"""Validate bundled examples; does not call any provider or run an application."""
from pathlib import Path
import json
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]

def load(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))

def main():
    for schema_name, fixture_name in (("preview.schema.json", "preview.valid.json"),
                                      ("final-plan.schema.json", "final-plan.valid.json")):
        schema = load("contracts/" + schema_name)
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(load("fixtures/" + fixture_name))
        print("VALID:", fixture_name)
    plan = load("fixtures/final-plan.valid.json")
    transcript = load("fixtures/transcript-stream.json")["expected"]["finalText"]
    for item in plan["statements"]:
        for source in item["sourceRefs"]:
            assert source["quote"] in transcript, "Missing source quote"
    cases = load("fixtures/acceptance-cases.json")["cases"]
    assert len({case["id"] for case in cases}) == len(cases)
    assert all(case["status"] == "NOT_RUN" for case in cases)
    print("VALID: source quotes and", len(cases), "unique NOT_RUN cases")
    print("This is validation of reference assets, not a live application test.")

if __name__ == "__main__":
    main()
