# backend/main.py
import base64
import io
import traceback
from pathlib import Path
from typing import List, Dict, Any

from flask import Flask, request, jsonify, send_from_directory, abort, send_file
from werkzeug.utils import secure_filename

import pandas as pd

# IMPORTANT: use package-style imports so running `python backend/main.py` from repo root works
from backend.utils import (
    apply_emissions,
    summarize_results,
    summarize_by_scope,
    get_hotspot,
    generate_suggestion,
)
from backend.emission_factors import MATERIAL_PRESETS

# Configuration
FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"  # repository_root/frontend
ALLOWED_EXTENSIONS = {"csv"}

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="/")
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024  # 30 MB cap for uploads

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def _serialize_stage_breakdown(series: pd.Series) -> List[Dict[str, Any]]:
    return [{"stage": str(idx), "kg": float(val)} for idx, val in series.items()]

def _row_to_plain(o: pd.Series) -> Dict[str, Any]:
    d = {}
    for k, v in o.to_dict().items():
        try:
            if pd.isna(v):
                d[k] = None
            elif hasattr(v, "item"):
                d[k] = v.item()
            else:
                d[k] = v
        except Exception:
            d[k] = str(v)
    return d

def _download_requested() -> bool:
    val_q = request.args.get("download", None)
    val_f = request.form.get("download", None)
    for v in (val_q, val_f):
        if v is None:
            continue
        if str(v).lower() in ("1", "true", "yes"):
            return True
    return False

@app.route("/api/presets", methods=["GET"])
def api_presets():
    presets = list(MATERIAL_PRESETS.keys())
    return jsonify(presets), 200

@app.route("/api/compute", methods=["POST"])
def api_compute():
    try:
        if "file" not in request.files:
            return jsonify({"error": "No file part in request (field 'file' missing)"}), 400

        f = request.files["file"]
        if not f or f.filename == "":
            return jsonify({"error": "No file selected"}), 400

        filename = secure_filename(f.filename)
        if not allowed_file(filename):
            return jsonify({"error": "Only CSV uploads are allowed"}), 400

        try:
            df = pd.read_csv(f)
        except Exception as e:
            return jsonify({"error": "Failed to parse CSV", "detail": str(e)}), 400

        preset = request.form.get("preset", None)
        compare_all = request.form.get("compare_all", "0") in ("1", "true", "True")
        do_download = _download_requested()

        out = apply_emissions(df, industry_preset=preset or None, inplace=False)

        total, stage_break = summarize_results(out)
        scopes = summarize_by_scope(out)
        hotspot_row = get_hotspot(out)
        suggestion = generate_suggestion(hotspot_row)

        stage_list = _serialize_stage_breakdown(stage_break)
        hotspot = _row_to_plain(hotspot_row)

        csv_buf = io.StringIO()
        out.to_csv(csv_buf, index=False)
        csv_bytes = csv_buf.getvalue().encode("utf-8")

        if do_download:
            csv_stream = io.BytesIO(csv_bytes)
            csv_stream.seek(0)
            return send_file(
                csv_stream,
                mimetype="text/csv",
                as_attachment=True,
                download_name="emissions_results.csv",
            )

        csv_b64 = base64.b64encode(csv_bytes).decode("ascii")

        result = {
            "total_kgCO2": float(total),
            "scope": {
                "scope1": float(scopes.get("scope1_kgCO2", 0.0)),
                "scope2": float(scopes.get("scope2_kgCO2", 0.0)),
                "scope3": float(scopes.get("scope3_kgCO2", 0.0)),
            },
            "stage_breakdown": stage_list,
            "hotspot": hotspot,
            "suggestion": suggestion,
            "results_csv": csv_b64,
        }

        if compare_all:
            sens = []
            for p in MATERIAL_PRESETS.keys():
                temp = apply_emissions(df, industry_preset=p, inplace=False)
                s = summarize_by_scope(temp)
                sens.append({
                    "preset": p,
                    "scope1_kgCO2": float(s["scope1_kgCO2"]),
                    "scope2_kgCO2": float(s["scope2_kgCO2"]),
                    "scope3_kgCO2": float(s["scope3_kgCO2"]),
                    "total_kgCO2": float(s["total_kgCO2"])
                })
            result["sensitivity"] = sens

        return jsonify(result), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "server error", "detail": str(e)}), 500

# Serve frontend static files
@app.route("/", defaults={"path": "index.html"})
@app.route("/<path:path>")
def serve_frontend(path):
    try:
        requested = FRONTEND_DIR.joinpath(path).resolve()
        if not str(requested).startswith(str(FRONTEND_DIR.resolve())):
            abort(404)
        if requested.is_file():
            return send_from_directory(str(FRONTEND_DIR), path)
        return send_from_directory(str(FRONTEND_DIR), "index.html")
    except Exception:
        return send_from_directory(str(FRONTEND_DIR), "index.html")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
