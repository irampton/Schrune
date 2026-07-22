import argparse
import json
import re
from pathlib import Path

from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
from easyeda2kicad.easyeda.easyeda_importer import (
    EasyedaFootprintImporter,
    EasyedaSymbolImporter,
)
from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad


def write_symbol(symbol, destination: Path, footprint_lib_name: str) -> None:
    content = ExporterSymbolKicad(symbol=symbol, version=20211014).export(
        footprint_lib_name=footprint_lib_name
    )
    destination.write_text(
        "(kicad_symbol_lib (version 20211014) (generator easyeda2kicad)\n"
        f"{content}\n"
        ")\n",
        encoding="utf-8",
    )


def model_file_name(model) -> str:
    name = getattr(model, "name", None) or "model"
    if not name.lower().endswith(".step"):
        name = f"{name}.step"
    return name


def normalize_footprint_model_path(footprint_path: Path, expected_model_path: str) -> None:
    content = footprint_path.read_text(encoding="utf-8")
    normalized = re.sub(
        r'(\(model\s+)"[^"]+"',
        rf'\1"{expected_model_path}"',
        content,
        count=1,
    )
    footprint_path.write_text(normalized, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--symbol-file", required=True)
    parser.add_argument("--footprint-file", required=True)
    parser.add_argument("--model-path", default="")
    parser.add_argument("--footprint-lib", default="Schrune")
    args = parser.parse_args()

    cad_data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    symbol = EasyedaSymbolImporter(easyeda_cp_cad_data=cad_data).get_symbol()
    footprint = EasyedaFootprintImporter(easyeda_cp_cad_data=cad_data).get_footprint()
    model = footprint.model_3d

    symbol_path = output_dir / args.symbol_file
    footprint_path = output_dir / args.footprint_file
    model_path = None
    model_downloaded = False

    if model is not None and getattr(model, "uuid", None):
        model_name = model_file_name(model)
        output_model_path = output_dir / model_name
        relative_model_path = f'{args.model_path.rstrip("/")}/{model_name}' if args.model_path else model_name
        model_bytes = EasyedaApi().get_step_3d_model(uuid=model.uuid)
        if model_bytes:
            output_model_path.write_bytes(model_bytes)
            model_path = relative_model_path
            model_downloaded = True

    write_symbol(symbol, symbol_path, args.footprint_lib)
    ExporterFootprintKicad(footprint=footprint).export(
        footprint_full_path=str(footprint_path),
        model_3d_path=model_path,
    )
    if model_path:
        normalize_footprint_model_path(footprint_path, model_path)

    print(json.dumps({
        "symbolName": symbol.info.name,
        "footprintName": footprint.info.name,
        "symbolFile": symbol_path.name,
        "footprintFile": footprint_path.name,
        "modelFile": model_file_name(model) if model_path else None,
        "modelDownloaded": model_downloaded,
    }))


if __name__ == "__main__":
    main()
