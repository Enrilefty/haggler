"""Build anonymized Gio Oseguera (Drive Auto Body) estimate data for Quote Room v2.

Reads the PRIVATE discovery archive (read only) and writes three anonymized files:
  data/catalog.json, data/gio/history.json, data/gio/playbook.json

Nothing free-text from the source estimates is written: only catalog ids, operations,
part types, hours, prices, totals, vehicle year/make/model and the month (YYYY-MM).
Customer, owner, insured, adjuster, address, phone, VIN, plate, claim/policy numbers,
part numbers, line notes and exact dates are never copied.

Usage:  C:/Python313/python.exe scripts/build_gio_data.py [--survey]
Then:   C:/Python313/python.exe scripts/check_pii.py
"""
from __future__ import annotations

import csv
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path("D:/Vault/Enril/deliverables/drive-estimate-ai-discovery-2026-10-03/private")
TEXT_DIR = SRC / "extracted-text"
OUT_CATALOG = ROOT / "data" / "catalog.json"
OUT_HISTORY = ROOT / "data" / "gio" / "history.json"
OUT_PLAYBOOK = ROOT / "data" / "gio" / "playbook.json"

# --------------------------------------------------------------------------- catalog
# id, label, area (front|rear|side|top|any), kind, ops (names only; hours filled from data),
# default hours per op, default part prices {oem, aftermarket, used} or None,
# mechHours, fixedCharge, aliases (customer/agent words), match rules (section regex, desc regex).
#
# ops vocabulary: repair | replace | refinish | blend | r&i | add
#   "add" is the single op for procedures and materials (scan, calibration, tint, ...).
F = "front"; R = "rear"; S = "side"; T = "top"; A = "any"

