const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assignDesignators, buildDesignatorState, step1, step3 } = require("../../src/app");
const { bomCsv, lockPathFor, makeBomRows, readPartsLock } = require("../../src/bom");

function makeFixture(source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-bom-"));
    const filePath = path.join(dir, "fixture.schrune");
    fs.writeFileSync(filePath, source);
    return { dir, filePath };
}

function compile(source) {
    const fixture = makeFixture(source);
    try {
        return {
            fixture,
            compiled: assignDesignators(step1(fixture.filePath)),
        };
    } catch (error) {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
        throw error;
    }
}

test("assigns deterministic designators by prefix and stable component signature", () => {
    const { fixture, compiled } = compile(`module top () {
    net left;
    net right;
    c1 = new Capacitor(value = "100nF", footprint = "0402");
    r1 = new Resistor(value = "10k", footprint = "0603");
    r2 = new Resistor(value = "1k", footprint = "0603");
    left ~> r1 ~> right;
    left ~> r2 ~> right;
    left ~> c1 ~> right;
}
`);

    try {
        assert.deepEqual(
            compiled.components.map((component) => component.designator),
            ["C1", "R1", "R2"]
        );
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("primitive components keep selection fields", () => {
    const { fixture, compiled } = compile(`module top () {
    r1 = new Resistor(value = "10k", footprint = "0603", power = "0.1W", tolerance = "1%");
}
`);

    try {
        const resistor = compiled.components[0];
        assert.equal(resistor.value, "10k");
        assert.equal(resistor.footprint, "0603");
        assert.equal(resistor.power, "0.1W");
        assert.equal(resistor.tolerance, "1%");
        assert.equal(resistor.designator, "R1");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("assignDesignators reuses a prior designator state when components move around", () => {
    const initialFixture = makeFixture(`module top () {
    a = new Resistor(value = "10k", footprint = "0603");
}
`);
    const rebuiltFixture = makeFixture(`module top () {
    b = new Resistor(value = "1k", footprint = "0603");
    a = new Resistor(value = "10k", footprint = "0603");
}
`);

    try {
        const initial = assignDesignators(step1(initialFixture.filePath));
        const designatorState = buildDesignatorState(initial);
        const rebuilt = assignDesignators(step1(rebuiltFixture.filePath), designatorState);

        const byValue = new Map(rebuilt.components.map((component) => [component.value, component.designator]));
        assert.equal(byValue.get("10k"), "R1");
        assert.equal(byValue.get("1k"), "R2");
    } finally {
        fs.rmSync(initialFixture.dir, { recursive: true, force: true });
        fs.rmSync(rebuiltFixture.dir, { recursive: true, force: true });
    }
});

test("step3 reuses parts-lock entries and writes BOM csv", async () => {
    const { fixture, compiled } = compile(`module top () {
    net left;
    net right;
    r1 = new Resistor(value = "10k", footprint = "0603", power = "0.1W");
    left ~> r1 ~> right;
}
`);

    try {
        const lockPath = lockPathFor(fixture.filePath);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, `${JSON.stringify({
            version: 1,
            parts: [{
                lcsc: "C25804",
                manufacturer: "YAGEO",
                mpn: "RC0603FR-0710KL",
                package: "0603",
                description: "10k 1% resistor",
                stock: 1000,
                unitCost: 0.001,
                isBasic: true,
                isPreferred: false,
            }],
            selectors: {
                R1: "C25804",
            },
        }, null, 2)}\n`);

        let apiCalls = 0;
        const result = await step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async () => {
                apiCalls++;
                throw new Error("selector should not be called for locked parts");
            },
        });

        assert.equal(apiCalls, 0);
        assert.equal(result.components[0].info.LCSC, "C25804");
        assert.equal(fs.existsSync(result.bomPath), true);
        const bom = fs.readFileSync(result.bomPath, "utf8");
        assert.equal(result.bomPath, path.join(fixture.dir, "build", "fixture.BOM.csv"));
        assert.match(bom, /^Designator,Footprint,Comment,Manufacturer Part Number,Manufacturer,Quantity,LCSC/m);
        assert.match(bom, /R1,0603,10k 0.1W,RC0603FR-0710KL,YAGEO,1,C25804/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 selects unlocked generic parts and updates parts-lock", async () => {
    const { fixture, compiled } = compile(`module top () {
    c1 = new Capacitor(value = "100nF", footprint = "0402", voltage = "16V");
}
`);

    try {
        const result = await step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async (_component, filters) => {
                assert.deepEqual(filters, {
                    type: "Capacitor",
                    value: "100nF",
                    footprint: "0402",
                    voltage: "16V",
                    power: null,
                    tolerance: null,
                });
                return {
                    lcsc: "C1525",
                    manufacturer: "Samsung",
                    mpn: "CL05B104KO5NNNC",
                    package: "0402",
                    stock: 5000,
                    unitCost: 0.002,
                    isBasic: true,
                    isPreferred: true,
                };
            },
        });

        assert.equal(result.components[0].designator, "C1");
        assert.equal(result.components[0].info.LCSC, "C1525");
        const lock = JSON.parse(fs.readFileSync(lockPathFor(fixture.filePath), "utf8"));
        assert.equal(lock.parts[0].lcsc, "C1525");
        assert.deepEqual(lock.selectors, { C1: "C1525" });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 caches identical generic-part selections within a single run", async () => {
    const { fixture, compiled } = compile(`module top () {
    r1 = new Resistor(value = "10k", footprint = "0603");
    r2 = new Resistor(value = "10k", footprint = "0603");
}
`);

    try {
        let selectCalls = 0;
        const result = await step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async (_component, filters) => {
                selectCalls++;
                assert.deepEqual(filters, {
                    type: "Resistor",
                    value: "10k",
                    footprint: "0603",
                    voltage: null,
                    power: null,
                    tolerance: null,
                });
                return {
                    lcsc: "C25804",
                    manufacturer: "YAGEO",
                    mpn: "RC0603FR-0710KL",
                    package: "0603",
                };
            },
        });

        assert.equal(selectCalls, 1);
        assert.equal(result.partsLock.parts.length, 1);
        assert.deepEqual(result.partsLock.selectors, {
            R1: "C25804",
            R2: "C25804",
        });
        assert.deepEqual(Object.keys(result.partsLock.selectionCache).length, 1);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 reuses a cached selection from parts-lock without calling the selector", async () => {
    const { fixture, compiled } = compile(`module top () {
    c1 = new Capacitor(value = "100nF", footprint = "0402");
}
`);

    try {
        const lockPath = lockPathFor(fixture.filePath);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, `${JSON.stringify({
            version: 1,
            parts: [{
                lcsc: "C1525",
                manufacturer: "Samsung",
                mpn: "CL05B104KO5NNNC",
                package: "0402",
            }],
            selectors: {},
            selectionCache: {
                '{"type":"Capacitor","value":"100nF","footprint":"0402","voltage":null,"power":null,"tolerance":null}': {
                    lcsc: "C1525",
                    partName: "CL05B104KO5NNNC",
                },
            },
        }, null, 2)}\n`);

        let selectCalls = 0;
        const result = await step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async () => {
                selectCalls++;
                throw new Error("selector should not be called when cache is populated");
            },
        });

        assert.equal(selectCalls, 0);
        assert.equal(result.components[0].info.LCSC, "C1525");
        const lock = readPartsLock(fixture.filePath);
        assert.deepEqual(lock.selectors, { C1: "C1525" });
        assert.equal(lock.selectionCache['{"type":"Capacitor","value":"100nF","footprint":"0402","voltage":null,"power":null,"tolerance":null}'].lcsc, "C1525");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 keeps earlier lock updates when a later part selection fails", async () => {
    const { fixture, compiled } = compile(`module top () {
    c1 = new Capacitor(value = "100nF", footprint = "0402");
    r1 = new Resistor(value = "10k", footprint = "0603");
}
`);

    try {
        let selectCalls = 0;
        await assert.rejects(step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async (component) => {
                selectCalls++;
                if (selectCalls === 1) {
                    return {
                        lcsc: "C1525",
                        manufacturer: "Samsung",
                        mpn: "CL05B104KO5NNNC",
                        package: "0402",
                    };
                }
                throw new Error(`no match for ${component.designator}`);
            },
        }));

        assert.equal(selectCalls, 2);
        const lock = readPartsLock(fixture.filePath);
        assert.equal(lock.parts.length, 1);
        assert.equal(Object.keys(lock.selectors).length, 1);
        assert.equal(Object.keys(lock.selectionCache).length, 1);
        assert.equal(lock.selectors.C1 || lock.selectors.R1, "C1525");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 can skip parts-lock writes", async () => {
    const { fixture, compiled } = compile(`module top () {
    r1 = new Resistor(value = "10k", footprint = "0603");
}
`);

    try {
        const result = await step3(fixture.filePath, compiled, {
            noPartsLock: true,
            downloadParts: false,
            selectPart: async () => ({
                lcsc: "C25804",
                manufacturer: "YAGEO",
                mpn: "RC0603FR-0710KL",
                package: "0603",
            }),
        });

        assert.equal(result.components[0].info.LCSC, "C25804");
        assert.equal(fs.existsSync(lockPathFor(fixture.filePath)), false);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 honors LCSC-selected generic primitives without searching JLC", async () => {
    const fixture = makeFixture(`module top () {
    part d1 = new Diode(value = "1N4148", LCSC="C8678");
}
`);
    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = await step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async () => {
                throw new Error("should not search");
            },
        });

        assert.equal(result.components[0].selectedPart.lcsc, "C8678");
        assert.equal(result.partsLock.selectors.D1, "C8678");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("makeBomRows excludes do-not-place components", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "R1",
                place: false,
                value: "0Ohm",
                power: "0.1W",
                voltage: undefined,
                tolerance: undefined,
                info: { package: "0603", partNumber: "RC0603", LCSC: "C1", manufacture: "YAGEO" },
                selectedPart: { package: "0603", mpn: "RC0603", lcsc: "C1", manufacturer: "YAGEO" },
                constructor: { name: "Resistor" },
            },
            {
                designator: "R2",
                value: "10k",
                power: "0.1W",
                voltage: undefined,
                tolerance: undefined,
                info: { package: "0603", partNumber: "RC0603", LCSC: "C2", manufacture: "YAGEO" },
                selectedPart: { package: "0603", mpn: "RC0603", lcsc: "C2", manufacturer: "YAGEO" },
                constructor: { name: "Resistor" },
            },
        ],
    });

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].designators, ["R2"]);
    assert.equal(rows[0].lcsc, "C2");
});

