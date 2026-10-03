"""Privacy gate for Quote Room data/: fail (exit 1) if anything identifying leaks from Gio's private estimates.

Checks every text file under data/ (JSON, MD, TXT, CSV; images are skipped) for:
  1. exact identifiers harvested from the private source estimates: customer / owner / insured / adjuster
     names, VINs, license plates, claim and policy numbers, job numbers, workfile ids, street lines,
     phone numbers and emails;
  2. generic patterns: phone numbers, emails, 17-char VINs, US street addresses, claim/policy labels,
     full dates (finer than month) in the Gio data files.

Prints only counts and file:path locations, never the matched values.
Usage: C:/Python313/python.exe scripts/check_pii.py [--verbose]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SRC = Path("D:/Vault/Enril/deliverables/drive-estimate-ai-discovery-2026-10-03/private/extracted-text")
TEXT_EXT = {".json", ".md", ".txt", ".csv", ".ts", ".html"}

# Public business identifiers that may legitimately appear (the shop itself, its owner/estimator).
ALLOW = {"drive auto body", "gio oseguera", "oseguera, gio", "gio", "oseguera", "hemet", "33975 ca-74", "(951) 268-3006",
         "951-268-3006", "9512683006"}
# Words that look like surnames but are ordinary vocabulary in this app's data.
COMMON = {"front", "rear", "left", "right", "black", "white", "gray", "grey", "silver", "blue", "green", "brown", "red",
          "ford", "lincoln", "jeep", "dodge", "honda", "toyota", "nissan", "hyundai", "kia", "mazda", "subaru", "tesla",
          "chevrolet", "buick", "cadillac", "acura", "lexus", "infiniti", "audi", "volvo", "porsche", "mini", "ram", "gmc",
          "body", "auto", "shop", "insurance", "company", "self", "pay", "repair", "facility", "drive", "collision",
          "quick", "fix", "bayline", "state", "farm", "allstate", "progressive", "geico", "mercury", "infinity", "usaa",
          "none", "same", "owner", "customer", "insured", "street", "road", "lane", "hood", "door", "glass", "panel",
          "young", "king", "long", "martin", "jordan", "grant", "may", "june", "august", "rose", "lee", "le",
          "price", "parts", "labor", "paint", "total", "sport", "plant", "sedan", "coupe", "truck", "wagon", "style"}

PHONE_RE = re.compile(r"(?<!\d)(?:\(\d{3}\)\s?|\d{3}[-. ])\d{3}[-. ]\d{4}(?!\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
VIN_RE = re.compile(r"\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b")
STREET_RE = re.compile(r"\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z]+(?:\s+[A-Za-z]+)?\s+"
                       r"(?:St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Blvd|Ln|Lane|Way|Ct|Court|Pl|Cir|Pkwy|Hwy)\b\.?", re.I)
CLAIM_RE = re.compile(r"\b(claim|policy)\s*(#|no\.?|number)\s*[:#]?\s*[A-Z0-9-]{5,}", re.I)
FULLDATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/20\d{2})\b")


def harvest() -> dict[str, set[str]]:
    """Collect identifying values from the private source texts (kept in memory only)."""
    found: dict[str, set[str]] = {"name": set(), "surname": set(), "vin": set(), "plate": set(), "claim": set(),
                                  "phone": set(), "email": set(), "street": set(), "job": set()}
    if not SRC.exists():
        print("WARN: private source folder not found; running pattern checks only")
        return found
    for p in SRC.glob("*.txt"):
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        for i, ln in enumerate(lines):
            for label in ("Customer:", "Insured:", "Adjuster:", "Appraiser:", "Owner:", "Claimant:"):
                if label in ln:
                    seg = ln.split(label, 1)[1]
                    seg = re.split(r"\s{2,}|Job Number|Policy|Claim|,\s*\(", seg)[0].strip()
                    if label == "Owner:" and not seg and i + 1 < len(lines):
                        seg = re.split(r"\s{2,}", lines[i + 1].strip())[0]
                    if label == "Adjuster:":
                        seg = ", ".join(seg.split(",")[:2])
                    add_name(found, seg)
            m = re.search(r"VIN:\s*([A-HJ-NPR-Z0-9]{11,17})", ln)
            if m: found["vin"].add(m.group(1))
            m = re.search(r"License:\s*([A-Z0-9]{4,8})\b", ln)
            if m: found["plate"].add(m.group(1))
            for m in re.finditer(r"(?:Claim|Policy)\s*#:?\s*([A-Z0-9-]{5,})", ln, re.I):
                if re.search(r"\d", m.group(1)):
                    found["claim"].add(m.group(1))
            for m in re.finditer(r"Job (?:Number|#):\s*(\d{4,})", ln):
                found["job"].add(m.group(1))
            for m in PHONE_RE.finditer(ln):
                found["phone"].add(re.sub(r"\D", "", m.group(0)))
            for m in EMAIL_RE.finditer(ln):
                found["email"].add(m.group(0).lower())
            for m in STREET_RE.finditer(ln):
                found["street"].add(m.group(0).lower())
    found["phone"] -= {"9512683006"}
    found["street"] = {s for s in found["street"] if "33975" not in s}
    return found


def add_name(found, seg: str):
    seg = re.sub(r"[^A-Za-z ,.'-]", " ", seg).strip(" ,.")
    if not seg or len(seg) < 3 or seg.lower() in ALLOW:
        return
    parts = [x.strip() for x in seg.split(",") if x.strip()]
    if len(parts) >= 2:  # LAST, FIRST
        last, first = parts[0], parts[1].split()[0] if parts[1].split() else ""
    else:
        toks = seg.split()
        if len(toks) < 2:
            return
        first, last = toks[0], toks[-1]
    if first and last:
        found["name"].add(f"{first} {last}".lower())
        found["name"].add(f"{last}, {first}".lower())
    if last and len(last) >= 5 and last.lower() not in COMMON and last.lower() not in ALLOW:
        found["surname"].add(last.lower())


def main():
    verbose = "--verbose" in sys.argv
    known = harvest()
    print("harvested source identifiers (counts only):", {k: len(v) for k, v in known.items()})
    files = [p for p in DATA.rglob("*") if p.is_file() and p.suffix.lower() in TEXT_EXT]
    problems: list[tuple[str, str, int]] = []
    for p in files:
        text = p.read_text(encoding="utf-8", errors="replace")
        low = text.lower()
        rel = p.relative_to(ROOT).as_posix()
        digits_only = re.sub(r"\D", "", text)
        hits = {}
        for name in known["name"]:
            if re.search(r"\b" + re.escape(name) + r"\b", low):
                hits["source_full_name"] = hits.get("source_full_name", 0) + 1
        for sn in known["surname"]:
            if re.search(r"\b" + re.escape(sn) + r"\b", low):
                hits["source_surname"] = hits.get("source_surname", 0) + 1
        for k in ("vin", "plate", "claim"):
            for v in known[k]:
                if len(v) >= 5 and re.search(r"(?<![A-Za-z0-9])" + re.escape(v) + r"(?![A-Za-z0-9])", text, re.I):
                    hits[f"source_{k}"] = hits.get(f"source_{k}", 0) + 1
        for v in known["phone"]:
            if v in digits_only:
                if PHONE_RE.search(text) or len(v) == 10:
                    # confirm as a formatted phone, not a substring of a longer number run
                    if any(re.sub(r"\D", "", m.group(0)) == v for m in PHONE_RE.finditer(text)):
                        hits["source_phone"] = hits.get("source_phone", 0) + 1
        for v in known["email"]:
            if v in low:
                hits["source_email"] = hits.get("source_email", 0) + 1
        for v in known["street"]:
            if v in low:
                hits["source_street"] = hits.get("source_street", 0) + 1
        # generic patterns
        for m in PHONE_RE.finditer(text):
            if re.sub(r"\D", "", m.group(0)) not in {"9512683006"}:
                hits["phone_pattern"] = hits.get("phone_pattern", 0) + 1
        for m in EMAIL_RE.finditer(text):
            hits["email_pattern"] = hits.get("email_pattern", 0) + 1
        for m in VIN_RE.finditer(text):
            hits["vin_pattern"] = hits.get("vin_pattern", 0) + 1
        for m in STREET_RE.finditer(text):
            if "33975" not in m.group(0):
                hits["street_pattern"] = hits.get("street_pattern", 0) + 1
        for m in CLAIM_RE.finditer(text):
            hits["claim_pattern"] = hits.get("claim_pattern", 0) + 1
        if rel.startswith("data/gio/") or rel == "data/catalog.json":
            for m in FULLDATE_RE.finditer(text):
                hits["full_date_in_gio_data"] = hits.get("full_date_in_gio_data", 0) + 1
            for v in known["job"]:
                if re.search(r"(?<!\d)" + re.escape(v) + r"(?!\d)", text) and len(v) >= 5:
                    hits["source_job_number"] = hits.get("source_job_number", 0) + 1
        for k, c in hits.items():
            problems.append((rel, k, c))
        if verbose:
            print(f"  scanned {rel}: {sum(hits.values())} hits")
    print(f"scanned {len(files)} text files under data/")
    if problems:
        print("PII CHECK FAILED:")
        for rel, k, c in problems:
            print(f"  {rel}: {k} x{c}")
        sys.exit(1)
    print("PII CHECK PASSED: no names, phones, emails, VINs, plates, claim/policy numbers, addresses or exact dates found.")


if __name__ == "__main__":
    main()
