const SIZES = new Map([
    ["1mm", "1.0"],
    ["1.0mm", "1.0"],
    ["1.5mm", "1.5"],
    ["2mm", "2.0"],
    ["2.0mm", "2.0"],
    ["2.5mm", "2.5"],
    ["3mm", "3.0"],
    ["3.0mm", "3.0"],
    ["4mm", "4.0"],
    ["4.0mm", "4.0"],
]);

const SUPPORTED_SIZES = ["1mm", "1.5mm", "2mm", "2.5mm", "3mm", "4mm"];

class TestPoint {
    constructor(params = {}) {
        const size = params.size === undefined ? "1mm" : String(params.size).toLowerCase();
        const shape = params.shape === undefined ? "round" : String(params.shape).toLowerCase();
        const normalizedShape = shape === "circular" ? "round" : shape;
        const footprintSize = SIZES.get(size);

        if (!footprintSize) {
            throw new Error(`Unsupported TestPoint size "${params.size}". Supported sizes: ${SUPPORTED_SIZES.join(", ")}`);
        }
        if (normalizedShape !== "round" && normalizedShape !== "square") {
            throw new Error('Unsupported TestPoint shape "' + params.shape + '". Supported shapes: round, square');
        }

        const footprintName = normalizedShape === "round"
            ? `TestPoint_Pad_D${footprintSize}mm`
            : `TestPoint_Pad_${footprintSize}x${footprintSize}mm`;

        this.info = {
            partNumber: "TestPoint",
            manufacture: "Generic",
            footprint: `TestPoint:${footprintName}`,
            symbol: "Connector:TestPoint",
            model: "./",
            LCSC: undefined,
            designatorPrefix: "TP",
        };
        this.place = false;
        this.size = size;
        this.shape = normalizedShape;
        this.footprint = this.info.footprint;
        this.pins = [
            { name: "0", pad: 1, net: "" },
        ];
    }
}

module.exports = TestPoint;