test("step3 enriches explicit LCSC-selected generic parts from JLC metadata when local metadata is incomplete", async () => {
    const fixture = makeFixture(`module top () {
    part r1 = new Resistor(value = "1kOhms", LCSC="C17513");
}
`);
    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = await step3(fixture.filePath, compiled, {
            downloadParts: false,
            searchJlcParts: async (query) => {
                assert.equal(query, "C17513");
                return [{
                    lcsc: "C17513",
                    manufacturer: "UNI-ROYAL",
                    mpn: "0805W8F1001T5E",
                    package: "R0805",
                    attributes: {
                        Resistance: "1kOhms",
                        Tolerance: "1%",
                        "Power(Watts)": "125mW",
                    },
                }];
            },
            selectPart: async () => {
                throw new Error("should not use generic part selection for explicit LCSC");
            },
        });

        assert.equal(result.components[0].selectedPart.package, "R0805");
        assert.equal(result.components[0].info.package, "R0805");
        assert.equal(result.components[0].info.tolerance, "±1%");
        assert.equal(result.components[0].info.wattage, "125mW");
        assert.equal(result.components[0].info.comment, "1kOhms ±1% 125mW");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 reselects auto-selected parts when imported KiCad assets are missing", async () => {
    const { fixture, compiled } = compile(`module top () {
    c1 = new Capacitor(value = "100nF", footprint = "0402");
}
`);

    try {
        const imported = [];
        const result = await step3(fixture.filePath, compiled, {
            selectParts: async () => [{
                lcsc: "C_BAD",
                manufacturer: "Bad",
                mpn: "NO_ASSETS",
                package: "0402",
            }, {
                lcsc: "C_GOOD",
                manufacturer: "Good",
                mpn: "HAS_ASSETS",
                package: "0402",
            }],
            addLcscPart: async (lcsc, options) => {
                imported.push(lcsc);
                const partName = lcsc;
                const directory = path.join(options.partsDir, partName);
                fs.mkdirSync(directory, { recursive: true });
                if (lcsc === "C_GOOD") {
                    fs.writeFileSync(path.join(directory, `${partName}.kicad_sym`), "");
                    fs.writeFileSync(path.join(directory, `${partName}.kicad_mod`), "");
                }
                return { partName, directory };
            },
        });

        assert.deepEqual(imported, ["C_BAD", "C_GOOD"]);
        assert.equal(result.components[0].info.LCSC, "C_GOOD");
        assert.equal(result.partsLock.selectors.C1, "C_GOOD");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 refreshes imported part files when assets exist but catalog metadata is incomplete", async () => {
    const fixture = makeFixture(`module top () {
    part r1 = new Resistor(value = "1kOhms", LCSC="C17513");
}
`);

    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const partName = "P_0805W8F1001T5E";
        const directory = path.join(fixture.dir, "parts", "autogenerated", partName);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `${partName}.kicad_sym`), "symbol");
        fs.writeFileSync(path.join(directory, `${partName}.kicad_mod`), "footprint");

        let imports = 0;
        const result = await step3(fixture.filePath, compiled, {
            searchJlcParts: async () => [{
                lcsc: "C17513",
                manufacturer: "UNI-ROYAL",
                mpn: "0805W8F1001T5E",
                package: "R0805",
                attributes: {
                    Resistance: "1kOhms",
                    Tolerance: "1%",
                    "Power(Watts)": "125mW",
                },
            }],
            addLcscPart: async (_lcsc, options) => {
                imports++;
                fs.writeFileSync(path.join(directory, `${partName}.schrune`), "refreshed");
                return {
                    partName,
                    directory,
                };
            },
        });

        assert.equal(imports, 1);
        assert.equal(result.components[0].info.comment, "1kOhms ±1% 125mW");
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 refreshes imported part files when the lock metadata is complete but the generated schrune file is stale", async () => {
    const fixture = makeFixture(`module top () {
    part r1 = new Resistor(value = "1kOhms", LCSC="C17513");
}
`);

    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const partName = "P_0805W8F1001T5E";
        const directory = path.join(fixture.dir, "parts", "autogenerated", partName);
        const lockPath = lockPathFor(fixture.filePath);
        fs.mkdirSync(directory, { recursive: true });
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(path.join(directory, `${partName}.kicad_sym`), "symbol");
        fs.writeFileSync(path.join(directory, `${partName}.kicad_mod`), "footprint");
        fs.writeFileSync(path.join(directory, `${partName}.schrune`), `part ${partName} {\n    info: {\n        package: "R0805",\n        comment: "",\n    }\n}\n`);
        fs.writeFileSync(lockPath, `${JSON.stringify({
            version: 1,
            parts: [{
                lcsc: "C17513",
                partName,
                manufacturer: "UNI-ROYAL",
                mpn: "0805W8F1001T5E",
                package: "R0805",
                attributes: {
                    Resistance: "1kOhms",
                    Tolerance: "±1%",
                    "Power(Watts)": "125mW",
                },
                comment: "1kOhms ±1% 125mW",
                value: "1kOhms",
                tolerance: "±1%",
                wattage: "125mW",
            }],
            selectors: {
                R1: "C17513",
            },
            selectionCache: {},
        }, null, 2)}\n`);

        let imports = 0;
        await step3(fixture.filePath, compiled, {
            addLcscPart: async (_lcsc, options) => {
                imports++;
                fs.writeFileSync(path.join(directory, `${partName}.schrune`), `part ${partName} {\n    info: {\n        package: "R0805",\n        value: "1kOhms",\n        tolerance: "±1%",\n        wattage: "125mW",\n        comment: "1kOhms ±1% 125mW",\n    }\n}\n`);
                return {
                    partName,
                    directory,
                };
            },
        });

        assert.equal(imports, 1);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("step3 reports generic component fetch progress", async () => {
    const { fixture, compiled } = compile(`module top () {
    c1 = new Capacitor(value = "100nF", footprint = "0402");
    r1 = new Resistor(value = "10k", footprint = "0603");
}
`);

    try {
        const progress = [];
        await step3(fixture.filePath, compiled, {
            downloadParts: false,
            selectPart: async (component) => ({
                lcsc: component.designator === "C1" ? "C1525" : "C25804",
                manufacturer: "Test",
                mpn: component.designator,
                package: "0603",
            }),
            onProgress: ({ current, total }) => {
                progress.push(`${current}/${total}`);
            },
        });

        assert.deepEqual(progress, ["0/2", "0/2", "1/2", "1/2", "2/2"]);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("readPartsLock returns an empty normalized lock when none exists", () => {
    const fixture = makeFixture("module top () {}\n");
    try {
        assert.deepEqual(readPartsLock(fixture.filePath), {
            version: 1,
            parts: [],
            selectors: {},
            selectionCache: {},
        });
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("BOM rows group equivalent components and CSV escapes fields", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "R1",
                constructor: { name: "Resistor" },
                value: "10k",
                footprint: "0603",
                info: {},
                selectedPart: {
                    lcsc: "C25804",
                    manufacturer: "YAGEO",
                    mpn: "RC0603FR-0710KL",
                    package: "0603",
                    description: 'precision, "thin film"',
                    attributes: {
                        Resistance: "10k",
                        Tolerance: "1%",
                        "Power(Watts)": "100mW",
                    },
                },
            },
            {
                designator: "R2",
                constructor: { name: "Resistor" },
                value: "10k",
                footprint: "0603",
                info: {},
                selectedPart: {
                    lcsc: "C25804",
                    manufacturer: "YAGEO",
                    mpn: "RC0603FR-0710KL",
                    package: "0603",
                    description: 'precision, "thin film"',
                    attributes: {
                        Resistance: "10k",
                        Tolerance: "1%",
                        "Power(Watts)": "100mW",
                    },
                },
            },
        ],
    });

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].designators, ["R1", "R2"]);
    assert.equal(rows[0].quantity, 2);
    assert.equal(rows[0].comment, "10k ±1% 100mW");
    assert.match(bomCsv(rows), /R1 R2,0603,10k ±1% 100mW,RC0603FR-0710KL,YAGEO,2,C25804/);
});