CATALOG_SPEC = [
    # ---- front visible
    dict(id="front-bumper-cover", label="Front bumper cover", area=F, kind="visible",
         ops={"repair": (2.0, 3.0), "replace": (3.4, 3.0), "refinish": (0, 3.0), "r&i": (1.2, 0), "blend": (0, 1.5)},
         parts=(650, 380, 260), aliases=["front bumper", "bumper cover", "front fascia"],
         rules=[(r"FRONT BUMPER", r"bumper cover|^cover$|fascia|o/h front bumper|front bumper$|bumper assy|^bumper$")]),
    dict(id="front-grille", label="Grille", area=F, kind="visible", ops={"replace": (0.3, 0), "r&i": (0.3, 0)},
         parts=(320, 180, 120), aliases=["grille", "grill", "lower grille"],
         rules=[(r"FRONT BUMPER|GRILLE", r"grille(?! (retainer|clip|bracket|screw|nut))")]),
    dict(id="front-bumper-trim", label="Front bumper moldings & emblem", area=F, kind="visible",
         ops={"replace": (0.2, 0), "r&i": (0.2, 0)}, parts=(90, 60, 40),
         aliases=["front emblem", "bumper molding", "chrome trim", "tow hook cover"],
         rules=[(r"FRONT BUMPER|GRILLE", r"molding|emblem|tow eye|tow hook|ornament|nameplate|garnish")]),
    dict(id="front-impact-bar", label="Front bumper reinforcement (impact bar)", area=F, kind="hidden",
         ops={"replace": (0.6, 0)}, parts=(380, 240, 150), aliases=["impact bar", "bumper reinforcement", "rebar"],
         rules=[(r"FRONT BUMPER|GRILLE", r"impact bar|reinf(orcement)? (bar|beam)|^reinforcement$|bumper reinf")]),
    dict(id="front-energy-absorber", label="Front energy absorber", area=F, kind="hidden",
         ops={"replace": (0.2, 0)}, parts=(140, 90, 50), aliases=["energy absorber", "absorber", "foam absorber", "bumper foam"],
         rules=[(r"FRONT BUMPER|GRILLE", r"absorber"), (r"MISC|OTHER|^$", r"absorber")]),
    dict(id="front-bumper-brackets", label="Front bumper brackets & retainers", area=F, kind="hidden",
         ops={"replace": (0.2, 0)}, parts=(45, 30, None), aliases=["bumper bracket", "bumper retainer", "side bracket"],
         rules=[(r"FRONT BUMPER|GRILLE", r"bracket|brkt|brace|retainer|reinf|support|guide|stay|clip|license")]),
    dict(id="front-lower-shield", label="Air deflectors, shields & ducts", area=F, kind="hidden",
         ops={"replace": (0.3, 0), "r&i": (0.3, 0)}, parts=(110, 70, None),
         aliases=["splash shield", "lower deflector", "under cover", "air dam"],
         rules=[(None, r"(lower|air|front|engine|under) (deflector|shield|cover|baffle)|splash shield|air dam|undercover"), (r"FRONT|RADIATOR|COOLING|AIR COND|GRILLE|FENDER", r"sight shield|shutter|air duct|duct|side seal|air guide|deflector|baffle")]),
    dict(id="headlamp-assembly", label="Headlamp assembly", area=F, kind="visible",
         ops={"replace": (0.3, 0), "r&i": (0.3, 0)}, parts=(780, 320, 420), aliases=["headlight", "headlamp", "head light", "left headlamp", "right headlamp"],
         rules=[(None, r"head ?lamp assy|headlamp assembly|head ?light assy|^headlamp$|headlamp(?! (bracket|repair|retainer|aim|adjuster))")]),
    dict(id="headlamp-brackets", label="Headlamp mounting brackets / repair kit", area=F, kind="hidden",
         ops={"replace": (0.2, 0)}, parts=(60, 35, None), aliases=["headlamp tabs", "headlight bracket"],
         rules=[(None, r"headlamp (bracket|repair|retainer|mount|support)|lamp (bracket|repair kit)")]),
    dict(id="aim-headlamps", label="Aim headlamps", area=F, kind="procedure", ops={"add": (0.5, 0)}, parts=None,
         aliases=["headlamp aim"], rules=[(None, r"aim head ?lamps?")]),
    dict(id="fog-drl-lamp", label="Fog / daytime running lamp", area=F, kind="visible",
         ops={"replace": (0.3, 0), "r&i": (0.2, 0)}, parts=(220, 110, 80), aliases=["fog light", "drl"],
         rules=[(None, r"fog ?lamp|fog light|daytime run|drl|turn signal lamp|park(ing)? lamp|side marker")]),
    dict(id="hood", label="Hood", area=F, kind="visible",
         ops={"repair": (2.5, 3.0), "replace": (1.8, 3.6), "refinish": (0, 3.6), "blend": (0, 1.8), "r&i": (1.0, 0)},
         parts=(900, 520, 380), aliases=["bonnet", "hood panel"],
         rules=[(r"HOOD", r"^hood|hood panel|hood w|^panel$")]),
    dict(id="hood-hinges-latch", label="Hood hinges & latch", area=F, kind="hidden",
         ops={"replace": (0.3, 0.4)}, parts=(90, 60, None), aliases=["hood hinge", "hood latch"],
         rules=[(r"HOOD", r"hinge|latch|strut|lift support|release cable|insulat|seal")]),
    dict(id="radiator-support", label="Radiator support", area=F, kind="hidden",
         ops={"repair": (2.0, 0), "replace": (2.4, 0)}, parts=(560, 420, None),
         aliases=["rad support", "core support", "tie bar"],
         rules=[(None, r"radiator support|rad(iator)? supp|core support|tie bar|upper support|lower support")]),
    dict(id="condenser", label="A/C condenser", area=F, kind="hidden", ops={"replace": (1.3, 0), "r&i": (1.3, 0)},
         parts=(380, 170, None), mech=1.3, aliases=["ac condenser"], rules=[(None, r"condenser")]),
    dict(id="radiator", label="Radiator & cooling module", area=F, kind="hidden",
         ops={"replace": (0, 0), "r&i": (0, 0)}, parts=(420, 210, None), mech=1.5,
         aliases=["radiator", "cooling fan", "intercooler"],
         rules=[(None, r"radiator assy|^radiator|fan assy|fan shroud|intercooler|aux cooler|trans cooler|cooler")]),
    dict(id="ac-service", label="A/C evacuate & recharge", area=F, kind="procedure", ops={"add": (0, 0)}, parts=None,
         mech=1.4, aliases=["ac recharge", "refrigerant"], rules=[(None, r"ac service|a/c service|evacuate|recharge|refrigerant")]),
    dict(id="front-fender", label="Front fender", area=F, kind="visible", sided=True,
         ops={"repair": (2.5, 2.2), "replace": (2.0, 2.6), "refinish": (0, 2.2), "blend": (0, 1.1), "r&i": (1.2, 0)},
         parts=(380, 170, 140), aliases=["fender", "front quarter", "left front fender", "right front fender"],
         rules=[(r"FENDER", r"^fender|^panel$|fender panel|fender w")]),
    dict(id="fender-liner", label="Fender liner", area=F, kind="hidden", sided=True,
         ops={"replace": (0.4, 0), "r&i": (0.4, 0)}, parts=(130, 75, None), aliases=["wheelhouse liner", "inner fender"],
         rules=[(None, r"(fender|wheelhouse|splash) liner|inner fender|wheel ?well liner|^liner|mud ?guard|splash guard|mud flap")]),
    dict(id="windshield", label="Windshield", area=F, kind="visible", ops={"replace": (2.5, 0), "r&i": (2.0, 0)},
         parts=(620, 380, None), aliases=["windscreen", "front glass"], rules=[(None, r"windshield(?! (pillar|plr))|urethane kit")]),
    dict(id="parking-sensors", label="Parking sensors", area=A, kind="hidden", ops={"replace": (0.3, 0), "r&i": (0.2, 0)},
         parts=(140, 70, None), aliases=["park assist sensor", "ultrasonic sensor", "backup sensor"],
         rules=[(None, r"park(ing)? (assist )?sensor|park aid|ultrasonic|object sensor|parking aid|sensor bracket")]),
    dict(id="radar-camera", label="Front radar / camera sensor", area=F, kind="hidden",
         ops={"replace": (0.4, 0), "r&i": (0.3, 0)}, parts=(950, None, 500), aliases=["radar", "cruise sensor", "front camera"],
         rules=[(None, r"radar|distance sensor|cruise (control )?sensor|front camera|camera|sensor module|lidar")]),
    dict(id="airbag-impact-sensor", label="Airbag impact sensor", area=A, kind="hidden", ops={"replace": (0.3, 0)},
         parts=(190, None, None), aliases=["front impact sensor", "impact sensor", "crash sensor"],
         rules=[(None, r"impact sensor|crash sensor|air ?bag sensor")]),
    # ---- sides
    dict(id="front-door", label="Front door", area=S, kind="visible", sided=True,
         ops={"repair": (3.0, 2.8), "replace": (3.5, 3.2), "refinish": (0, 2.8), "blend": (0, 1.4), "r&i": (1.5, 0)},
         parts=(950, 520, 380), aliases=["driver door", "passenger door", "door"],
         rules=[(r"FRONT DOOR", r"door shell|^door$|door panel|outer panel|^shell|door assy|^door w|repair panel|outer skin|skin")]),
    dict(id="rear-door", label="Rear door", area=S, kind="visible", sided=True,
         ops={"repair": (3.0, 2.6), "replace": (3.5, 3.0), "refinish": (0, 2.6), "blend": (0, 1.3), "r&i": (1.5, 0)},
         parts=(950, 520, 380), aliases=["back door", "rear passenger door"],
         rules=[(r"REAR DOOR", r"door shell|^door$|door panel|outer panel|^shell|door assy|^door w|repair panel|outer skin|skin")]),
    dict(id="door-trim", label="Door moldings, handle & trim", area=S, kind="visible", sided=True,
         ops={"replace": (0.3, 0.3), "r&i": (0.3, 0)}, parts=(90, 50, 40), aliases=["door handle", "door molding", "belt molding"],
         rules=[(r"DOOR", r"molding|handle|applique|belt|trim|weatherstrip|w'strip|water (deflector|shield)|garnish|emblem|nameplate")]),
    dict(id="side-mirror", label="Outside mirror", area=S, kind="visible", sided=True,
         ops={"replace": (0.4, 0.5), "r&i": (0.4, 0), "refinish": (0, 0.6)}, parts=(380, 120, 110),
         aliases=["side mirror", "wing mirror", "mirror"],
         rules=[(None, r"mirror|mirror glass|mirror cover|mirror assy")]),
    dict(id="rocker-panel", label="Rocker panel / molding", area=S, kind="visible", sided=True,
         ops={"repair": (2.0, 1.8), "replace": (3.5, 2.2), "r&i": (1.1, 0), "refinish": (0, 1.8)}, parts=(160, 90, None),
         aliases=["rocker", "side skirt"], rules=[(None, r"rocker|side sill|sill (panel|molding)|side skirt")]),
    dict(id="wheel-tire", label="Wheel / tire", area=S, kind="visible", sided=True,
         ops={"replace": (0.3, 0), "repair": (0, 0)}, parts=(420, 210, 160), aliases=["rim", "wheel", "tire"],
         rules=[(None, r"^(alloy |aluminum |steel )?wheel|^rim|^tire|wheel assy|tpms|hub cap|wheel cover")]),
    dict(id="suspension-parts", label="Suspension / steering part", area=S, kind="hidden", sided=True,
         ops={"replace": (0, 0)}, parts=(240, 130, 90), mech=1.2, aliases=["control arm", "tie rod", "strut"],
         rules=[(None, r"control arm|cntrl arm|tie rod|knuckle|strut|stabilizer|sway bar|link|ball joint|axle|steering|subframe|cradle|gear assy")]),
    # ---- rear
    dict(id="quarter-panel", label="Quarter panel", area=R, kind="visible", sided=True,
         ops={"repair": (4.0, 3.0), "replace": (12.0, 3.6), "refinish": (0, 3.0), "blend": (0, 1.5)}, parts=(780, 450, None),
         aliases=["rear quarter", "rear fender", "quarter"], rules=[(r"QUARTER", r"quarter panel|^panel$|outer panel|quarter outer|^quarter"), (r"PICK UP BOX|SIDE PANEL", r"outer panel|side panel|^panel|box side|bedside")]),
    dict(id="rear-bumper-cover", label="Rear bumper cover", area=R, kind="visible",
         ops={"repair": (2.0, 3.0), "replace": (2.8, 3.0), "refinish": (0, 3.0), "r&i": (1.2, 0), "blend": (0, 1.5)},
         parts=(620, 360, 250), aliases=["rear bumper", "back bumper", "rear fascia"],
         rules=[(r"REAR BUMPER", r"bumper cover|^cover$|fascia|o/h rear bumper|rear bumper$|bumper assy|^bumper$")]),
    dict(id="rear-impact-bar", label="Rear bumper reinforcement", area=R, kind="hidden", ops={"replace": (0.6, 0)},
         parts=(360, 220, 140), aliases=["rear impact bar", "rear rebar"],
         rules=[(r"REAR BUMPER", r"impact bar|reinf(orcement)? (bar|beam)|^reinforcement$|bumper reinf")]),
    dict(id="rear-energy-absorber", label="Rear energy absorber", area=R, kind="hidden", ops={"replace": (0.2, 0)},
         parts=(120, 80, None), aliases=["rear absorber"], rules=[(r"REAR BUMPER", r"absorber")]),
    dict(id="rear-bumper-brackets", label="Rear bumper brackets & trim", area=R, kind="hidden", ops={"replace": (0.2, 0)},
         parts=(45, 30, None), aliases=["rear bumper bracket", "step pad"],
         rules=[(r"REAR BUMPER", r"bracket|brkt|brace|retainer|reinf|support|guide|clip|molding|step pad|reflector|valance|emblem")]),
    dict(id="tail-lamp", label="Tail lamp", area=R, kind="visible", sided=True, ops={"replace": (0.3, 0), "r&i": (0.3, 0)},
         parts=(320, 150, 120), aliases=["taillight", "tail light", "brake light"],
         rules=[(None, r"tail ?lamp|tail ?light|stop lamp|back.?up lamp|rear lamp|combination lamp|combo lamp|license lamp")]),
    dict(id="trunk-liftgate", label="Trunk lid / liftgate", area=R, kind="visible",
         ops={"repair": (2.5, 3.0), "replace": (2.5, 3.6), "refinish": (0, 3.0), "r&i": (1.0, 0)}, parts=(950, 520, 420),
         aliases=["trunk", "decklid", "liftgate", "tailgate", "hatch"],
         rules=[(r"TRUNK|LID|GATE|HATCH", r"trunk lid|deck ?lid|lift ?gate|tail ?gate|hatch|^lid|^panel$|^gate|shell"), (None, r"tailgate assy|liftgate assy|trunk lid|deck ?lid")]),
    dict(id="rear-body-panel", label="Rear body panel / trunk floor", area=R, kind="hidden",
         ops={"repair": (3.0, 1.0), "replace": (8.0, 1.5)}, parts=(320, None, None),
         aliases=["rear panel", "back panel", "trunk floor"],
         rules=[(None, r"rear body panel|back panel|rear panel|trunk floor|rear floor|lower back|tail panel|rear crossmember")]),
    dict(id="back-glass", label="Back glass", area=R, kind="visible", ops={"replace": (2.0, 0)}, parts=(420, 260, None),
         aliases=["rear window", "rear glass"], rules=[(None, r"back glass|rear glass|back window")]),
    # ---- top
    dict(id="roof-panel", label="Roof panel", area=T, kind="visible",
         ops={"repair": (4.0, 3.2), "replace": (14.0, 3.8), "refinish": (0, 3.2)}, parts=(820, None, None),
         aliases=["roof", "top"], rules=[(r"ROOF", r"roof panel|^roof$|^panel$|outer panel")]),
    dict(id="roof-trim", label="Roof moldings / rails / sunroof trim", area=T, kind="visible",
         ops={"replace": (0.4, 0), "r&i": (0.4, 0)}, parts=(150, 90, None), aliases=["roof rack", "roof molding"],
         rules=[(r"ROOF", r"molding|rail|rack|antenna|spoiler|trim|ditch"), (None, r"roof (molding|rail|rack|ditch)")]),
    dict(id="pillar", label="Pillar (A/B/C)", area=S, kind="hidden", sided=True, ops={"repair": (3.0, 1.5), "r&i": (0.2, 0)},
         parts=None, aliases=["a pillar", "b pillar", "windshield pillar"], rules=[(None, r"^((center|front|rear|lock|hinge|windshield|w/s|a|b|c) )?pillar(?! (trim|molding|mldg|garnish))")]),
    # ---- procedures
    dict(id="pre-repair-scan", label="Pre-repair scan", area=A, kind="procedure", ops={"add": (0, 0)}, parts=None, mech=0.5,
         aliases=["pre scan", "diagnostic scan", "pre post scans"], rules=[(None, r"pre-?(repair )?scan|pre repair scan")]),
    dict(id="post-repair-scan", label="Post-repair scan", area=A, kind="procedure", ops={"add": (0, 0)}, parts=None, mech=0.5,
         aliases=["post scan"], rules=[(None, r"post-?(repair )?scan|post repair scan")]),
    dict(id="adas-calibration", label="ADAS calibration", area=A, kind="procedure", ops={"add": (0, 0)}, parts=None,
         mech=1.0, fixed=250, aliases=["camera calibration", "radar calibration", "sensor calibration"],
         rules=[(None, r"calibrat|adas|aim (radar|camera|sensor)")]),
    dict(id="wheel-alignment", label="4-wheel alignment", area=A, kind="procedure", ops={"add": (0, 0)}, parts=None,
         mech=1.0, aliases=["alignment"], rules=[(None, r"align|alignment|wheel align")]),
    dict(id="airbag-diagnosis", label="Airbag / SRS system check", area=A, kind="procedure", ops={"add": (0, 0)}, parts=None,
         mech=0.5, aliases=["srs check"], rules=[(None, r"air ?bag system|srs|restraint")]),
    dict(id="frame-setup-pull", label="Frame setup & pull", area=A, kind="procedure", ops={"add": (2.0, 0)}, parts=None,
         aliases=["frame pull", "rough pull", "frame straightening"],
         rules=[(None, r"rough pull|sheet ?metal pull|frame (repair|pull|set ?up|straighten)|^frame$|set ?up (and|&) measure|setup & measure|measure|structural repair|unibody")]),
    dict(id="battery-disconnect", label="Disconnect / reconnect battery", area=A, kind="procedure", ops={"add": (0.2, 0)},
         parts=None, aliases=["battery reset"], rules=[(None, r"battery(?! tray)|reset (clock|radio|windows)|radio reset")]),
    dict(id="cooling-pressure-test", label="Cooling system refill & pressure test", area=F, kind="procedure",
         ops={"add": (0, 0)}, parts=None, mech=1.0, aliases=["coolant refill"],
         rules=[(None, r"pressure test|coolant|antifreeze|bleed cooling|drain (&|and) refill")]),
    # ---- materials
    dict(id="color-tint", label="Color tint / color match", area=A, kind="materials", ops={"add": (0, 0.5)}, parts=None,
         aliases=["tint", "color match"], rules=[(None, r"color tint|^tint|color match|spray out|let down")]),
    dict(id="blend-adjacent-panel", label="Blend adjacent panel", area=A, kind="materials", ops={"add": (0, 1.5)}, parts=None,
         aliases=["blend", "blend panel"], rules=[]),  # filled from every Blnd line
    dict(id="color-sand-buff", label="Color sand & buff / de-nib", area=A, kind="materials", ops={"add": (0, 1.0)}, parts=None,
         aliases=["sand and buff", "denib"], rules=[(None, r"sand (and|&) buff|denib|de-nib|polish|buff")]),
    dict(id="flex-additive", label="Flex additive", area=A, kind="materials", ops={"add": (0, 0.2)}, parts=None,
         fixed=12, aliases=["flex agent"], rules=[(None, r"flex")]),
    dict(id="hazardous-waste", label="Hazardous waste disposal", area=A, kind="materials", ops={"add": (0, 0)}, parts=None,
         fixed=8, aliases=["haz waste"], rules=[(None, r"hazardous|haz waste|waste removal|disposal")]),
    dict(id="cover-car", label="Cover car for overspray", area=A, kind="materials", ops={"add": (0.2, 0)}, parts=None,
         fixed=15, aliases=["masking", "cover vehicle"], rules=[(None, r"cover car|cover vehicle|car cover|cover/bag|cover interior|mask")]),
    dict(id="corrosion-protection", label="Corrosion protection, seam sealer & adhesives", area=A, kind="materials", ops={"add": (0.5, 0)},
         parts=None, fixed=25, aliases=["cavity wax", "seam sealer"],
         rules=[(None, r"corrosion|cavity wax|seam seal|weld.?thru|weld(ing)? protection|panel bond|adhesive|anti.?corrosion|undercoat|rust")]),
    dict(id="clean-for-delivery", label="Clean for delivery", area=A, kind="materials", ops={"add": (0.5, 0)}, parts=None,
         aliases=["detail", "wash"], rules=[(None, r"clean (for|vehicle)|clean up|^detail|wash(?!er)")]),
    dict(id="feather-prime-block", label="Feather, prime & block", area=A, kind="materials", ops={"add": (0, 0.5)}, parts=None,
         aliases=["prime and block"], rules=[(None, r"feather|prime (and|&) block|primer|block sand")]),
]

