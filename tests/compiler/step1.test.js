const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { step1 } = require("../../src/app");

const basicPart = `part TestPart {
    info: {
        partNumber: "TP-1",
        manufacture: "TestCo",
        footprint: "./",
        symbol: "./",
        model: "./",
        LCSC: "TEST",
        designatorPrefix: "U"
    }

    pins: [
        1:1,
        2:2,
        IN:3,
        OUT:4
    ]
}
`;

function makeFixture(source, partFiles = { "TestPart.schrune": basicPart }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-step1-"));
    const partsDir = path.join(dir, "parts");
    fs.mkdirSync(partsDir);

    for (const [fileName, content] of Object.entries(partFiles)) {
        fs.writeFileSync(path.join(partsDir, fileName), content);
    }

    const filePath = path.join(dir, "fixture.schrune");
    fs.writeFileSync(filePath, source);
    return { dir, filePath };
}

function withFixture(source, callback) {
    const fixture = makeFixture(source);
    try {
        return callback(fixture.filePath);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
}

test("resolves #include files by searching below the source directory", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net signal;
    part u1 = new TestPart();
    u1[1] ~ signal;
}
`, (filePath) => {
        const result = step1(filePath);
        assert.equal(result.components[0].constructor.name, "TestPart");
        assert.equal(result.components[0].pins[1].net, "signal");
    });
});

test("connects indexed pins inside named pin groups", () => {
    const groupedPart = `part GroupedPart {
    info: {
        partNumber: "GP-1",
        manufacture: "TestCo",
        footprint: "./",
        symbol: "./",
        designatorPrefix: "U"
    }

    pins: [
        inputs: [
            A:1,
            B:2,
        ],
    ]
}
`;

    const fixture = makeFixture(`#include "GroupedPart.schrune"

module top () {
    net signal;
    part u1 = new GroupedPart();
    u1.inputs[0] ~ signal;
}
`, { "GroupedPart.schrune": groupedPart });

    try {
        const result = step1(fixture.filePath);
        assert.equal(result.components[0].pins.inputs[0].net, "signal");
        assert.equal(result.components[0].pins.inputs.A.net, "signal");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("rejects #import", () => {
    withFixture(`#import "TestPart.schrune"

module top () {
    net signal;
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /Use #include/);
    });
});

test("throws when no top module is found", () => {
    withFixture(`#include "TestPart.schrune"

module helper () {
    net signal;
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /No top module found/);
    });
});

test("applies rail and net name overrides", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    rail power;
    net signal;
    power.h.name = "VIN";
    power.l.name = "GND";
    signal.name = "PWM";
    power.voltage = 5V +/- 10%;
}
`, (filePath) => {
        const result = step1(filePath);
        assert.deepEqual([...result.netList], ["VIN", "GND", "PWM"]);
        assert.deepEqual(result.nets.power, { h: "VIN", l: "GND", voltage: "5V +/- 10%" });
        assert.equal(result.nets.signal, "PWM");
    });
});

test("rejects duplicate declarations and final net names", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net signal;
    net signal;
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /Duplicate declaration "signal"/);
    });

    withFixture(`#include "TestPart.schrune"

module top () {
    net first;
    net second;
    first.name = "DUP";
    second.name = "DUP";
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /Duplicate net name "DUP"/);
    });
});

test("connects a net to a pin regardless of side", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    rail power;
    power.h.name = "VIN";
    part u1 = new TestPart();
    power.h ~ u1[1];
}
`, (filePath) => {
        const result = step1(filePath);
        assert.equal(result.components[0].pins[1].net, "VIN");
    });
});

test("creates implicit nets for pin-to-pin connections", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    part left = new TestPart();
    part right = new TestPart();
    left[1] ~ right[1];
}
`, (filePath) => {
        const result = step1(filePath);
        assert.deepEqual([...result.netList], ["left_1"]);
        assert.equal(result.nets.left_1, "left_1");
        assert.equal(result.components[0].pins[1].net, "left_1");
        assert.equal(result.components[1].pins[1].net, "left_1");
    });
});

test("renames implicit pin-to-pin nets with pin .name", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    part left = new TestPart();
    part right = new TestPart();
    left[1].name = "LINK";
    left[1] ~ right[1];
}
`, (filePath) => {
        const result = step1(filePath);
        assert.deepEqual([...result.netList], ["LINK"]);
        assert.equal(result.nets.LINK, "LINK");
        assert.equal(result.components[0].pins[1].net, "LINK");
        assert.equal(result.components[1].pins[1].net, "LINK");
    });
});

