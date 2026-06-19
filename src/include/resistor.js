const BasicComponent = require("./basic-component");

class Resistor extends BasicComponent {
    constructor(params = {}) {
        super(params, {
            partNumber: "Resistor",
            designatorPrefix: "R",
        });
    }
}

module.exports = Resistor;
