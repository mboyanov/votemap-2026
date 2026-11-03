"""Build a per-section GeoJSON of runoff results from the CIK results workbook."""

import json
import sys
from collections import defaultdict
from pathlib import Path

import openpyxl

CANDIDATE_BLUE = 4
CANDIDATE_RED = 25

# Columns in the "Точки в протоколи" sheet. Hand-count (Х) and machine (М)
# protocols number their points differently, but the values sit in the same
# columns: list voters, voters added on the day, and voters who signed.
PROTOCOL_REGISTERED = 10
PROTOCOL_ADDED = 11
PROTOCOL_VOTED = 12


def _int(value) -> int:
    return int(value) if value not in (None, "") else 0


def _is_section_id(value) -> bool:
    return isinstance(value, str) and len(value) == 9 and value.isdigit()


def parse_sections(rows) -> dict:
    """Map section ID to location. Sections without coordinates (mobile ПСИК) are skipped."""
    sections = {}
    for r in rows:
        if not _is_section_id(r[0]) or not r[12] or not r[13]:
            continue
        sections[r[0]] = {
            "lat": round(float(r[12]), 6),
            "lng": round(float(r[13]), 6),
            # Abroad there is no EKATTE: "region" is "Извън страната" and "municipality" holds the country.
            "ekatte": r[1] or "",
            "region": r[2],
            "municipality": r[4],
            "settlement": r[5],
            "address": r[6],
        }
    return sections


def parse_protocols(rows) -> dict:
    """Map section ID to registered and voted counts. "Машина" rows hold only machine totals."""
    protocols = {}
    for r in rows:
        if not _is_section_id(r[0]) or r[6] == "Машина":
            continue
        protocols[r[0]] = {
            "registered": _int(r[PROTOCOL_REGISTERED]) + _int(r[PROTOCOL_ADDED]),
            "voted": _int(r[PROTOCOL_VOTED]),
        }
    return protocols


def parse_votes(rows) -> dict:
    """Map section ID to votes per candidate. A section can have several rows per candidate; they add up."""
    votes = defaultdict(lambda: defaultdict(int))
    for r in rows:
        if not _is_section_id(r[0]):
            continue
        votes[r[0]][int(r[6])] += _int(r[8])
    return votes


def _share_blue(blue: int, red: int):
    # Share of the two-candidate vote for the blue candidate; None when nobody voted for either.
    return round(blue / (blue + red), 4) if blue + red else None


def build_feature_collection(sections: dict, protocols: dict, votes: dict) -> dict:
    """One feature per building: sections with the same coordinates are added up."""
    buildings = defaultdict(list)
    for sid in sorted(sections):
        loc = sections[sid]
        proto = protocols.get(sid, {"registered": 0, "voted": 0})
        buildings[(loc["lng"], loc["lat"])].append({
            "id": sid,
            "registered": proto["registered"],
            "voted": proto["voted"],
            "blue": votes.get(sid, {}).get(CANDIDATE_BLUE, 0),
            "red": votes.get(sid, {}).get(CANDIDATE_RED, 0),
        })

    features = []
    for bid, ((lng, lat), members) in enumerate(sorted(buildings.items(), key=lambda kv: kv[1][0]["id"])):
        first = sections[members[0]["id"]]
        # Different address texts can share one geocode (e.g. a village centre); keep each once.
        addresses = list(dict.fromkeys(sections[m["id"]]["address"] for m in members))
        total = {key: sum(m[key] for m in members) for key in ("registered", "voted", "blue", "red")}
        for m in members:
            m["share_blue"] = _share_blue(m["blue"], m["red"])
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "bid": bid,
                "abroad": members[0]["id"].startswith("32"),
                # Unique key for the settlement: many villages share a name, and abroad has no EKATTE.
                "place": first["ekatte"] or first["municipality"] + "|" + first["settlement"],
                "region": first["region"],
                "municipality": first["municipality"],
                "settlement": first["settlement"],
                "address": " / ".join(addresses),
                "n_sections": len(members),
                **total,
                "share_blue": _share_blue(total["blue"], total["red"]),
                "sections": members,
            },
        })
    return {"type": "FeatureCollection", "features": features}


def excluded_summary(sections: dict, protocols: dict, votes: dict) -> dict:
    """Sections with results but no coordinates (mobile ПСИК), so the page can say what is missing."""
    missing = [sid for sid in protocols if sid not in sections]
    return {
        "sections": len(missing),
        "voted": sum(protocols[sid]["voted"] for sid in missing),
        "blue": sum(votes.get(sid, {}).get(CANDIDATE_BLUE, 0) for sid in missing),
        "red": sum(votes.get(sid, {}).get(CANDIDATE_RED, 0) for sid in missing),
    }


def load_workbook(path: Path) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True)
    sheet = lambda name: wb[name].iter_rows(values_only=True)
    candidates = {int(r[0]): r[1] for r in list(sheet("Кандидати"))[1:]}
    sections = parse_sections(sheet("Секции"))
    protocols = parse_protocols(sheet("Точки в протоколи"))
    votes = parse_votes(sheet("Гласове"))
    fc = build_feature_collection(sections, protocols, votes)
    fc["candidates"] = {"blue": candidates[CANDIDATE_BLUE], "red": candidates[CANDIDATE_RED]}
    fc["excluded"] = excluded_summary(sections, protocols, votes)
    return fc


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/pvr202610_tour2.xlsx")
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("web/results.geojson")
    fc = load_workbook(src)
    dst.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_sections = sum(f["properties"]["n_sections"] for f in fc["features"])
    print(f"{n_sections} sections in {len(fc['features'])} buildings -> {dst}")
