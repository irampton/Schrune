const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { step1, writeStep1JavaScript } = require("../../src/app");

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-generated-js-"));
    const partsDir = path.join(dir, "parts");
    fs.mkdirSync(partsDir);

    for (const [fileName, content] of Object.entries(partFiles)) {
        const partName = path.basename(fileName, ".schrune");
        const partDir = path.join(partsDir, partName);
        fs.mkdirSync(partDir, { recursive: true });
        fs.writeFileSync(path.join(partDir, `${partName}.schrune`), content);
    }

    const filePath = path.join(dir, "fixture.schrune");
    fs.writeFileSync(filePath, source);
    return { dir, filePath };
}

function assertGeneratedBuildError(fixturePath, expected) {
    writeStep1JavaScript(fixturePath);
    const generatedPath = path.join(path.dirname(fixturePath), "fixture.js");
    delete require.cache[require.resolve(generatedPath)];
    assert.throws(() => require(generatedPath)(), (error) => {
        assert.equal(error.filePath, fixturePath);
        if (expected.line !== undefined) {
            assert.equal(error.line, expected.line);
        }
        if (expected.column !== undefined) {
            assert.equal(error.column, expected.column);
        }
        if (expected.message) {
            assert.match(error.message, expected.message);
        }
        return true;
    });
}