# Paint-only "add for" lines (clear coat, underside, edging, two tone) follow the panel they belong to.
ATTACH_RE = re.compile(r"^(add for|overlap|deduct for overlap|clear coat|prep unprimed)", re.I)
SKIP_RE = re.compile(r"information label|^emission label|^ac label|^tow\b|towing|storage|^labels?$|sublet|rental|admin|"
                     r"r&i wheel|^[<>~*\s]+$|^\*+|total loss|collision access|^/|"
                     r"^misc|^note|^parts? (discount|markup)|^shipping|^freight", re.I)

MAKES = {"ACUR": "Acura", "ALFA": "Alfa Romeo", "AUDI": "Audi", "BMW": "BMW", "BUIC": "Buick", "CADI": "Cadillac",
         "CHEV": "Chevrolet", "CHRY": "Chrysler", "DODG": "Dodge", "FIAT": "Fiat", "FORD": "Ford", "GENE": "Genesis",
         "GMC": "GMC", "HOND": "Honda", "HYUN": "Hyundai", "INFI": "Infiniti", "JAGU": "Jaguar", "JEEP": "Jeep",
         "KIA": "Kia", "LAND": "Land Rover", "LEXS": "Lexus", "LINC": "Lincoln", "MAZD": "Mazda", "MERZ": "Mercedes-Benz",
         "MINI": "Mini", "MITS": "Mitsubishi", "NISS": "Nissan", "POLE": "Polestar", "PORS": "Porsche", "RAM": "Ram",
         "RIVI": "Rivian", "SUBA": "Subaru", "TESL": "Tesla", "TOYO": "Toyota", "VOLK": "Volkswagen", "VOLV": "Volvo",
         "SCIO": "Scion", "SMRT": "Smart", "PONT": "Pontiac", "SATU": "Saturn", "MERC": "Mercury", "HUMM": "Hummer"}

