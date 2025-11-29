# backend/utils.py
import pandas as pd
from typing import Tuple, Dict, Any

# Always import emission_factors from backend package
from backend.emission_factors import (
    EMISSION_FACTORS,
    MATERIAL_FACTORS,
    GRID_KGCO2_PER_KWH,
    apply_material_preset,
)

# ---------- helpers ----------
def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


# ---------- scope mapping (utility, keep for reference / custom rules) ----------
SCOPE_MAPPING: Dict[str, int] = {
    "on_site_combustion": 1,
    "owned_vehicle": 1,
    "manufacturing": 2,
    "warehouse_energy": 2,
    "supplier_to_factory": 3,
    "factory_to_domestic_port": 3,
    "domestic_port_to_foreign_port": 3,
    "foreign_port_to_warehouse": 3,
    "warehouse_to_retail_center": 3,
    "employee_commute": 3,
    "advertising": 3,
}


def _map_stage_to_scope(stage: str) -> int:
    if not isinstance(stage, str):
        return 3
    return SCOPE_MAPPING.get(stage.strip().lower(), 3)


# ---------- per-row emissions calculation ----------
def calc_leg_emissions(row: pd.Series) -> pd.Series:
    """
    Compute transport, material and manufacturing emissions (kg CO2) for one row.
    transport: distance_km * weight_tons * transport_factor (g/tkm) -> g -> /1000 -> kg
    material: MATERIAL_FACTORS (kg CO2 per kg) * weight_kg
    manufacturing: manufacturing_energy_kwh * GRID_KGCO2_PER_KWH
    """
    mode = str(row.get("mode", "truck") or "truck").lower()
    distance_km = _safe_float(row.get("distance_km", 0.0))
    weight_kg = _safe_float(row.get("weight_kg", 0.0))
    weight_tons = weight_kg / 1000.0

    factor = EMISSION_FACTORS.get(mode, EMISSION_FACTORS.get("truck", 62.0))
    transport_g = distance_km * weight_tons * factor
    transport_kg = transport_g / 1000.0

    material_type = str(row.get("material_type", "other") or "other").lower()
    material_factor = MATERIAL_FACTORS.get(material_type, MATERIAL_FACTORS.get("other", 1.0))
    material_kg = material_factor * weight_kg

    energy_kwh = _safe_float(row.get("manufacturing_energy_kwh", 0.0))
    manufacturing_kg = energy_kwh * GRID_KGCO2_PER_KWH

    total_kg = transport_kg + material_kg + manufacturing_kg

    return pd.Series({
        "transport_kgCO2": transport_kg,
        "material_kgCO2": material_kg,
        "manufacturing_kgCO2": manufacturing_kg,
        "total_kgCO2": total_kg
    })


# ---------- apply across dataframe with optional industry preset ----------
def apply_emissions(df: pd.DataFrame, industry_preset: str = None, inplace: bool = False) -> pd.DataFrame:
    """
    Apply calc_leg_emissions across dataframe and add scope allocations.
    - industry_preset: optional preset name to apply MATERIAL_FACTORS temporarily.
    - inplace: if True modify provided df (still restores presets).
    Returns: DataFrame with added columns:
      transport_kgCO2, material_kgCO2, manufacturing_kgCO2, total_kgCO2,
      scope (int), scope1_kgCO2, scope2_kgCO2, scope3_kgCO2
    """
    # ensure columns exist to avoid KeyErrors
    for col in ["mode", "distance_km", "weight_kg", "material_type", "manufacturing_energy_kwh", "stage"]:
        if col not in df.columns:
            df[col] = 0

    target = df if inplace else df.copy(deep=True)
    original_materials = dict(MATERIAL_FACTORS)

    # apply industry preset temporarily
    if industry_preset:
        try:
            apply_material_preset(industry_preset)
        except Exception:
            # restore and re-raise
            MATERIAL_FACTORS.clear()
            MATERIAL_FACTORS.update(original_materials)
            raise

    try:
        # compute component emissions
        results = target.apply(calc_leg_emissions, axis=1)
        out = pd.concat([target.reset_index(drop=True), results.reset_index(drop=True)], axis=1)

        # map stage -> scope (kept for rules / future use)
        out["scope"] = out["stage"].apply(lambda s: _map_stage_to_scope(s))

        # Ensure numeric columns have no NaN
        out["transport_kgCO2"] = out["transport_kgCO2"].fillna(0.0)
        out["material_kgCO2"] = out["material_kgCO2"].fillna(0.0)
        out["manufacturing_kgCO2"] = out["manufacturing_kgCO2"].fillna(0.0)
        out["total_kgCO2"] = out["total_kgCO2"].fillna(0.0)

        # Ownership column optional: mark company-owned transport as scope1
        if "ownership" not in out.columns:
            out["ownership"] = ""

        # Scope2: manufacturing energy emissions
        out["scope2_kgCO2"] = out["manufacturing_kgCO2"].astype(float)

        # Scope1: transport that is company-owned (ownership flag or specific stage indicators)
        def _scope1_transport(row: pd.Series) -> float:
            st = str(row.get("stage", "")).strip().lower()
            owner = str(row.get("ownership", "")).strip().lower()
            mode = str(row.get("mode", "")).strip().lower()
            # stage-level direct emissions
            if st in ("on_site_combustion", "owned_vehicle"):
                return float(row.get("transport_kgCO2", 0.0))
            # explicit ownership marker
            if owner in ("owned", "company", "company_owned", "own"):
                return float(row.get("transport_kgCO2", 0.0))
            # optional mode markers for owned fleet
            if mode in ("company_van", "owned_van", "company_truck"):
                return float(row.get("transport_kgCO2", 0.0))
            return 0.0

        out["scope1_kgCO2"] = out.apply(_scope1_transport, axis=1).astype(float)

        # Scope3: material production + transport remainder not counted as scope1
        out["scope3_kgCO2"] = out["material_kgCO2"].astype(float) + (out["transport_kgCO2"].astype(float) - out["scope1_kgCO2"].astype(float))

        # safety: clip negatives and absorb rounding diffs into scope3
        out["scope3_kgCO2"] = out["scope3_kgCO2"].clip(lower=0.0)
        scope_sum = out["scope1_kgCO2"].fillna(0.0) + out["scope2_kgCO2"].fillna(0.0) + out["scope3_kgCO2"].fillna(0.0)
        diff = out["total_kgCO2"].fillna(0.0) - scope_sum
        out["scope3_kgCO2"] = out["scope3_kgCO2"] + diff  # small remainder goes to scope3

        # final fill and types
        out["scope1_kgCO2"] = out["scope1_kgCO2"].fillna(0.0).astype(float)
        out["scope2_kgCO2"] = out["scope2_kgCO2"].fillna(0.0).astype(float)
        out["scope3_kgCO2"] = out["scope3_kgCO2"].fillna(0.0).astype(float)

    finally:
        # restore MATERIAL_FACTORS to avoid global side-effects
        MATERIAL_FACTORS.clear()
        for k, v in original_materials.items():
            MATERIAL_FACTORS[k] = v

    return out


