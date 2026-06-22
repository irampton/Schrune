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
        fs.writeFileSync(path.join(partsDir, fileName), content);
    }

    const filePath = path.join(dir, "fixture.schrune");
    fs.writeFileSync(filePath, source);
    return { dir, filePath };
}

test("writes runnable Step 1 JavaScript with --keep-js behavior", () => {
    const fixture = makeFixture(`#include "TestPart.schrune"

module top () {
    net signal;
    part u1 = new TestPart();
    u1[1] ~ signal;
}
`);

    try {
        writeStep1JavaScript(fixture.filePath);

        const topJsPath = path.join(fixture.dir, "fixture.js");
        const partJsPath = path.join(fixture.dir, "parts", "TestPart.js");
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
    const fixture = makeFixture(`#include "GroupedPart.schrune"

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

test("kept Step 1 JavaScript preserves loops and branches at runtime", () => {
    const fixture = makeFixture(`#include "TestPart.schrune"

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
        assert.match(generated, /const Resistor = require\(".+src\/include\/resistor"\);/);
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
