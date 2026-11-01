"""UAT matrix R25: validate a TTR batch against TTR-1-0.xsd under XSD 1.1, then prove the
check is not vacuous with two negative controls that must each report exactly one error.

Usage: python scripts/validate_ttr_xml.py <batch.xml>

The validator class matters: xmllint, .NET and xmlschema.XMLSchema (1.0) all ignore
xs:assert and would falsely pass. It must be XMLSchema11.
"""
import re
import sys
from pathlib import Path

import xmlschema

SCHEMA = Path(__file__).resolve().parent.parent / "docs" / "schema" / "TTR-1-0.xsd"


def main(path):
    schema = xmlschema.XMLSchema11(str(SCHEMA))
    xml = Path(path).read_text(encoding="utf-8")
    failures = []

    if schema.XSD_VERSION != "1.1":
        failures.append(f"validator is XSD {schema.XSD_VERSION}, not 1.1")

    errors = list(schema.iter_errors(xml))
    print(f"{type(schema).__name__} {schema.XSD_VERSION}: {len(errors)} error(s) in {path}")
    for error in errors:
        print(f"  {error.reason} at {error.path}")
    if errors:
        failures.append("the batch is not schema-valid")

    # Control 1: a ttr id starting with a digit breaks NCName/xs:ID (context fix #7, first
    # bullet). Forced to a digit, since stripping the prefix only fails for digit-led UUIDs.
    match = re.search(r'<ttr id="ttr-([0-9a-f-]+)"', xml)
    if not match:
        failures.append("control 1: no <ttr id=\"ttr-...\"> found")
    else:
        count = len(list(schema.iter_errors(xml.replace(f"ttr-{match.group(1)}", f"0{match.group(1)}", 1))))
        print(f"control 1 (digit-led ttr id): {count} error(s)")
        if count != 1:
            failures.append(f"control 1 reported {count} errors, expected 1")

    # Control 2: a trust with no isExpressTrust must fail an xs:assert, which proves the
    # asserts are actually evaluated (context fix #7, fourth bullet).
    company = "<businessStructure>C</businessStructure>"
    if company not in xml:
        failures.append("control 2: the batch has no company party, so xs:assert cannot be shown to run")
    else:
        control = list(schema.iter_errors(xml.replace(company, "<businessStructure>T</businessStructure>", 1)))
        print(f"control 2 (trust without isExpressTrust): {len(control)} error(s)")
        if len(control) != 1 or "assertion" not in str(control[0]).lower():
            failures.append(f"control 2 reported {len(control)} errors, expected 1 failed assertion")

    for failure in failures:
        print(f"FAIL: {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
