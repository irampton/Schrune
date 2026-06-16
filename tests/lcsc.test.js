const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    addLcscPart,
    extractPinsFromEasyEdaSymbol,
    sanitizeIdentifier,
} = require("../src/lcsc");

function response(body, ok = true, status = 200) {
    return {
        ok,
        status,
        async json() {
            return body;
        },
        async arrayBuffer() {
            return Buffer.from(String(body)).buffer;
        },
    };
}

const easyEdaComponent = {
    success: true,
    result: {
        title: "Demo Part",
        lcsc: { number: "C1234" },
        dataStr: {
            head: {
                c_para: {
                    pre: "U?",
                    "Manufacturer Part": "ACME-123",
                    Manufacturer: "ACME",
                    package: "QFN-4",
                },
            },
            shape: [
                "P~show~3~1~0~0~0~gge1~0^^1~0~0~0~VCC~end~Tahoma~5.8pt~#0000FF^^1~0~0~0~1~end~Tahoma~5.8pt~#0000FF",
                "P~show~3~2~0~0~0~gge2~0^^1~0~0~0~GND~end~Tahoma~5.8pt~#0000FF^^1~0~0~0~2~end~Tahoma~5.8pt~#0000FF",
                "P~show~3~3~0~0~0~gge3~0^^1~0~0~0~GND~end~Tahoma~5.8pt~#0000FF^^1~0~0~0~3~end~Tahoma~5.8pt~#0000FF",
            ],
        },
        packageDetail: {
            dataStr: {
                head: {
                    uuid_3d: "model-uuid",
                },
                shape: ["PAD~RECT~0~0~1~1~1~~1"],
            },
        },
    },
};

test("extracts EasyEDA symbol pins and uniquifies generated Schrune names", async () => {
    const pins = extractPinsFromEasyEdaSymbol(easyEdaComponent.result.dataStr);
    assert.deepEqual(pins, [
        { name: "VCC", pad: "1" },
        { name: "GND", pad: "2" },
        { name: "GND", pad: "3" },
    ]);

    assert.equal(sanitizeIdentifier("ACME-123"), "ACME_123");
});

test("adds an LCSC part into parts with KiCad files and Schrune file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-lcsc-"));
    const fetch = async (url) => {
        if (String(url).includes("/api/products/C1234/components")) {
            return response(easyEdaComponent);
        }
        return response("not found", false, 404);
    };

    try {
        const result = await addLcscPart("C1234", { cwd: dir, fetch });
        const partDir = path.join(dir, "parts", "ACME_123");
        const partFile = path.join(partDir, "ACME_123.schrune");

        assert.equal(result.partName, "ACME_123");
        assert.equal(result.modelDownloaded, false);
        assert.equal(fs.existsSync(path.join(partDir, "component.easyeda.json")), false);
        assert.equal(fs.existsSync(path.join(partDir, "symbol.easyeda.json")), false);
        assert.equal(fs.existsSync(path.join(partDir, "footprint.easyeda.json")), false);
        assert.equal(fs.existsSync(path.join(partDir, "ACME_123.kicad_sym")), true);
        assert.equal(fs.existsSync(path.join(partDir, "ACME_123.kicad_mod")), true);
        assert.equal(fs.existsSync(path.join(partDir, "model.step.json")), false);

        const schrune = fs.readFileSync(partFile, "utf8");
        assert.match(schrune, /part ACME_123/);
        assert.match(schrune, /LCSC: "C1234"/);
        assert.match(schrune, /footprint: "\.\/ACME_123\.kicad_mod"/);
        assert.match(schrune, /symbol: "\.\/ACME_123\.kicad_sym"/);
        assert.doesNotMatch(schrune, /model:/);
        assert.match(schrune, /VCC:1/);
        assert.match(schrune, /GND:2/);
        assert.match(schrune, /GND_3:3/);

        const symbol = fs.readFileSync(path.join(partDir, "ACME_123.kicad_sym"), "utf8");
        assert.match(symbol, /\(kicad_symbol_lib/);
        assert.match(symbol, /\(pin passive line/);

        const footprint = fs.readFileSync(path.join(partDir, "ACME_123.kicad_mod"), "utf8");
        assert.match(footprint, /\(footprint "ACME_123"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
