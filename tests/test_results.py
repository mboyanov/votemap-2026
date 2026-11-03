from votemap.results import build_feature_collection, excluded_summary, parse_protocols, parse_sections, parse_votes


def section_row(sid, lat="42.0", lng="23.1"):
    return (sid, "02676", "Благоевград", "0101", "Банско", "гр.Банско", "АДРЕС", 0, 1, 0, 0, 0, lat, lng)


def protocol_row(sid, kind, a, p1, p2, registered, added, voted):
    return (sid, "02676", "Благоевград", "0101", "Банско", "гр.Банско", kind, a, p1, p2, registered, added, voted) + ("",) * 17


def vote_row(sid, candidate, total):
    return (sid, "02676", "Благоевград", "0101", "Банско", "гр.Банско", candidate, "Име", total, 0, total, total, 0)


def test_section_without_coordinates_is_skipped():
    # GIVEN a mobile section with empty coordinates and a normal section
    rows = [section_row("012800011", lat="", lng=""), section_row("010100001")]
    # WHEN the sections are parsed
    sections = parse_sections(rows)
    # THEN only the section with coordinates remains
    assert list(sections) == ["010100001"]


def test_header_rows_are_skipped():
    # GIVEN the header row of the sections sheet
    rows = [("Номер на СИК", "ЕКАТТЕ") + ("",) * 12, section_row("010100001")]
    # WHEN the sections are parsed
    sections = parse_sections(rows)
    # THEN the header is not read as a section
    assert list(sections) == ["010100001"]


def test_machine_protocol_reads_registered_and_voted():
    # GIVEN a machine (М) protocol followed by its "Машина" totals row
    rows = [
        protocol_row("010100001", "М", 600, 1, 599, 631, 4, 253),
        ("010100001", "02676", "Благоевград", "0101", "Банско", "гр.Банско", "Машина") + ("",) * 20 + (253, 251, 2),
    ]
    # WHEN the protocols are parsed
    protocols = parse_protocols(rows)
    # THEN registered includes voters added on the day, and the "Машина" row does not overwrite it
    assert protocols["010100001"] == {"registered": 635, "voted": 253}


def test_hand_count_protocol_uses_same_columns():
    # GIVEN a hand-count (Х) protocol, where "voted" is point 4 instead of point 5
    rows = [protocol_row("010100002", "Х", 500, 2, 300, 450, 3, 198)]
    # WHEN the protocols are parsed
    protocols = parse_protocols(rows)
    # THEN the counts come from the same columns
    assert protocols["010100002"] == {"registered": 453, "voted": 198}


def test_votes_from_several_rows_add_up():
    # GIVEN two rows per candidate for one section, one of them all zeros
    rows = [vote_row("010100013", 25, 0), vote_row("010100013", 25, 235), vote_row("010100013", 4, 114), vote_row("010100013", 4, 0)]
    # WHEN the votes are parsed
    votes = parse_votes(rows)
    # THEN each candidate gets the sum
    assert votes["010100013"] == {25: 235, 4: 114}


def location(lat=42.0, lng=23.1, address="АДРЕС", ekatte="02676", municipality="Банско", settlement="гр.Банско"):
    return {"lat": lat, "lng": lng, "ekatte": ekatte, "region": "Благоевград",
            "municipality": municipality, "settlement": settlement, "address": address}


def test_section_keeps_place_fields():
    # GIVEN a section row with EKATTE, region and municipality
    rows = [section_row("010100001")]
    # WHEN the sections are parsed
    section = parse_sections(rows)["010100001"]
    # THEN the place fields are kept for search
    assert (section["ekatte"], section["region"], section["municipality"]) == ("02676", "Благоевград", "Банско")


def test_place_key_is_ekatte_in_bulgaria():
    # GIVEN a building in Bulgaria
    sections = {"010100001": location()}
    # WHEN the feature collection is built
    props = build_feature_collection(sections, {}, {})["features"][0]["properties"]
    # THEN the place key is the EKATTE code
    assert props["place"] == "02676"


