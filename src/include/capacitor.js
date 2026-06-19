const BasicComponent = require("./basic-component");

class Capacitor extends BasicComponent {
    constructor(params = {}) {
        super(params, {
            partNumber: "Capacitor",
            designatorPrefix: "C",
        });
    }
}

module.exports = Capacitor;
