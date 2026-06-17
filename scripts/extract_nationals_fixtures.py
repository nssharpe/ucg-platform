#!/usr/bin/env python3
"""Extract golden regression fixtures from Jules Pierce's NAIGC tool.

Source repo (read-only reference, NOT vendored): jules-pierce/naigc-2024
This dev-time script pulls the input spreadsheets, the known-good `solutions/`
outputs, and the per-discipline `config.ini` cutoff files for 2024 & 2025, and
writes them as JSON fixtures under tests/fixtures/nationals/. The TypeScript
parity tests (tests/nationals/*) feed each `input` through the ported engine and
assert it reproduces `expected` exactly.

Run once (needs `gh` authenticated with read access to the private repo):
    python scripts/extract_nationals_fixtures.py

Raw downloads are cached under .jtmp/raw/ so re-runs are offline-fast.
"""
from __future__ import annotations
import base64
import configparser
import json
import subprocess
from pathlib import Path

import pandas as pd

REPO = "jules-pierce/naigc-2024"
YEARS = ["2024", "2025"]
PHASES = ["prelims", "finals"]
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / ".jtmp" / "raw"
OUT = ROOT / "tests" / "fixtures" / "nationals"

# Columns dropped from input/solution records: noise or non-JSON-friendly (dates).
DROP_COLS = {"DOB", "CompNum", "Bib"}


def gh_download(path: str) -> bytes:
    """Download a repo file (base64 via the contents API), cached on disk."""
    cache = RAW / path
    if cache.exists():
        return cache.read_bytes()
    b64 = subprocess.run(
        ["gh", "api", f"repos/{REPO}/contents/{path}", "--jq", ".content"],
        capture_output=True, text=True, check=True,
    ).stdout
    data = base64.b64decode(b64)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)
    return data


def list_paths() -> list[str]:
    out = subprocess.run(
        ["gh", "api", f"repos/{REPO}/git/trees/HEAD?recursive=1", "--jq", ".tree[].path"],
        capture_output=True, text=True, check=True,
    ).stdout
    return out.splitlines()


def xlsx_records(path: str, sheet=0) -> list[dict]:
    raw = gh_download(path)
    cache = RAW / path
    df = pd.read_excel(cache, sheet_name=sheet)
    df = df.drop(columns=[c for c in DROP_COLS if c in df.columns], errors="ignore")
    # pandas to_json maps NaN->null and keeps bools/floats JSON-native.
    return json.loads(df.to_json(orient="records", date_format="iso"))


def xlsx_all_sheets(path: str) -> dict[str, list[dict]]:
    cache = RAW / path
    gh_download(path)
    xl = pd.ExcelFile(cache)
    out = {}
    for sh in xl.sheet_names:
        df = xl.parse(sh).drop(columns=[c for c in DROP_COLS if c in xl.parse(sh).columns], errors="ignore")
        out[sh] = json.loads(df.to_json(orient="records", date_format="iso"))
    return out


def parse_config(path: str) -> dict:
    cfg = configparser.ConfigParser()
    cfg.optionxform = str  # preserve key case (level codes are case-sensitive)
    cfg.read_string(gh_download(path).decode("utf-8"))
    return {sec: dict(cfg.items(sec)) for sec in cfg.sections()}


def exists(paths: set[str], p: str) -> bool:
    return p in paths


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    paths = set(list_paths())
    manifest = []

    for year in YEARS:
        for phase in PHASES:
            disciplines = ["wag", "mag", "tnt"] if phase == "prelims" else ["wag", "mag"]
            for disc in disciplines:
                data_p = f"{year}/{phase}/data/{disc}.xlsx"
                sol_p = f"{year}/{phase}/solutions/{disc}_results.xlsx"
                if not (exists(paths, data_p) and exists(paths, sol_p)):
                    continue
                fixture = {
                    "meta": {"year": year, "phase": phase, "discipline": disc, "source": REPO},
                    "config": parse_config(f"{year}/{phase}/config/{disc}/config.ini"),
                    "input": xlsx_records(data_p),
                    "expected": xlsx_records(sol_p),
                }
                team_p = f"{year}/{phase}/solutions/{disc}_team_results.xlsx"
                if exists(paths, team_p):
                    fixture["expectedTeam"] = xlsx_records(team_p)
                web_p = f"{year}/{phase}/solutions/{disc}_website_results.xlsx"
                if exists(paths, web_p):
                    fixture["expectedWebsite"] = xlsx_records(web_p)
                teamweb_p = f"{year}/{phase}/solutions/{disc}_team_website_results.xlsx"
                if exists(paths, teamweb_p):
                    fixture["expectedTeamWebsite"] = xlsx_records(teamweb_p)

                fname = f"{year}_{phase}_{disc}.json"
                (OUT / fname).write_text(json.dumps(fixture, indent=1))
                manifest.append(fname)
                print(f"wrote {fname}  ({len(fixture['input'])} input, {len(fixture['expected'])} expected)")

        # combined-discipline awards (prelims only)
        for combo in ["decathlon", "omnithon"]:
            sol_p = f"{year}/prelims/solutions/{combo}_results.xlsx"
            if exists(paths, sol_p):
                fixture = {
                    "meta": {"year": year, "phase": "prelims", "discipline": combo, "source": REPO},
                    "expected": xlsx_records(sol_p),
                }
                fname = f"{year}_prelims_{combo}.json"
                (OUT / fname).write_text(json.dumps(fixture, indent=1))
                manifest.append(fname)
                print(f"wrote {fname}  ({len(fixture['expected'])} expected)")

        # validation reports (multi-sheet)
        for vp, label in [
            (f"{year}/prelims/solutions/prelims_validation_results.xlsx", f"{year}_prelims_validation.json"),
            (f"{year}/finals/solutions/finals_validation_results.xlsx", f"{year}_finals_validation.json"),
            (f"{year}/finals/solutions/finals_pre_validation_results.xlsx", f"{year}_finals_prevalidation.json"),
        ]:
            if exists(paths, vp):
                fixture = {"meta": {"year": year, "source": REPO}, "expected": xlsx_all_sheets(vp)}
                (OUT / label).write_text(json.dumps(fixture, indent=1))
                manifest.append(label)
                print(f"wrote {label}")

    (OUT / "manifest.json").write_text(json.dumps(sorted(manifest), indent=1))
    print(f"\n{len(manifest)} fixtures -> {OUT}")


if __name__ == "__main__":
    main()