test("BOM rows stay merged when source-side labels differ for the same selected part", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "R1",
                constructor: { name: "Resistor" },
                value: "10k",
                footprint: "0603",
                info: {},
                selectedPart: {
                    lcsc: "C25804",
                    manufacturer: "YAGEO",
                    mpn: "RC0603FR-0710KL",
                    package: "0603",
                },
            },
            {
                designator: "R2",
                constructor: { name: "Resistor" },
                value: "10kOhm",
                footprint: "R_0603",
                info: {},
                selectedPart: {
                    lcsc: "C25804",
                    manufacturer: "YAGEO",
                    mpn: "RC0603FR-0710KL",
                    package: "R_0603",
                },
            },
        ],
    });

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].designators, ["R1", "R2"]);
    assert.equal(rows[0].quantity, 2);
});

test("BOM comments stay blank for non-autogenerated parts", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "U1",
                constructor: { name: "Component" },
                footprint: "QFN-32",
                info: {
                    partNumber: "STM32G031J6M6",
                    footprint: "QFN-32",
                    LCSC: "",
                },
            },
        ],
    });

    assert.equal(rows[0].comment, "");
    assert.match(bomCsv(rows), /U1,,,STM32G031J6M6,,1,/);
});

test("BOM uses user-authored info.comment when present", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "U1",
                constructor: { name: "Component" },
                footprint: "QFN-32",
                info: {
                    partNumber: "STM32G031J6M6",
                    footprint: "QFN-32",
                    LCSC: "C529630",
                    comment: "MCU main controller",
                },
            },
        ],
    });

    assert.equal(rows[0].comment, "MCU main controller");
    assert.match(bomCsv(rows), /U1,,MCU main controller,STM32G031J6M6,,1,C529630/);
});