OP_MAP = {"repl": "replace", "rpl": "replace", "r&r": "replace", "rpr": "repair", "r&i": "r&i", "refn": "refinish",
          "blnd": "blend", "o/h": "overhaul", "subl": "sublet", "algn": "add", "sect": "replace"}

LINE_RE = re.compile(
    r"^\s{0,4}(\d{1,3})\s+(\*\*|\*|#)?\s*(S\d{2})?\s*"
    r"(Repl|Rpl|Rpr|R&I|R&R|Blnd|Refn|O/H|Subl|Algn|Sect)?(?=\s)(.*)$")
FIELD_RE = re.compile(r"\S+(?: \S+)*")
PRICE_RE = re.compile(r"^-?[\d,]+\.\d{2}(?: [mTXA])?$")
HOUR_RE = re.compile(r"^(-?\d+\.\d)(?: ([MSFEDGP]))?$|^Incl\.$")
PARTNO_RE = re.compile(r"^(?=.*\d)[A-Z0-9][A-Z0-9-]{4,}$")
SECTION_RE = re.compile(r"^[A-Z0-9 &/,.'()-]+$")


def norm_desc(desc: str) -> tuple[str, str | None, str]:
    """Return (clean description, side L/R/None, part type) from a CCC description."""
    d = re.sub(r"^(R&I|Repl|Rpr|Refn|Blnd|R&R)\s+", "", desc.strip(), flags=re.I)
    ptype = "OEM"
    low = d.lower()
    if re.search(r"\b(lkq|used|recycled)\b", low):
        ptype = "LKQ"
    elif re.search(r"\b(recond|reman|remanufactured|rechromed)\b", low):
        ptype = "Reman"
    elif re.search(r"\bcapa\b", low):
        ptype = "CAPA"
    elif re.search(r"a/m|non oem|aftermarket|\bnsf\b", low):
        ptype = "A/M"
    d = re.sub(r"\b(A/M|Non OEM|CAPA|NSF|LKQ|USED|Recond|Reman|OPT OEM|OEM|KEYSIQ|PARTSLINK)\b", " ", d, flags=re.I)
    d = re.sub(r"[+-]\d+%", " ", d)
    side = None
    m = re.search(r"\b(LT|RT|Left|Right)\b", d)
    if m:
        side = "L" if m.group(1).lower() in ("lt", "left") else "R"
    d = re.sub(r"\b(LT|RT|Left|Right|Ft|Front|Rr|Rear)\b", lambda x: x.group(0) if x.group(0).lower() in ("front", "rear") else " ", d)
    d = re.sub(r"\s+", " ", d).strip()
    return d, side, ptype


