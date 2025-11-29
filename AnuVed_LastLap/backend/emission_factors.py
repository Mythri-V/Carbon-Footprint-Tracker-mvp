from typing import Dict
from pathlib import Path
import json

# -------------------------------------------------------------------
# Transport emission factors: g CO2 per tonne-km (g / tkm)
# -------------------------------------------------------------------
EMISSION_FACTORS: Dict[str, float] = {
    "truck": 62.0,
    "rail": 22.0,
    "ship": 15.0,
    "air": 500.0,
    "last_mile": 90.0
}

# -------------------------------------------------------------------
# Material emission factors: kg CO2 per kg of material (kg CO2 / kg)
# Baseline, includes textile + glass + food + paper + other
# -------------------------------------------------------------------
MATERIAL_FACTORS: Dict[str, float] = {
    "metal": 6.0,
    "plastic": 3.0,
    "textile": 4.0,
    "glass": 1.8,
    "food": 2.5,
    "paper": 1.5,
    "other": 1.0
}

# Grid carbon intensity: kg CO2 per kWh
GRID_KGCO2_PER_KWH: float = 0.233


# -------------------------------------------------------------------
# Industry-specific material presets (kg CO2 per kg)
# -------------------------------------------------------------------
MATERIAL_PRESETS = {
    "baseline": {
        "metal": 6.0, "plastic": 3.0, "textile": 4.0, "glass": 1.8,
        "food": 2.5, "paper": 1.5, "other": 1.0
    },
    "electronics": {
        "metal": 8.5, "plastic": 4.5, "textile": 1.5, "glass": 3.5,
        "food": 0.5, "paper": 0.6, "other": 1.0
    },
    "apparel": {
        "metal": 3.0, "plastic": 2.5, "textile": 9.0, "glass": 0.8,
        "food": 3.5, "paper": 1.8, "other": 1.0
    },
    "packaging": {
        "metal": 5.5, "plastic": 3.2, "textile": 1.0, "glass": 2.5,
        "food": 0.7, "paper": 2.2, "other": 1.0
    },
    "food_beverage": {
        "metal": 4.0, "plastic": 2.8, "textile": 2.5, "glass": 3.8,
        "food": 12.0, "paper": 1.6, "other": 1.0
    },
    "construction": {
        "metal": 9.0, "plastic": 3.5, "textile": 2.0, "glass": 4.0,
        "food": 2.0, "paper": 1.4, "other": 1.0
    },
    "automotive": {
        "metal": 9.5, "plastic": 4.0, "textile": 3.0, "glass": 2.8,
        "food": 1.0, "paper": 1.0, "other": 1.0
    }
}


# -------------------------------------------------------------------
# Apply a preset (replaces MATERIAL_FACTORS)
# -------------------------------------------------------------------
def apply_material_preset(preset_name: str = "baseline"):
    """
    Replace MATERIAL_FACTORS with an industry-specific preset.
    Example:
        apply_material_preset("electronics")
    """
    name = str(preset_name or "baseline").lower()

    if name not in (key.lower() for key in MATERIAL_PRESETS.keys()):
        raise ValueError(
            f"Unknown material preset '{preset_name}'. "
            f"Available presets: {list(MATERIAL_PRESETS.keys())}"
        )

    # Resolve correct preset key
    selected_key = [k for k in MATERIAL_PRESETS.keys() if k.lower() == name][0]
    preset = MATERIAL_PRESETS[selected_key]

    # Apply preset
    for k, v in preset.items():
        MATERIAL_FACTORS[str(k).lower()] = float(v)


# -------------------------------------------------------------------
# JSON-based override loader
# -------------------------------------------------------------------
def load_overrides(json_path: str):
    p = Path(json_path)
    if not p.exists():
        raise FileNotFoundError(f"Overrides file not found: {json_path}")

    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)

    ef = data.get("emission_factors", {})
    mf = data.get("material_factors", {})
    grid = data.get("grid_kgco2_per_kwh", None)

    # Safe overrides
    for k, v in ef.items():
        EMISSION_FACTORS[str(k).lower()] = float(v)

    for k, v in mf.items():
        MATERIAL_FACTORS[str(k).lower()] = float(v)

    if grid is not None:
        global GRID_KGCO2_PER_KWH
        GRID_KGCO2_PER_KWH = float(grid)


# -------------------------------------------------------------------
# Summary helper
# -------------------------------------------------------------------
def factors_summary() -> dict:
    return {
        "transport_factors_g_per_tkm": dict(EMISSION_FACTORS),
        "material_factors_kg_per_kg": dict(MATERIAL_FACTORS),
        "grid_kgco2_per_kwh": GRID_KGCO2_PER_KWH
    }
