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

function bridgeRunner(partName, component, destinationDir, modelProjectDir) {
    const modelFile = component.packageDetail
        && component.packageDetail.dataStr
        && component.packageDetail.dataStr.head
        && component.packageDetail.dataStr.head.uuid_3d
        ? `${partName}.step`
        : undefined;
    const symbol = `(kicad_symbol_lib (version 20251024) (generator "Schrune") (generator_version "10.0")
  (symbol ${JSON.stringify(partName)} (in_bom yes) (on_board yes)
    (property "Reference" "U?" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" ${JSON.stringify(partName)} (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" ${JSON.stringify(`./${partName}.kicad_mod`)} (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
  )
)
`;
    const footprint = `(footprint ${JSON.stringify(partName)} (version 20260206) (generator "Schrune") (generator_version "10.0")
  (pad "1" thru_hole rect (at 0 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask"))
${modelFile ? `  (model "${"${KIPRJMOD}"}/${modelProjectDir.replace(/\\/g, "/")}/${modelFile}")\n` : ""})
`;
    fs.writeFileSync(path.join(destinationDir, `${partName}.kicad_sym`), symbol);
    fs.writeFileSync(path.join(destinationDir, `${partName}.kicad_mod`), footprint);
    return { symbolFile: `${partName}.kicad_sym`, footprintFile: `${partName}.kicad_mod` };
}

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
        const result = await addLcscPart("C1234", { cwd: dir, fetch, bridgeRunner });
        const partDir = path.join(dir, "parts", "ACME_123");
        const partFile = path.join(partDir, "ACME_123.schrune");

        assert.equal(result.partName, "ACME_123");
        assert.equal(result.modelDownloaded, false);
        assert.equal(fs.existsSync(path.join(partDir, "ACME_123.kicad_sym")), true);
        assert.equal(fs.existsSync(path.join(partDir, "ACME_123.kicad_mod")), true);

        const schrune = fs.readFileSync(partFile, "utf8");
        assert.match(schrune, /part ACME_123/);
        assert.match(schrune, /LCSC: "C1234"/);
        assert.match(schrune, /footprint: "\.\/ACME_123\.kicad_mod"/);
        assert.match(schrune, /symbol: "\.\/ACME_123\.kicad_sym"/);
        assert.doesNotMatch(schrune, /model:/);
        assert.match(schrune, /VCC:1/);
        assert.match(schrune, /GND:2/);
        assert.match(schrune, /GND_3:3/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("downloads STEP model and passes it through to the bridge output", async () => {
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
        const result = await addLcscPart("C1234", { cwd: dir, fetch, bridgeRunner });
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
