import argparse
import json
from pathlib import Path

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

    symbol_path = output_dir / args.symbol_file
    footprint_path = output_dir / args.footprint_file
    write_symbol(symbol, symbol_path, args.footprint_lib)
    ExporterFootprintKicad(footprint=footprint).export(
        footprint_full_path=str(footprint_path),
        model_3d_path=args.model_path or "${KIPRJMOD}",
    )

    print(json.dumps({
        "symbolName": symbol.info.name,
        "footprintName": footprint.info.name,
        "symbolFile": symbol_path.name,
        "footprintFile": footprint_path.name,
    }))


if __name__ == "__main__":
    main()
