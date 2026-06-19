const BasicComponent = require("./basic-component");

class Inductor extends BasicComponent {
    constructor(params = {}) {
        super(params, {
            partNumber: "Inductor",
            designatorPrefix: "L",
        });
    }
}

module.exports = Inductor;