test("writes runnable Step 1 JavaScript with --keep-js behavior", () => {
    const fixture = makeFixture(`@require("TestPart");

module top () {
    net signal;
    part u1 = new TestPart();
    u1[1] ~ signal;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const topJsPath = path.join(fixture.dir, "fixture.js");
        const partJsPath = path.join(fixture.dir, "parts", "TestPart", "TestPart.js");
        assert.equal(fs.existsSync(topJsPath), true);
        assert.equal(fs.existsSync(partJsPath), true);

        delete require.cache[require.resolve(topJsPath)];
        const top = require(topJsPath);
        const result = top();

        assert.deepEqual([...result.netList], ["signal"]);
        assert.equal(result.components[0].constructor.name, "TestPart");
        assert.equal(result.components[0].pins[1].net, "signal");
        assert.deepEqual(result.nets, { signal: "signal" });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript allows module-local renamed rails to join a higher-level net", () => {
    const fixture = makeFixture(`@require("TestPart");

module child () {
    rail power;
    power.l.name = "GND";
    part u = new TestPart();
    u.IN ~ power.l;
}

module top () {
    net gnd;
    mod a = new child();
    mod b = new child();
    a.power.l ~ gnd;
    b.power.l ~ gnd;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.equal(result.netList.has("gnd"), true);
        assert.equal(result.components.length, 2);
        assert.equal(result.components[0].pins.IN.net, "gnd");
        assert.equal(result.components[1].pins.IN.net, "gnd");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept part JavaScript preserves indexed named pin groups", () => {
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
    const fixture = makeFixture(`@require("GroupedPart");

module top () {
    net signal;
    part u1 = new GroupedPart();
    u1.inputs[0] ~ signal;
}
`, { "GroupedPart.schrune": groupedPart });

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.equal(result.components[0].pins.inputs[0].net, "signal");
        assert.equal(result.components[0].pins.inputs.A.net, "signal");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept part JavaScript preserves multi-pad pins and part rails", () => {
    const connectorPart = `part Connector {
    info: {
        partNumber: "CONN-1",
        manufacture: "TestCo",
        footprint: "./",
        symbol: "./",
        designatorPrefix: "J"
    }

    pins: [
        rail VBUS: {
            h: A4B9~B4A9,
            l: A1B12~B1A12
        },
        Dp:A6~B6,
    ]
}
`;
    const fixture = makeFixture(`@require("Connector");

module top () {
    rail power;
    net usb_p;
    part j1 = new Connector();
    j1.VBUS ~ power;
    j1.Dp ~ usb_p;
}
`, { "Connector.schrune": connectorPart });

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();
        const pins = result.components[0].pins;

        assert.equal(pins.VBUS.h[0].net, "power");
        assert.equal(pins.VBUS.h[1].net, "power");
        assert.equal(pins.VBUS.l[0].net, "power.l");
        assert.equal(pins.VBUS.l[1].net, "power.l");
        assert.equal(pins.Dp[0].net, "usb_p");
        assert.equal(pins.Dp[1].net, "usb_p");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript preserves loops and branches at runtime", () => {
    const fixture = makeFixture(`@require("TestPart");

module top () {
    net signal;
    net fallback;
    signal.name = "SIG";
    part[3] parts = new TestPart();
    part[3] resistors = new Resistor(value = "10k");

    for (let i = 0; i < parts.length; i++){
        signal ~> resistors[i] ~> parts[i].IN;
        if (i < 2) {
            parts[i].OUT ~ signal;
        } else {
            parts[i].OUT ~ fallback;
        }
    }
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        const generated = fs.readFileSync(generatedPath, "utf8");
        assert.match(generated.replace(/\\\\/g, "/"), /const Resistor = require\(".*src\/include\/resistor\.js"\);/);
        assert.doesNotMatch(generated, /class Resistor/);
        assert.match(generated, /for \(let i = 0; i < parts\.length; i\+\+\)/);
        assert.match(generated, /if \(i < 2\)/);

        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const generatedResult = top();
        const directResult = step1(fixture.filePath);

        assert.deepEqual([...generatedResult.netList], [...directResult.netList]);
        assert.equal(generatedResult.components.length, directResult.components.length);
        assert.equal(generatedResult.components[0].pins.IN.net, "resistors_0_1");
        assert.equal(generatedResult.components[0].pins.OUT.net, "SIG");
        assert.equal(generatedResult.components[2].pins.OUT.net, "fallback");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript supports TestPoint defaults, footprints, and bare connections", () => {
    const fixture = makeFixture(`module top () {
    net signal;
    part TP1 = new TestPoint();
    TP1 ~ signal;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);
        const generatedPath = path.join(fixture.dir, "fixture.js");
        const generated = fs.readFileSync(generatedPath, "utf8");
        assert.match(generated.replace(/\\\\/g, "/"), /const TestPoint = require\(".*src\/include\/testpoint\.js"\);/);

        delete require.cache[require.resolve(generatedPath)];
        const result = require(generatedPath)();
        assert.equal(result.components[0].place, false);
        assert.equal(result.components[0].footprint, "TestPoint:TestPoint_Pad_D1.0mm");
        assert.equal(result.components[0].pins[0].net, "signal");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript bridges numbered two-pin parts", () => {
    const numberedPart = `part NumberedTwoPin {
    info: {
        partNumber: "NP-1",
        manufacture: "TestCo",
        footprint: "./",
        symbol: "./",
        designatorPrefix: "J"
    }

    pins: [
        1:1,
        2:2,
    ]
}
`;
    const fixture = makeFixture(`@require("NumberedTwoPin");

module top () {
    net left;
    net right;
    part u1 = new NumberedTwoPin();
    left ~> u1 ~> right;
}
`, { "NumberedTwoPin.schrune": numberedPart });

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.equal(result.components[0].pins[1].net, "left");
        assert.equal(result.components[0].pins[2].net, "right");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript supports inline net declarations and multi-ties", () => {
    const fixture = makeFixture(`@require("TestPart");

module top () {
    rail power_3v3;
    rail power_1v8;
    part u1 = new TestPart();
    part u2 = new TestPart();
    net gnd ~ power_3v3.l ~ power_1v8.l ~ u1.IN ~ u2.IN;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.deepEqual([...result.netList].sort(), ["gnd", "power_3v3", "power_1v8"].sort());
        assert.equal(result.nets.gnd, "gnd");
        assert.equal(result.nets.power_3v3.l, "gnd");
        assert.equal(result.nets.power_1v8.l, "gnd");
        assert.equal(result.components[0].pins.IN.net, "gnd");
        assert.equal(result.components[1].pins.IN.net, "gnd");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript supports vals and module instances", () => {
    const fixture = makeFixture(`module child () {
    rail v;
    val resistance = 10kOhm;
    part r1 = new Resistor(value=resistance / 2);
    v.h ~> r1 ~> v.l;
}

module top () {
    rail power;
    mod c = new child();
    c.v ~ power;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.equal(result.components[0].value, 5000);
        assert.deepEqual([...result.netList].sort(), ["power", "power.l"]);
        assert.equal(result.components[0].pins[0].net, "power");
        assert.equal(result.components[0].pins[1].net, "power.l");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("generated Step 1 JavaScript points bridge mistakes back to the source line", () => {
    const fixture = makeFixture(`module top () {
    net left;
    net right;
    r1 = new Resistor(value = "10k");
    left ~ r1 ~ right;
}
`);

    try {
        assertGeneratedBuildError(fixture.filePath, {
            line: 5,
            message: /Use "~>" only when a two-pin part sits in the middle/,
        });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("generated Step 1 JavaScript points net-group mistakes back to the source line", () => {
    const fixture = makeFixture(`module top () {
    net<i2c> bus;
    net signal;
    bus ~ signal;
}
`);

    try {
        assertGeneratedBuildError(fixture.filePath, {
            line: 4,
            message: /Cannot connect net<i2c> "bus" directly to "signal"/,
        });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("generated Step 1 JavaScript explains when a bridge operator is used without a middle component", () => {
    const fixture = makeFixture(`module top () {
    net left;
    net right;
    left ~> right;
}
`);

    try {
        assertGeneratedBuildError(fixture.filePath, {
            line: 4,
            message: /Bridge connections need a component between the arrows/,
        });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript connects net-like endpoints to rail high by default", () => {
    const fixture = makeFixture(`@require("TestPart");

module top () {
    rail power;
    net signal;
    part u = new TestPart();
    signal ~ power;
    u.IN ~ power;
    u.OUT ~ power.l;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.equal(result.nets.signal, "power");
        assert.equal(result.components[0].pins.IN.net, "power");
        assert.equal(result.components[0].pins.OUT.net, "power.l");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript expands typed net groups", () => {
    const fixture = makeFixture(`@require("TestPart");

module top () {
    net<i2c> bus_1;
    net<i2c> bus_2;
    part left = new TestPart();
    part right = new TestPart();
    bus_1 ~ bus_2;
    left[1] ~ bus_1.SDA;
    right[1] ~ bus_1.SCL;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.deepEqual([...result.netList].sort(), ["bus_2.SDA", "bus_2.SCL"].sort());
        assert.equal(result.components[0].pins[1].net, "bus_2.SDA");
        assert.equal(result.components[1].pins[1].net, "bus_2.SCL");
        assert.deepEqual(result.nets.bus_1, { type: "i2c", SDA: "bus_2.SDA", SCL: "bus_2.SCL" });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript applies whole-group typed net renames", () => {
    const fixture = makeFixture(`@require("TestPart");

module top () {
    net<i2c> i2c_bus;
    i2c_bus.name = "sensors";
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.deepEqual([...result.netList].sort(), ["sensors.SDA", "sensors.SCL"].sort());
        assert.deepEqual(result.nets.i2c_bus, { type: "i2c", SDA: "sensors.SDA", SCL: "sensors.SCL" });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("kept Step 1 JavaScript supports typed module parameters for rails and net groups", () => {
    const fixture = makeFixture(`@require("TestPart");

module child(net GPIO, rail power, val current, net<i2c> bus) {
    part u = new TestPart();
    GPIO ~ u.IN;
    power.l.name = "GND";
    power.l ~ u.OUT;
    bus.SDA ~ u[1];
}

module top () {
    rail power;
    net gpio1;
    net<i2c> i2c_bus;
    val current = 0.5;
    mod c = new child(gpio1, power, current, i2c_bus);
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const generatedPath = path.join(fixture.dir, "fixture.js");
        delete require.cache[require.resolve(generatedPath)];
        const top = require(generatedPath);
        const result = top();

        assert.equal(result.components.length, 1);
        assert.equal(result.components[0].pins.IN.net, "gpio1");
        assert.equal(result.components[0].pins.OUT.net, "GND");
        assert.equal(result.components[0].pins[1].net, "i2c_bus.SDA");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});
