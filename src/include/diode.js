const BasicComponent = require("./basic-component");

class Diode extends BasicComponent {
    constructor(params = {}) {
        super(params, {
            partNumber: "Diode",
            designatorPrefix: "D",
        });
    }
}

module.exports = Diode;
