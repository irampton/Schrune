const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    addLcscPart,
    extractPinsFromEasyEdaSymbol,
    isLikelyStepModel,
    modelDownloadCandidates,
    parseEasyEdaGraphics,
    parseEasyEdaPads,
    renderKiCadFootprint,
    sanitizeIdentifier,
} = require("../../src/lcsc");

function response(body, ok = true, status = 200) {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return {
        ok,
        status,
        async json() {
            return body;
        },
        async arrayBuffer() {
            return bodyBuffer.buffer.slice(
                bodyBuffer.byteOffset,
                bodyBuffer.byteOffset + bodyBuffer.byteLength
            );
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
                    x: 10,
                    y: 20,
                },
                shape: [
                    "PAD~RECT~12~24~1.5~2~11~~1~0.8~~90",
                    "TRACK~0.12~1~8,18 14,18 14,22",
                ],
            },
        },
    },
};

test("extracts EasyEDA symbol pins and sanitizes generated Schrune names", () => {
    const pins = extractPinsFromEasyEdaSymbol(easyEdaComponent.result.dataStr);
    assert.deepEqual(pins, [
        { name: "VCC", pad: "1" },
        { name: "GND", pad: "2" },
        { name: "GND", pad: "3" },
    ]);

    assert.equal(sanitizeIdentifier("ACME-123"), "ACME_123");
    assert.equal(sanitizeIdentifier("123 resistor"), "P_123_resistor");
    assert.equal(sanitizeIdentifier("!!!", "Fallback"), "Fallback");
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

test("preserves numeric-only pin names in generated Schrune parts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-lcsc-"));
    const numericComponent = JSON.parse(JSON.stringify(easyEdaComponent));
    numericComponent.result.dataStr.head.c_para["Manufacturer Part"] = "CONN-3";
    numericComponent.result.dataStr.shape = [
        "P~show~3~1~0~0~0~gge1~0^^1~0~0~0~1~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~2~0~0~0~gge2~0^^1~0~0~0~2~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~3~0~0~0~gge3~0^^1~0~0~0~3~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~4~0~0~0~gge4~0^^1~0~0~0~P_1~end~Tahoma~5.8pt~#0000FF",
    ];
    const fetch = async (url) => {
        if (String(url).includes("/api/products/C1234/components")) {
            return response(numericComponent);
        }
        return response("not found", false, 404);
    };

    try {
        await addLcscPart("C1234", { cwd: dir, fetch });
        const partFile = path.join(dir, "parts", "CONN_3", "CONN_3.schrune");
        const schrune = fs.readFileSync(partFile, "utf8");

        assert.match(schrune, /        1:1,/);
        assert.match(schrune, /        2:2,/);
        assert.match(schrune, /        3:3,/);
        assert.match(schrune, /        4:4,/);
        assert.doesNotMatch(schrune, /P_1:1/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("adds useful pin aliases for shift-register style symbols", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-lcsc-"));
    const shiftRegister = JSON.parse(JSON.stringify(easyEdaComponent));
    shiftRegister.result.dataStr.head.c_para["Manufacturer Part"] = "SN74HC165N";
    shiftRegister.result.dataStr.shape = [
        "P~show~3~1~0~0~0~gge1~0^^1~0~0~0~SH/LD~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~2~0~0~0~gge2~0^^1~0~0~0~CLK~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~3~0~0~0~gge3~0^^1~0~0~0~E~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~4~0~0~0~gge4~0^^1~0~0~0~F~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~5~0~0~0~gge5~0^^1~0~0~0~G~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~6~0~0~0~gge6~0^^1~0~0~0~H~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~10~0~0~0~gge10~0^^1~0~0~0~SER~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~11~0~0~0~gge11~0^^1~0~0~0~A~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~12~0~0~0~gge12~0^^1~0~0~0~B~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~13~0~0~0~gge13~0^^1~0~0~0~C~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~14~0~0~0~gge14~0^^1~0~0~0~D~end~Tahoma~5.8pt~#0000FF",
        "P~show~3~15~0~0~0~gge15~0^^1~0~0~0~CLK/INH~end~Tahoma~5.8pt~#0000FF",
    ];
    const fetch = async (url) => {
        if (String(url).includes("/api/products/C1234/components")) {
            return response(shiftRegister);
        }
        return response("not found", false, 404);
    };

    try {
        await addLcscPart("C1234", { cwd: dir, fetch });
        const partFile = path.join(dir, "parts", "SN74HC165N", "SN74HC165N.schrune");
        const schrune = fs.readFileSync(partFile, "utf8");

        assert.match(schrune, /SH_nLD:1/);
        assert.match(schrune, /CLK_INH:15/);
        assert.match(schrune, /inputs: \[/);
        assert.match(schrune, /A:11/);
        assert.match(schrune, /H:6/);
        assert.match(schrune, /SER:10/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("tries the EasyEDA STEP endpoint before legacy model URLs", () => {
    const candidates = modelDownloadCandidates(easyEdaComponent.result);
    assert.equal(
        candidates[0],
        "https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/model-uuid"
    );
});

test("rejects empty or error payloads as STEP models", () => {
    assert.equal(isLikelyStepModel(Buffer.alloc(0)), false);
    assert.equal(isLikelyStepModel(Buffer.from("<Error>NoSuchKey</Error>")), false);
    assert.equal(isLikelyStepModel(Buffer.from('{"error":"not found"}')), false);
    assert.equal(isLikelyStepModel(Buffer.from("ISO-10303-21;\nENDSEC;\nEND-ISO-10303-21;")), true);
});

test("downloads STEP model and references it from Schrune and KiCad footprint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-lcsc-model-"));
    const step = Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n");
    const fetch = async (url) => {
        if (String(url).includes("/api/products/C1234/components")) {
            return response(easyEdaComponent);
        }
        if (String(url) === "https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/model-uuid") {
            return response(step);
        }
        return response("not found", false, 404);
    };

    try {
        const result = await addLcscPart("C1234", { cwd: dir, fetch });
        const partDir = path.join(dir, "parts", "ACME_123");

        assert.equal(result.modelDownloaded, true);
        assert.equal(fs.readFileSync(path.join(partDir, "ACME_123.step"), "utf8"), step.toString("utf8"));

        const schrune = fs.readFileSync(path.join(partDir, "ACME_123.schrune"), "utf8");
        assert.match(schrune, /model: "\.\/ACME_123\.step"/);

        const footprint = fs.readFileSync(path.join(partDir, "ACME_123.kicad_mod"), "utf8");
        assert.match(footprint, /\(model "\$\{KIPRJMOD\}\/parts\/ACME_123\/ACME_123\.step"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("parses EasyEDA pads relative to the package origin", () => {
    assert.deepEqual(parseEasyEdaPads(easyEdaComponent.result.packageDetail.dataStr), [{
        shape: "rect",
        x: 2,
        y: -4,
        width: 1.5,
        height: 2,
        layer: "11",
        number: "1",
        drill: 0.8,
        rotation: 90,
    }]);
});

test("parses EasyEDA footprint silkscreen graphics", () => {
    assert.deepEqual(parseEasyEdaGraphics(easyEdaComponent.result.packageDetail.dataStr), [
        {
            type: "line",
            start: { x: -2, y: 2 },
            end: { x: 4, y: 2 },
            width: 0.12,
        },
        {
            type: "line",
            start: { x: 4, y: 2 },
            end: { x: 4, y: -2 },
            width: 0.12,
        },
    ]);
});

test("renders KiCad footprint without a model block when no STEP file is provided", () => {
    const footprint = renderKiCadFootprint("NoModel", {
        head: {},
        shape: ["PAD~ELLIPSE~0~0~1~1~~~A"],
    });

    assert.match(footprint, /\(footprint "NoModel"/);
    assert.match(footprint, /\(pad "A" smd oval/);
    assert.doesNotMatch(footprint, /\(model /);
});