def parse_doc(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    out = {"lines": [], "vehicle": None, "poi": None, "grand_total": None, "insurance_pay": None,
           "customer_pay": None, "self_pay_label": "SELF PAY" in text.upper(), "insurer_named": False,
           "software": "CCC ONE" if "CCC ONE" in text else ("Mitchell" if "Mitchell" in text else "unknown")}
    for i, ln in enumerate(lines):
        if out["vehicle"] is None:
            m = re.match(r"^\s*((?:19|20)\d{2})\s+([A-Z]{2,5})\s+([A-Za-z0-9-]+)(?:\s+([A-Za-z0-9-]+))?", ln)
            if m and m.group(2) in MAKES:
                model = m.group(3)
                nxt = m.group(4) or ""
                if model in ("Grand", "Santa", "Model", "Super", "Range", "Town", "Land", "Crown", "Transit") and nxt:
                    model = f"{model} {nxt}"
                elif model.isdigit() and nxt in ("Series", "Duty"):
                    model = f"{model} {nxt}"
                out["vehicle"] = {"year": int(m.group(1)), "make": MAKES[m.group(2)], "model": model}
        if out["poi"] is None and ln.strip().startswith("Point of Impact:"):
            out["poi"] = ln.split(":", 1)[1].strip().split("  ")[0].strip()
        if "Insurance Company:" in ln and i + 1 < len(lines):
            col = ln.index("Insurance Company:")
            nxt = lines[i + 1][col:col + 40].strip() if len(lines[i + 1]) > col else ""
            if nxt and not re.match(r"^\(?\d", nxt):
                out["insurer_named"] = True
        m = re.match(r"^\s*Grand Total\s+([\d,]+\.\d{2})", ln)
        if m:
            out["grand_total"] = float(m.group(1).replace(",", ""))
        m = re.match(r"^\s*INSURANCE PAY\s+([\d,]+\.\d{2})", ln)
        if m:
            out["insurance_pay"] = float(m.group(1).replace(",", ""))
        m = re.match(r"^\s*CUSTOMER PAY\s+([\d,]+\.\d{2})", ln)
        if m:
            out["customer_pay"] = float(m.group(1).replace(",", ""))

    # line items, column-aware
    labor_col = paint_col = None
    section = ""
    in_items = False
    pair_ends = []
    for ln in lines:
        if re.match(r"^\s*Line\s+Oper\s+Description", ln):
            in_items = True
            labor_col = ln.find("Labor")
            paint_col = ln.find("Paint")
            continue
        if not in_items:
            continue
        if re.match(r"^\s*(SUBTOTALS|ESTIMATE TOTALS)", ln):
            in_items = False
            continue
        m = LINE_RE.match(ln)
        if not m:
            continue
        no, mark, sup, oper, rest = m.groups()
        rest_start = m.start(5)
        # split fields on 2+ spaces only (single spaces stay inside descriptions)
        fields = []
        for fm in re.finditer(r"(?:\S+(?: (?! )\S+)*)", rest):
            fields.append((fm.group(0), rest_start + fm.start(), rest_start + fm.end()))
        if not fields:
            continue
        desc = fields[0][0]
        nums = fields[1:]
        if not oper and not nums and SECTION_RE.match(desc) and desc.upper() == desc and not mark:
            section = desc.strip()
            continue
        price = None; labor = None; paint = None; mech = None; qty = 1; partno = False
        hours = []
        for val, s, e in nums:
            if PRICE_RE.match(val) and price is None and not HOUR_RE.match(val):
                price = float(val.split()[0].replace(",", ""))
            elif HOUR_RE.match(val):
                hours.append((val, s, e))
            elif re.match(r"^\d{1,3}$", val):
                qty = int(val)
            elif PARTNO_RE.match(val):
                partno = True
            elif val in ("m", "M", "T", "X"):
                continue
        assigned = []
        for val, s, e in hours:
            if val == "Incl.":
                assigned.append(("incl", None, s, e)); continue
            hm = HOUR_RE.match(val)
            num = float(hm.group(1)); tag = hm.group(2)
            if tag == "M":
                mech = (mech or 0) + num; continue
            assigned.append(("h", num, s, e))
        single = None
        if len(assigned) >= 2:
            labor = assigned[0][1]; paint = assigned[1][1]
            pair_ends.append((assigned[0][3], assigned[1][3]))
        elif len(assigned) == 1 and assigned[0][1] is not None:
            single = (assigned[0][1], assigned[0][3])
        d_clean, side, ptype = norm_desc(desc)
        op = OP_MAP.get((oper or "").lower(), "add" if not oper else oper.lower())
        if op == "replace" and price is None:
            ptype = None
        if op != "replace":
            ptype = None
        out["lines"].append({
            "no": int(no), "section": section, "desc": d_clean, "raw_op": oper or "", "op": op,
            "sup": sup, "manual": mark == "#", "side": side, "partType": ptype, "price": price, "qty": qty,
            "labor": labor, "paint": paint, "mech": mech, "_single": single,
        })
    if pair_ends:
        le = statistics.median(a for a, _ in pair_ends)
        pe = statistics.median(b for _, b in pair_ends)
    else:
        le = pe = None
    for ln in out["lines"]:
        sg = ln.pop("_single")
        if not sg:
            continue
        num, e = sg
        if le is not None and pe is not None and pe > le:
            to_paint = abs(e - pe) < abs(e - le)
        else:
            to_paint = ln["raw_op"].lower() in ("refn", "blnd") or ln["desc"].lower().startswith(("add for", "color", "tint"))
        if to_paint:
            ln["paint"] = num
        else:
            ln["labor"] = num
    return out


# --------------------------------------------------------------------------- mapping
COMPILED = []
for item in sorted(CATALOG_SPEC, key=lambda c: 0 if c["kind"] in ("procedure", "materials") else 1):
    for sec, rx in item.get("rules", []):
        COMPILED.append((item["id"], re.compile(sec) if sec else None, re.compile(rx, re.I)))
CAT_BY_ID = {c["id"]: c for c in CATALOG_SPEC}


PANEL_IDS = {"front-bumper-cover", "rear-bumper-cover", "hood", "front-fender", "front-door", "rear-door",
             "quarter-panel", "trunk-liftgate", "roof-panel", "rocker-panel", "front-grille", "headlamp-assembly", "tail-lamp"}
PANEL_EXCLUDE_RE = re.compile(r"liner|molding|mldg|bracket|brkt|clip|seal|insulat|emblem|nameplate|hinge|latch|striker|"
                              r"handle|retainer|support|brace|flare|garnish|applique|decal|stripe|tape|bulb|socket|harness|"
                              r"wiring|gasket|screw|bolt|nut\b|grommet|absorber|reinf|guide|deflector|shield|cover cap", re.I)
HARDWARE_RE = re.compile(r"\b(clips?|retainers?|nuts?|screws?|bolts?|fasteners?|grommets?|rivets?|push pins?|pins?|studs?|"
                         r"rivet|tape|bulb|socket|plug)\b", re.I)


def map_line(ln: dict) -> str | None:
    desc = ln["desc"]
    if SKIP_RE.search(desc):
        return None
    hardware = HARDWARE_RE.search(desc)
    for cid, sec_rx, rx in COMPILED:
        if sec_rx is not None and not sec_rx.search(ln["section"] or ""):
            continue
        if cid in PANEL_IDS and PANEL_EXCLUDE_RE.search(desc):
            continue
        if hardware and not cid.endswith("brackets"):
            continue
        if rx.search(desc):
            return cid
    # section fallback for bare panel names like "Panel" / "Shell"
    return None


def area_of_poi(poi: str | None) -> set[str]:
    if not poi:
        return set()
    p = poi.lower()
    a = set()
    if "front" in p: a.add("front")
    if "rear" in p: a.add("rear")
    if "left" in p: a.add("left")
    if "right" in p: a.add("right")
    if "roof" in p or "top" in p: a.add("top")
    m = re.match(r"^(\d{1,2})\b", p)
    if m and not a:
        h = int(m.group(1))
        a |= {12: {"front"}, 1: {"front", "right"}, 2: {"front", "right"}, 3: {"right"}, 4: {"rear", "right"},
              5: {"rear", "right"}, 6: {"rear"}, 7: {"rear", "left"}, 8: {"rear", "left"}, 9: {"left"},
              10: {"front", "left"}, 11: {"front", "left"}}.get(h, set())
    return a


def consolidate(doc_lines: list[dict]) -> tuple[list[dict], list[str], int, int]:
    """Collapse raw estimate lines into one entry per (catalogId, op family). Returns
    (lines, supplementAddedIds, mapped_count, candidate_count)."""
    items: dict[str, dict] = {}
    order: list[str] = []
    sup_added: list[str] = []
    last_key = None
    orig_ids: set[str] = set()
    mapped = cand = 0
    for ln in doc_lines:
        desc = ln["desc"]
        if ATTACH_RE.match(desc):
            if last_key and ln["paint"]:
                items[last_key]["refinishHours"] = round(items[last_key]["refinishHours"] + ln["paint"], 1)
            continue
        if SKIP_RE.search(desc):
            continue
        cand += 1
        cid = map_line(ln)
        op = ln["op"]
        if op == "blend" and cid and CAT_BY_ID[cid]["kind"] == "visible":
            # keep the panel identity, op=blend; also count the generic blend material
            pass
        if not cid:
            last_key = None
            continue
        mapped += 1
        cat = CAT_BY_ID[cid]
        if cat["kind"] in ("procedure", "materials"):
            op = "add"
        elif op == "overhaul":
            op = "r&i"  # O/H labor is merged into the cover's replace/r&i entry below
        elif op in ("add", "sublet"):
            op = "replace" if ln["price"] else "repair"
        key = cid + ("|" + ln["side"] if (cat.get("sided") and ln["side"]) else "")
        e = items.get(key)
        if e is None:
            e = {"catalogId": cid, "op": op, "partType": None, "bodyHours": 0.0, "refinishHours": 0.0,
                 "mechHours": 0.0, "partPrice": None, "_side": set()}
            items[key] = e; order.append(key)
        rank = {"replace": 5, "repair": 4, "refinish": 3, "blend": 2, "r&i": 1, "add": 0}
        if rank.get(op, 0) > rank.get(e["op"], 0):
            e["op"] = op
        if ln["labor"]:
            e["bodyHours"] = round(e["bodyHours"] + ln["labor"], 1)
        if ln["paint"]:
            e["refinishHours"] = round(e["refinishHours"] + ln["paint"], 1)
        if ln["mech"]:
            e["mechHours"] = round(e["mechHours"] + ln["mech"], 1)
        if ln["op"] == "replace" and ln["price"] is not None:
            unit = ln["price"] / max(ln["qty"], 1) if ln["qty"] and ln["qty"] > 1 else ln["price"]
            if e["partPrice"] is None or unit > e["partPrice"]:
                e["partPrice"] = round(unit, 2); e["partType"] = ln["partType"]
        if ln["side"]:
            e["_side"].add(ln["side"])
        if ln["sup"]:
            if cid not in sup_added:
                sup_added.append(cid)
        else:
            orig_ids.add(cid)
        if ln["op"] == "blend":
            b = items.get("blend-adjacent-panel")
            if b is None:
                b = {"catalogId": "blend-adjacent-panel", "op": "add", "partType": None, "bodyHours": 0.0,
                     "refinishHours": 0.0, "mechHours": 0.0, "partPrice": None, "_side": set()}
                items["blend-adjacent-panel"] = b; order.append("blend-adjacent-panel")
            b["refinishHours"] = round(b["refinishHours"] + (ln["paint"] or 0), 1)
            if ln["sup"] and "blend-adjacent-panel" not in sup_added:
                sup_added.append("blend-adjacent-panel")
        last_key = key
    sup_added = [c for c in sup_added if c not in orig_ids]
    return [items[k] for k in order], sup_added, mapped, cand


# --------------------------------------------------------------------------- build
def median(xs):
    return round(statistics.median(xs), 1) if xs else None


def main(survey: bool = False):
    rows = list(csv.DictReader(open(SRC / "estimate-index.csv", encoding="utf-8-sig")))
    payer_audit = json.load(open(SRC / "payer-label-audit.json", encoding="utf-8"))
    selfpay_sha = {d["sha256"] for d in payer_audit["documents"]}
    stage_occ = Counter(r["stage"] for r in rows)

    # unique documents (by sha256), keep first occurrence row
    seen = {}
    for r in rows:
        seen.setdefault(r["sha256"], r)
    docs = list(seen.values())

    parsed = {}
    skipped = Counter()
    for r in docs:
        if r["author_status"] == "other_estimator":
            skipped["other_estimator"] += 1; continue
        if r["charge_sheet_review"] == "True":
            skipped["charge_sheet"] += 1; continue
        p = TEXT_DIR / f"{r['document_id']}.txt"
        if r["classification_basis"] != "full_pdf_text" or not p.exists():
            skipped["ocr_first_page_only"] += 1; continue
        d = parse_doc(p)
        if len(d["lines"]) < 3:
            skipped["no_line_items"] += 1; continue
        d["row"] = r
        parsed[r["sha256"]] = d

    if survey:
        secs = Counter(); unm = Counter()
        for d in parsed.values():
            for ln in d["lines"]:
                secs[ln["section"]] += 1
                if not ATTACH_RE.match(ln["desc"]) and not SKIP_RE.search(ln["desc"]) and not map_line(ln):
                    unm[(ln["section"], ln["desc"].lower()[:40])] += 1
        print("SECTIONS", secs.most_common(60))
        print("UNMAPPED", unm.most_common(120))
        return

    # group into jobs by candidate_case_id
    by_case = defaultdict(list)
    for sha, d in parsed.items():
        by_case[d["row"]["candidate_case_id"]].append(d)

    stage_rank = {"preliminary": 0, "estimate": 1, "supplement": 2, "estimate_of_record": 3}
    jobs = []
    total_mapped = total_cand = 0
    for case_id in sorted(by_case):
        versions = sorted(by_case[case_id], key=lambda d: (stage_rank.get(d["row"]["stage"], 0), d["row"]["date"]))
        final = versions[-1]
        first = versions[0]
        lines, sup_added, mapped, cand = consolidate(final["lines"])
        total_mapped += mapped; total_cand += cand
        # set-difference adds when a preliminary and later version both exist
        if len(versions) > 1 and stage_rank.get(first["row"]["stage"], 0) < stage_rank.get(final["row"]["stage"], 0):
            prelim_ids = {x["catalogId"] for x in consolidate(first["lines"])[0]}
            for x in lines:
                if x["catalogId"] not in prelim_ids and x["catalogId"] not in sup_added:
                    sup_added.append(x["catalogId"])
        if not lines:
            continue
        is_self = any(v["row"]["sha256"] in selfpay_sha or v["self_pay_label"] for v in versions)
        is_ins = any(v["insurer_named"] or (v["insurance_pay"] or 0) > 0 for v in versions)
        payer = "self_pay" if is_self else ("insurance" if is_ins else "unknown")
        areas = area_of_poi(final["poi"])
        for x in lines:
            cat = CAT_BY_ID[x["catalogId"]]
            if cat["kind"] == "visible" and x["op"] in ("replace", "repair"):
                if cat["area"] in ("front", "rear", "top"):
                    areas.add(cat["area"])
                for s in x["_side"]:
                    if cat["area"] in ("side", "front", "rear") and cat.get("sided"):
                        areas.add("left" if s == "L" else "right")
        has_supp = any(v["row"]["stage"] in ("supplement", "estimate_of_record") for v in versions)
        out_lines = []
        for x in lines:
            o = {"catalogId": x["catalogId"], "op": x["op"]}
            if x["partType"] and x["op"] == "replace":
                o["partType"] = x["partType"]
            o["bodyHours"] = x["bodyHours"]; o["refinishHours"] = x["refinishHours"]
            if x["mechHours"]:
                o["mechHours"] = x["mechHours"]
            if x["partPrice"] is not None:
                o["partPrice"] = x["partPrice"]
            if x["_side"]:
                o["side"] = "left" if x["_side"] == {"L"} else ("right" if x["_side"] == {"R"} else "both")
            out_lines.append(o)
        jobs.append({
            "id": None, "month": final["row"]["date"][:7], "payer": payer,
            "vehicle": final["vehicle"] or first["vehicle"],
            "areas": sorted(areas, key=["front", "rear", "left", "right", "top"].index),
            "stage": final["row"]["stage"], "versions": len(versions), "hasSupplement": has_supp,
            "software": final["software"],
            "lines": out_lines,
            "total": round(final["grand_total"]) if final["grand_total"] else None,
            "preliminaryTotal": round(first["grand_total"]) if (len(versions) > 1 and first["grand_total"]) else None,
            "supplementAdds": sup_added if has_supp else [],
        })
    jobs.sort(key=lambda j: j["month"])
    for i, j in enumerate(jobs, 1):
        j["id"] = f"job-{i:03d}"
        if j["preliminaryTotal"] is None:
            del j["preliminaryTotal"]

    # ------------------------------------------------------------ catalog medians
    obs = defaultdict(lambda: defaultdict(lambda: {"body": [], "paint": [], "n": 0}))
    prices = defaultdict(lambda: defaultdict(list))
    mech_obs = defaultdict(list)
    for j in jobs:
        for ln in j["lines"]:
            o = obs[ln["catalogId"]][ln["op"]]
            o["n"] += 1
            if ln["bodyHours"] > 0: o["body"].append(ln["bodyHours"])
            if ln["refinishHours"] > 0: o["paint"].append(ln["refinishHours"])
            if ln.get("mechHours"): mech_obs[ln["catalogId"]].append(ln["mechHours"])
            if ln.get("partPrice") and ln.get("partType"):
                bucket = {"OEM": "oem", "A/M": "aftermarket", "CAPA": "aftermarket", "LKQ": "used", "Reman": "used"}[ln["partType"]]
                prices[ln["catalogId"]][bucket].append(ln["partPrice"])

    catalog_items = []
    coverage = Counter()
    for spec in CATALOG_SPEC:
        cid = spec["id"]
        ops = {}
        ev_n = 0
        any_data = False
        for op, (db, dp) in spec["ops"].items():
            o = obs[cid].get(op)
            entry = {}
            used_data = False
            if o and len(o["body"]) >= 3:
                entry["bodyHours"] = median(o["body"]); used_data = True
            elif db:
                entry["bodyHours"] = db
            if o and len(o["paint"]) >= 3:
                entry["refinishHours"] = median(o["paint"]); used_data = True
            elif dp:
                entry["refinishHours"] = dp
            if op == "replace" and spec.get("parts"):
                entry["needsPart"] = True
            entry["evidence"] = f"n={o['n']}" if (o and used_data) else ("default" if not o else f"n={o['n']} (hours default)")
            if o:
                ev_n += o["n"]
            any_data = any_data or used_data
            ops[op] = entry
        parts = None
        if spec.get("parts"):
            po, pa, pu = spec["parts"]
            parts = {}
            pev = {}
            for k, dflt in (("oem", po), ("aftermarket", pa), ("used", pu)):
                xs = prices[cid].get(k, [])
                if len(xs) >= 3:
                    parts[k] = round(statistics.median(xs)); pev[k] = f"n={len(xs)}"
                else:
                    parts[k] = dflt; pev[k] = "default" if not xs else f"n={len(xs)} (default)"
            # sanity: a used/aftermarket median above OEM means mixed assemblies; fall back to ratios of OEM
            if parts.get("oem"):
                for k, ratio in (("aftermarket", 0.6), ("used", 0.5)):
                    if parts.get(k) is not None and parts[k] > parts["oem"]:
                        parts[k] = round(parts["oem"] * ratio); pev[k] += " (capped below OEM)"
            parts_evidence = pev
        mech = spec.get("mech", 0)
        if len(mech_obs[cid]) >= 3:
            mech = median(mech_obs[cid])
        item = {"id": cid, "label": spec["label"], "area": spec["area"], "kind": spec["kind"], "ops": ops,
                "parts": parts, "mechHours": mech, "fixedCharge": spec.get("fixed", 0),
                "evidence": f"n={ev_n}" if any_data else ("default" if ev_n == 0 else f"n={ev_n} (hours default)"),
                "aliases": spec["aliases"]}
        if spec.get("sided"):
            item["sided"] = True
        if parts:
            item["partsEvidence"] = parts_evidence
        catalog_items.append(item)
        coverage["from_data" if any_data else ("seen_default_hours" if ev_n else "default")] += 1

    catalog = {"version": 1,
               "note": "Hours/prices are medians from Gio's estimates (Drive Auto Body, anonymized) where n>=3, else industry defaults marked default. "
                       "ops: repair|replace|refinish|blend|r&i for parts and panels; procedures and materials use the single op 'add'. "
                       "area: front|rear|side|top|any (sided items need a left/right note).",
               "items": catalog_items}

    # ------------------------------------------------------------ playbook
    def jobs_for(payer, area=None):
        return [j for j in jobs if j["payer"] == payer and (area is None or area in j["areas"])]

    AREAS = ["front", "rear", "left", "right", "top"]
    kinds = {c["id"]: c["kind"] for c in CATALOG_SPEC}
    labels = {c["id"]: c["label"] for c in CATALOG_SPEC}
    area_word = {"front": "front-end", "rear": "rear-end", "left": "left-side", "right": "right-side", "top": "roof"}

    adds_by_area = {}
    supp_by_area = {}
    for area in AREAS:
        js = jobs_for("insurance", area)
        entries = {}
        # 1) supplement adds: what Gio found after the first look
        sj = [j for j in js if j["hasSupplement"]]
        sc = Counter(cid for j in sj for cid in set(j["supplementAdds"]))
        supp_list = []
        for cid, c in sc.most_common():
            if not sj: break
            rate = round(c / len(sj), 2)
            e = {"catalogId": cid, "rate": rate, "n": len(sj), "count": c, "source": "supplement",
                 "why": f"Gio added it on a supplement (not on the first estimate) in {c} of {len(sj)} {area_word[area]} insurance jobs."}
            supp_list.append(e)
            if c >= 2:
                entries[cid] = e
        supp_by_area[area] = supp_list[:15]
        # 2) hidden / procedure / materials items Gio writes on insurance estimates for this area
        ic = Counter(cid for j in js for cid in {l["catalogId"] for l in j["lines"]})
        for cid, c in ic.items():
            if kinds[cid] == "visible" or not js:
                continue
            rate = round(c / len(js), 2)
            if rate < 0.2 or c < 2:
                continue
            e = {"catalogId": cid, "rate": rate, "n": len(js), "count": c, "source": "estimate",
                 "why": f"On {c} of {len(js)} {area_word[area]} insurance estimates Gio wrote {labels[cid].lower()}."}
            if cid not in entries or entries[cid]["rate"] < rate:
                if cid in entries:
                    e["why"] += " " + entries[cid]["why"]
                entries[cid] = e
        adds_by_area[area] = sorted(entries.values(), key=lambda e: (-e["rate"], e["catalogId"]))

    ins = jobs_for("insurance")
    sp = jobs_for("self_pay")

    def has_blend(j):
        return any(l["op"] == "blend" or l["catalogId"] == "blend-adjacent-panel" for l in j["lines"])

    def refinish_jobs(js):
        return [j for j in js if any(l["refinishHours"] > 0 and kinds[l["catalogId"]] == "visible" for l in j["lines"])]

    major = {c["id"] for c in CATALOG_SPEC if c.get("parts") and c["parts"][1] is not None
             and not re.search(r"brackets|trim|liner|shield|hinges|wheel|suspension", c["id"])}

    def part_mix(js):
        c = Counter()
        for j in js:
            for l in j["lines"]:
                if l.get("partType") and l.get("partPrice") and l["catalogId"] in major:
                    c[{"OEM": "oem", "A/M": "aftermarket", "CAPA": "aftermarket", "LKQ": "used", "Reman": "used"}[l["partType"]]] += 1
        tot = sum(c.values()) or 1
        return {k: round(c.get(k, 0) / tot, 2) for k in ("oem", "aftermarket", "used")}, sum(c.values())

    def rr_rates(js):
        rp = Counter(); rl = Counter()
        for j in js:
            for l in j["lines"]:
                if kinds[l["catalogId"]] != "visible":
                    continue
                if l["op"] == "repair": rp[l["catalogId"]] += 1
                elif l["op"] == "replace": rl[l["catalogId"]] += 1
        return rp, rl

    sp_rp, sp_rl = rr_rates(sp)
    in_rp, in_rl = rr_rates(ins)
    repairs = []
    for cid in set(sp_rp) | set(sp_rl):
        n = sp_rp[cid] + sp_rl[cid]
        if n < 2:
            continue
        ins_n = in_rp[cid] + in_rl[cid]
        e = {"catalogId": cid, "rate": round(sp_rp[cid] / n, 2), "n": n,
             "insuranceRate": round(in_rp[cid] / ins_n, 2) if ins_n else None, "insuranceN": ins_n}
        e["why"] = (f"On self-pay jobs Gio repaired the {labels[cid].lower()} {sp_rp[cid]} of {n} times"
                    + (f" (insurance: {in_rp[cid]} of {ins_n})." if ins_n else "."))
        repairs.append(e)
    repairs.sort(key=lambda e: (-e["rate"], -e["n"]))

    def include_rate(js, cid):
        return round(sum(1 for j in js if any(l["catalogId"] == cid for l in j["lines"])) / len(js), 2) if js else None

    skips = []
    for c in CATALOG_SPEC:
        if c["kind"] in ("procedure", "materials", "hidden"):
            ri, rs = include_rate(ins, c["id"]), include_rate(sp, c["id"])
            if ri is not None and rs is not None and ri >= 0.2 and ri - rs >= 0.15:
                skips.append({"catalogId": c["id"], "insuranceRate": ri, "selfPayRate": rs,
                              "why": f"Written on {round(ri*100)}% of insurance estimates but {round(rs*100)}% of self-pay estimates."})
    skips.sort(key=lambda e: -(e["insuranceRate"] - e["selfPayRate"]))

    def repair_share(rp, rl):
        a, b = sum(rp.values()), sum(rl.values())
        return {"repair": a, "replace": b, "repairShare": round(a / (a + b), 2) if a + b else None}

    sp_mix, sp_mix_n = part_mix(sp)
    in_mix, in_mix_n = part_mix(ins)
    med = lambda xs: round(statistics.median(xs)) if xs else None
    playbook = {
        "version": 1,
        "note": "Mined from Gio Oseguera's Drive Auto Body estimates (anonymized aggregates). Rates are shares of parsed jobs; "
                "small samples, not validated accuracy. Payer 'insurance' = insurer named or insurance pay on the estimate; "
                "'self_pay' = SELF PAY label.",
        "insurance": {
            "addsByArea": adds_by_area,
            "supplementAddsByArea": supp_by_area,
            "blendRate": round(sum(1 for j in refinish_jobs(ins) if has_blend(j)) / max(len(refinish_jobs(ins)), 1), 2),
            "blendN": len(refinish_jobs(ins)),
            "partTypeMix": in_mix, "partTypeN": in_mix_n,
            "panelRepairVsReplace": repair_share(in_rp, in_rl),
            "medianTotal": med([j["total"] for j in ins if j["total"]]),
            "jobs": len(ins),
        },
        "self_pay": {
            "repairInsteadOfReplace": repairs,
            "partTypeMix": sp_mix, "partTypeN": sp_mix_n,
            "panelRepairVsReplace": repair_share(sp_rp, sp_rl),
            "skips": skips,
            "blendRate": round(sum(1 for j in refinish_jobs(sp) if has_blend(j)) / max(len(refinish_jobs(sp)), 1), 2),
            "medianTotal": med([j["total"] for j in sp if j["total"]]),
            "jobs": len(sp),
        },
        "stats": {
            "estimates": len(rows), "uniqueDocuments": len(docs), "parsedDocuments": len(parsed),
            "skippedDocuments": dict(skipped),
            "stageOccurrences": dict(stage_occ),
            "supplements": stage_occ.get("supplement", 0),
            "selfPay": len(payer_audit["documents"]),
            "jobs": len(jobs),
            "jobsByPayer": dict(Counter(j["payer"] for j in jobs)),
            "jobsByStage": dict(Counter(j["stage"] for j in jobs)),
            "jobsWithSupplement": sum(1 for j in jobs if j["hasSupplement"]),
            "lineMappingRate": round(total_mapped / max(total_cand, 1), 2),
            "monthRange": [jobs[0]["month"], jobs[-1]["month"]] if jobs else None,
        },
    }

    history = {"version": 1,
               "note": "Anonymized Drive Auto Body jobs (Gio Oseguera). One job per provisional case group; lines = latest version, "
                       "consolidated per catalog item. No names, contact data, VINs, plates, claim numbers, part numbers or exact dates.",
               "jobs": jobs}

    OUT_CATALOG.parent.mkdir(parents=True, exist_ok=True)
    OUT_HISTORY.parent.mkdir(parents=True, exist_ok=True)
    OUT_CATALOG.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    OUT_HISTORY.write_text(json.dumps(history, indent=1) + "\n", encoding="utf-8")
    OUT_PLAYBOOK.write_text(json.dumps(playbook, indent=2) + "\n", encoding="utf-8")

    # ------------------------------------------------------------ summary (no PII)
    print("documents: occurrences", len(rows), "unique", len(docs), "parsed", len(parsed), "skipped", dict(skipped))
    print("jobs", len(jobs), "by payer", dict(Counter(j["payer"] for j in jobs)), "by stage", dict(Counter(j["stage"] for j in jobs)))
    print("jobs with supplement", playbook["stats"]["jobsWithSupplement"], "line mapping rate", playbook["stats"]["lineMappingRate"])
    print("catalog items", len(catalog_items), "coverage", dict(coverage))
    for area in AREAS:
        top = [(e["catalogId"], e["count"], e["n"]) for e in supp_by_area[area][:5]]
        print(f"supplement adds [{area}] (id, count, jobs):", top)
    print("insurance blendRate", playbook["insurance"]["blendRate"], "partMix ins", in_mix, "self-pay", sp_mix)
    print("self-pay repair-instead-of-replace", [(e["catalogId"], e["rate"], e["n"]) for e in repairs[:6]])
    print("panel repair vs replace: insurance", playbook["insurance"]["panelRepairVsReplace"], "self-pay", playbook["self_pay"]["panelRepairVsReplace"])
    print("median total: insurance", playbook["insurance"]["medianTotal"], "self-pay", playbook["self_pay"]["medianTotal"])
    print("self-pay skips", [(e["catalogId"], e["insuranceRate"], e["selfPayRate"]) for e in skips[:6]])


if __name__ == "__main__":
    main(survey="--survey" in sys.argv)