test("BOM leaves footprint blank when package is not defined", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "U1",
                constructor: { name: "Component" },
                footprint: "QFN-32",
                info: {
                    partNumber: "STM32G031J6M6",
                    footprint: "./STM32G031J6M6.kicad_mod",
                    LCSC: "C529630",
                },
            },
        ],
    });

    assert.equal(rows[0].footprint, "");
    assert.match(bomCsv(rows), /U1,,,STM32G031J6M6,,1,C529630/);
});

test("BOM comments format capacitor, inductor, and diode attributes", () => {
    const rows = makeBomRows({
        components: [
            {
                designator: "C1",
                constructor: { name: "Capacitor" },
                value: "1uF",
                voltage: "10V",
                info: {},
                selectedPart: {
                    mpn: "CAP-1UF",
                    package: "0402",
                    attributes: {
                        Capacitance: "1uF",
                        Tolerance: "10%",
                        "Rated Voltage": "10V",
                        "Temperature Characteristics": "X5R",
                    },
                },
            },
            {
                designator: "L1",
                constructor: { name: "Inductor" },
                value: "10uH",
                info: {},
                selectedPart: {
                    mpn: "IND-10UH",
                    package: "0805",
                    attributes: {
                        Inductance: "10uH",
                        Tolerance: "20%",
                        "Rated Current": "3.2A",
                        DCR: "125mΩ",
                    },
                },
            },
            {
                designator: "D1",
                constructor: { name: "Diode" },
                value: "SS14",
                info: {},
                selectedPart: {
                    mpn: "DIODE-1A",
                    package: "SOD-123",
                    attributes: {
                        "Reverse Voltage (Vr)": "20V",
                        "Forward Voltage (Vf@If)": "550mV@1A",
                        "Average Rectified Current (Io)": "1A",
                    },
                },
            },
        ],
    });

    assert.equal(rows[0].comment, "1uF ±10% 10V X5R");
    assert.equal(rows[1].comment, "20V 550mV@1A 1A");
    assert.equal(rows[2].comment, "10uH ±20% 3.2A 125mΩ");
});
