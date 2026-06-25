const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildJlcBom, calculateEconomicEstimate, calculateStandardEstimate, parseBomCsv, renderJlcBomReport } = require("../../src/jlc-bom");
const { buildPathsForEntry, writeProjectConfig } = require("../../src/project");

function makeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-jlc-bom-"));
    const entryPath = path.join(dir, "main.schrune");
    fs.writeFileSync(entryPath, "module top () {}\n");
    writeProjectConfig(path.join(dir, "schrune.json"), {
        name: "Demo",
        entry: "./main.schrune",
        parts: [],
    });

    const bomPath = buildPathsForEntry(entryPath, "Demo").bomPath;
    fs.mkdirSync(path.dirname(bomPath), { recursive: true });
    fs.writeFileSync(bomPath, [
        "Designator,Footprint,Comment,Manufacturer Part Number,Manufacturer,Quantity,LCSC",
        "R1 R2,0603,10k,RC0603FR,YAGEO,2,C100",
        "U1,QFN-32,MCU,STM32G031J6M6,ST,1,C200",
        "C1,0402,100nF,CL05B104KO5NNNC,Samsung,1,C300",
        "",
    ].join("\n"));

    const partsDir = path.join(dir, "parts");
    fs.mkdirSync(path.join(partsDir, "RC0603FR"), { recursive: true });
    fs.mkdirSync(path.join(partsDir, "STM32G031J6M6"), { recursive: true });
    fs.mkdirSync(path.join(partsDir, "CL05B104KO5NNNC"), { recursive: true });
    fs.writeFileSync(path.join(partsDir, "RC0603FR", "RC0603FR.kicad_mod"), "(footprint \"R\"\n  (pad \"1\")\n  (pad \"2\")\n)\n");
    fs.writeFileSync(path.join(partsDir, "STM32G031J6M6", "STM32G031J6M6.kicad_mod"), "(footprint \"U\"\n  (pad \"1\")\n  (pad \"2\")\n  (pad \"3\")\n  (pad \"4\")\n)\n");
    fs.writeFileSync(path.join(partsDir, "CL05B104KO5NNNC", "CL05B104KO5NNNC.kicad_mod"), "(footprint \"C\"\n  (pad \"1\")\n  (pad \"2\")\n)\n");

    return { dir };
}

test("parseBomCsv reads grouped schrune BOM rows", () => {
    const rows = parseBomCsv([
        "Designator,Footprint,Comment,Manufacturer Part Number,Manufacturer,Quantity,LCSC",
        "\"R1 R2\",0603,10k,RC0603FR,YAGEO,2,C100",
        "",
    ].join("\n"));

    assert.deepEqual(rows, [{
        designators: ["R1", "R2"],
        footprint: "0603",
        comment: "10k",
        mpn: "RC0603FR",
        manufacturer: "YAGEO",
        quantity: 2,
        lcsc: "C100",
    }]);
});

test("buildJlcBom groups JLC parts and computes stock warnings for -n", async () => {
    const fixture = makeFixture();
    const calls = [];

    try {
        const report = await buildJlcBom({
            cwd: fixture.dir,
            boardCount: 30,
            searchJlcParts: async (query) => {
                calls.push(query);
                if (query === "C100") {
                    return [{
                        lcsc: "C100",
                        stock: 1000,
                        unitCost: 0.001,
                        prices: [{ qFrom: 1, qTo: 9999, price: 0.001 }],
                        isBasic: true,
                        isPreferred: false,
                    }];
                }
                if (query === "C200") {
                    return [{
                        lcsc: "C200",
                        stock: 20,
                        unitCost: 0.11,
                        prices: [{ qFrom: 1, qTo: 9999, price: 0.11 }],
                        isBasic: false,
                        isPreferred: true,
                    }];
                }
                return [{
                    lcsc: "C300",
                    stock: 500,
                    unitCost: 0.002,
                    prices: [{ qFrom: 1, qTo: 9999, price: 0.002 }],
                    isBasic: false,
                    isPreferred: false,
                }];
            },
        });

        assert.deepEqual(calls, ["C100", "C200", "C300"]);
        assert.equal(report.sections.basic.length, 1);
        assert.equal(report.sections.promoted.length, 1);
        assert.equal(report.sections.extended.length, 1);
        assert.equal(report.sections.basic[0].perBoardCost, 0.002);
        assert.equal(report.sections.promoted[0].jointsPerBoard, 4);
        assert.equal(report.stockWarnings.length, 1);
        assert.equal(report.stockWarnings[0].row.lcsc, "C200");
        assert.equal(report.stockWarnings[0].required, 30);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("renderJlcBomReport prints sections, breakdowns, totals, and stock notes", async () => {
    const fixture = makeFixture();

    try {
        const report = await buildJlcBom({
            cwd: fixture.dir,
            boardCount: 15,
            searchJlcParts: async (query) => [{
                lcsc: query,
                stock: query === "C200" ? 10 : 500,
                unitCost: query === "C200" ? 0.12 : 0.003,
                prices: [{ qFrom: 1, qTo: 9999, price: query === "C200" ? 0.12 : 0.003 }],
                isBasic: query === "C100",
                isPreferred: query === "C200",
            }],
        });

        const output = renderJlcBomReport(report, {
            showBreakdown: true,
            stream: { isTTY: false },
        });

        assert.match(output, /Basic/);
        assert.match(output, /Promoted Extended/);
        assert.match(output, /Extended/);
        assert.match(output, /Economic estimate for 15 boards/);
        assert.match(output, /Standard estimate for 15 boards/);
        assert.match(output, /Economic totals/);
        assert.match(output, /Standard totals/);
        assert.match(output, /Potential stock issues/);
        assert.match(output, /C200 \(MCU\): need 15, 10 in stock/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("assembly estimate helpers apply the expected fee models", () => {
    const rows = [
        {
            section: "basic",
            jointsPerBoard: 4,
            totalPurchaseCostForBoards: (count) => count * 0.02,
        },
        {
            section: "extended",
            jointsPerBoard: 10,
            totalPurchaseCostForBoards: (count) => count * 0.5,
        },
        {
            section: "promoted",
            jointsPerBoard: 16,
            totalPurchaseCostForBoards: (count) => count * 0.8,
        },
    ];

    const economic = calculateEconomicEstimate(rows, 5);
    const standard = calculateStandardEstimate(rows, 5);

    assert.equal(economic.extendedFees, 3);
    assert.equal(economic.total, 8 + 1.5 + (30 * 5 * 0.0016) + (5 * 1.32) + 3);
    assert.equal(standard.loaderFees, 3);
    assert.equal(standard.total, 25 + 7.68 + (30 * 5 * 0.0016) + (5 * 1.32) + 3);
});