test("assigns explicit nets to every pin in a pin-to-pin group", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net signal;
    part left = new TestPart();
    part right = new TestPart();
    left[1] ~ right[1];
    signal ~ right[1];
}
`, (filePath) => {
        const result = step1(filePath);
        assert.deepEqual([...result.netList], ["signal"]);
        assert.equal(result.components[0].pins[1].net, "signal");
        assert.equal(result.components[1].pins[1].net, "signal");
    });
});

test("rejects connections that join different named nets", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net first;
    net second;
    part left = new TestPart();
    part right = new TestPart();
    first ~ left[1];
    second ~ right[1];
    left[1] ~ right[1];
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /Connection joins nets "first" and "second"/);
    });
});

test("creates primitive two-pin components with constructor parameters", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net left;
    net right;
    cap = new Capacitor(value = 100nF +/- 10%, footprint = "0402");
    left ~ cap[0];
    cap[1] ~ right;
}
`, (filePath) => {
        const result = step1(filePath);
        const cap = result.components[0];
        assert.equal(cap.constructor.name, "Capacitor");
        assert.equal(cap.value, "100nF +/- 10%");
        assert.equal(cap.footprint, "0402");
        assert.equal(cap.pins[0].net, "left");
        assert.equal(cap.pins[1].net, "right");
    });
});

test("requires a value for primitive components", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    r1 = new Resistor(footprint = "0603");
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /Resistor requires a value/);
    });
});

test("connects bridge operator edges through a two-pin component", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net left;
    net right;
    r1 = new Resistor(value = "10k", footprint = "1206");
    left ~> r1 ~> right;
}
`, (filePath) => {
        const result = step1(filePath);
        const resistor = result.components[0];
        assert.equal(resistor.constructor.name, "Resistor");
        assert.equal(resistor.footprint, "1206");
        assert.equal(resistor.pins[0].net, "left");
        assert.equal(resistor.pins[1].net, "right");
    });
});

test("does not treat package as a primitive footprint", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net left;
    net right;
    r1 = new Resistor(value = "10k", package = "1206");
    left ~> r1 ~> right;
}
`, (filePath) => {
        const result = step1(filePath);
        const resistor = result.components[0];
        assert.equal(resistor.footprint, undefined);
        assert.equal(resistor.info.footprint, undefined);
        assert.equal(resistor.pins[0].net, "left");
        assert.equal(resistor.pins[1].net, "right");
    });
});

test("connects chained bridge operators with implicit nets between primitives", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net left;
    net right;
    r1 = new Resistor(value = "10k");
    c1 = new Capacitor(value = "100nF");
    left ~> r1 ~> c1 ~> right;
}
`, (filePath) => {
        const result = step1(filePath);
        const [resistor, capacitor] = result.components;
        assert.equal(resistor.pins[0].net, "left");
        assert.equal(resistor.pins[1].net, "r1_1");
        assert.equal(capacitor.pins[0].net, "r1_1");
        assert.equal(capacitor.pins[1].net, "right");
        assert.equal(result.nets.r1_1, "r1_1");
    });
});

test("rejects bridge middles that are not two-pin components", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net left;
    net right;
    part u1 = new TestPart();
    left ~> u1 ~> right;
}
`, (filePath) => {
        assert.throws(() => step1(filePath), /Bridge middle "u1" must be a component with 2 pins/);
    });
});

test("creates component arrays and executes for loops", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    net signal;
    part[3] parts = new TestPart();
    for (let i = 0; i < parts.length; i++){
        parts[i].IN ~ signal;
    }
}
`, (filePath) => {
        const result = step1(filePath);
        assert.equal(result.components.length, 3);
        assert.equal(result.components[0].pins.IN.net, "signal");
        assert.equal(result.components[1].pins.IN.net, "signal");
        assert.equal(result.components[2].pins.IN.net, "signal");
    });
});

test("strips line comments before compiling statements", () => {
    withFixture(`#include "TestPart.schrune"

module top () {
    // The following declaration should still be parsed.
    net signal; // trailing comments should not become part of the statement
    part u1 = new TestPart();
    u1.IN ~ signal; // connect a named pin
}
`, (filePath) => {
        const result = step1(filePath);
        assert.deepEqual([...result.netList], ["signal"]);
        assert.equal(result.components[0].pins.IN.net, "signal");
    });
});
