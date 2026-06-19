class BasicComponent {
    constructor(params = {}, options) {
        if (!("value" in params)) {
            throw new Error(`${options.partNumber} requires a value`);
        }

        this.info = {
            partNumber: options.partNumber,
            manufacture: "Generic",
            footprint: undefined,
            symbol: "./",
            model: "./",
            LCSC: undefined,
            designatorPrefix: options.designatorPrefix,
        };
        this.info.footprint = params.footprint;
        Object.assign(this, params);
        this.footprint = params.footprint;
        this.pins = [
            { name: "0", pad: 0, net: "" },
            { name: "1", pad: 1, net: "" },
        ];
    }
}

module.exports = BasicComponent;