def test_place_key_abroad_is_country_and_city():
    # GIVEN a section abroad, which has no EKATTE and has the country in the municipality field
    sections = {"320010003": location(ekatte="", municipality="Австралия", settlement="Канбера")}
    # WHEN the feature collection is built
    props = build_feature_collection(sections, {}, {})["features"][0]["properties"]
    # THEN the place key combines country and city
    assert props["place"] == "Австралия|Канбера"


def test_feature_has_lng_first_and_blue_share():
    # GIVEN one section with 30 votes for 4 and 10 for 25
    sections = {"010100001": location()}
    protocols = {"010100001": {"registered": 100, "voted": 42}}
    votes = {"010100001": {4: 30, 25: 10}}
    # WHEN the feature collection is built
    feature = build_feature_collection(sections, protocols, votes)["features"][0]
    # THEN coordinates are [lng, lat] and the share is 30 / 40
    assert feature["geometry"]["coordinates"] == [23.1, 42.0]
    assert feature["properties"]["share_blue"] == 0.75
    assert feature["properties"]["voted"] == 42


def test_sections_at_same_coordinates_become_one_building():
    # GIVEN two sections in one school and one section elsewhere
    sections = {"010100001": location(), "010100002": location(), "010100003": location(lat=42.5)}
    protocols = {
        "010100001": {"registered": 100, "voted": 50},
        "010100002": {"registered": 200, "voted": 70},
        "010100003": {"registered": 10, "voted": 5},
    }
    votes = {"010100001": {4: 40, 25: 10}, "010100002": {4: 0, 25: 60}, "010100003": {4: 5, 25: 0}}
    # WHEN the feature collection is built
    features = build_feature_collection(sections, protocols, votes)["features"]
    # THEN the school is one feature with summed counts and a share from the sums, not an average of shares
    assert len(features) == 2
    school = features[0]["properties"]
    assert school["n_sections"] == 2
    assert (school["registered"], school["voted"], school["blue"], school["red"]) == (300, 120, 40, 70)
    assert school["share_blue"] == round(40 / 110, 4)


def test_building_keeps_per_section_detail():
    # GIVEN two sections in one building
    sections = {"010100001": location(), "010100002": location()}
    votes = {"010100001": {4: 30, 25: 10}, "010100002": {4: 0, 25: 0}}
    # WHEN the feature collection is built
    members = build_feature_collection(sections, {}, votes)["features"][0]["properties"]["sections"]
    # THEN each section keeps its own ID, counts and share
    assert [m["id"] for m in members] == ["010100001", "010100002"]
    assert members[0]["share_blue"] == 0.75
    assert members[1]["share_blue"] is None


def test_different_addresses_at_same_coordinates_are_all_kept():
    # GIVEN two sections geocoded to one point but with different address texts, one of them repeated
    sections = {"1": location(address="ЧИТАЛИЩЕ"), "2": location(address="УЧИЛИЩЕ"), "3": location(address="ЧИТАЛИЩЕ")}
    sections = {f"01010000{k}": v for k, v in sections.items()}
    # WHEN the feature collection is built
    props = build_feature_collection(sections, {}, {})["features"][0]["properties"]
    # THEN each address text shows once, in section order
    assert props["address"] == "ЧИТАЛИЩЕ / УЧИЛИЩЕ"


def test_section_with_no_votes_for_either_has_no_share():
    # GIVEN a section where nobody voted for 4 or 25
    sections = {"321360492": location(lat=35.67, lng=139.69)}
    # WHEN the feature collection is built
    props = build_feature_collection(sections, {}, {})["features"][0]["properties"]
    # THEN the share is None, so the map can paint it as "no data", and the building is marked abroad
    assert props["share_blue"] is None
    assert props["abroad"] is True


def test_excluded_summary_counts_sections_without_coordinates():
    # GIVEN one mapped section and one mobile section that has results but no coordinates
    sections = {"010100001": location()}
    protocols = {"010100001": {"registered": 100, "voted": 50}, "012800011": {"registered": 30, "voted": 20}}
    # WHEN the excluded summary is built
    summary = excluded_summary(sections, protocols)
    # THEN it counts only the mobile section
    assert summary == {"sections": 1, "voted": 20}