# ---------- summaries & helpers ----------
def summarize_results(df: pd.DataFrame) -> Tuple[float, pd.Series]:
    if "total_kgCO2" not in df.columns:
        raise ValueError("Run apply_emissions first.")
    total = float(df["total_kgCO2"].sum())
    stage_breakdown = df.groupby("stage")["total_kgCO2"].sum().sort_values(ascending=False)
    return total, stage_breakdown


def summarize_by_scope(df: pd.DataFrame) -> Dict[str, float]:
    required = ["scope1_kgCO2", "scope2_kgCO2", "scope3_kgCO2", "total_kgCO2"]
    for col in required:
        if col not in df.columns:
            raise ValueError(f"Column '{col}' missing — run apply_emissions() first.")
    return {
        "scope1_kgCO2": float(df["scope1_kgCO2"].sum()),
        "scope2_kgCO2": float(df["scope2_kgCO2"].sum()),
        "scope3_kgCO2": float(df["scope3_kgCO2"].sum()),
        "total_kgCO2": float(df["total_kgCO2"].sum()),
    }


def get_hotspot(df: pd.DataFrame) -> pd.Series:
    if "total_kgCO2" not in df.columns:
        raise ValueError("Run apply_emissions first.")
    return df.loc[df["total_kgCO2"].idxmax()]


def generate_suggestion(hotspot_row: pd.Series) -> str:
    """
    Heuristic suggestion based on hotspot row.
    """
    mode = str(hotspot_row.get("mode", "")).lower()
    distance = _safe_float(hotspot_row.get("distance_km", 0.0))
    material_em = _safe_float(hotspot_row.get("material_kgCO2", 0.0))
    transport_em = _safe_float(hotspot_row.get("transport_kgCO2", 0.0))
    material_type = str(hotspot_row.get("material_type", "other")).lower()

    if mode == "air":
        return "High-impact: move air freight to sea/rail where possible for long distances."
    if mode == "truck" and distance > 500:
        return "High-distance trucking: consider shifting long legs to rail/ship or consolidate shipments."
    if transport_em > material_em and mode in ("truck", "last_mile"):
        return "Optimize routing and consolidate shipments to reduce transport emissions."
    if material_em >= transport_em:
        if material_type in ("plastic",):
            return "Material hotspot: evaluate recycled plastic or redesign packaging to reduce plastic mass."
        if material_type in ("textile", "metal"):
            return "Material hotspot: consider lower-carbon material or higher recycled content."
        if material_type in ("food",):
            return "Food product: review sourcing, refrigeration and waste to cut emissions."
        return "Material hotspot: consider alternative materials, recycled content, or weight reduction."

    return "General: optimize routing, consolidate shipments, and reduce material weight where feasible."


def estimate_reduction(hotspot_row: pd.Series) -> float:
    """
    Heuristic absolute kgCO2 reduction potential for a hotspot row.
    """
    mode = str(hotspot_row.get("mode", "")).lower()
    total = _safe_float(hotspot_row.get("total_kgCO2", 0.0))
    material_em = _safe_float(hotspot_row.get("material_kgCO2", 0.0))

    if mode == "air":
        return total * 0.60
    if mode == "truck":
        return total * 0.30
    if material_em > (total * 0.4):
        return total * 0.25
    return total * 0.10
