const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const EASYEDA_COMPONENT_API = "https://easyeda.com/api/products";
const EASYEDA_STEP_MODEL_API = "https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y";

function assertLcscPartNumber(partNumber) {
    if (!/^C\d+$/i.test(partNumber)) {
        throw new Error('Specify an LCSC part number like "C2040"');
    }
}

function sanitizeIdentifier(value, fallback = "Part") {
    const sanitized = String(value || fallback)
        .trim()
        .replace(/[^A-Za-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    if (!sanitized) {
        return fallback;
    }

    return /^[A-Za-z_]/.test(sanitized) ? sanitized : `P_${sanitized}`;
}

function sanitizeFileName(value, fallback = "part") {
    const sanitized = sanitizeIdentifier(value, fallback);
    return sanitized || fallback;
}

function jsString(value) {
    return JSON.stringify(value);
}

async function fetchJson(url, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) {
        throw new Error("This Node.js runtime does not provide fetch");
    }

    const response = await fetchImpl(url);
    if (!response.ok) {
        throw new Error(`Request failed ${response.status}: ${url}`);
    }

    return response.json();
}

async function fetchBuffer(url, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(url);
    if (!response.ok) {
        throw new Error(`Request failed ${response.status}: ${url}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

function isLikelyStepModel(content) {
    if (!Buffer.isBuffer(content) || content.length === 0) {
        return false;
    }

    const header = content.subarray(0, Math.min(content.length, 256)).toString("utf8").trimStart();
    if (!header) {
        return false;
    }

    if (/^(<\?xml|<Error|<!doctype|<html|\{|\[)/i.test(header)) {
        return false;
    }

    return header.startsWith("ISO-10303-21") || header.includes("ISO-10303-21");
}

async function fetchEasyEdaComponent(partNumber, options = {}) {
    assertLcscPartNumber(partNumber);
    const normalized = partNumber.toUpperCase();
    const version = options.version || "6.4.19.5";
    const url = `${EASYEDA_COMPONENT_API}/${normalized}/components?version=${encodeURIComponent(version)}`;
    const payload = await fetchJson(url, options.fetch);

    if (!payload || payload.success !== true || !payload.result) {
        throw new Error(`Could not find LCSC part ${normalized}`);
    }

    return payload.result;
}

function textFromEasyEdaSegment(segment) {
    const fields = segment.split("~");
    return fields[0] === "1" ? fields[4] : undefined;
}

function extractPinsFromEasyEdaSymbol(symbolData) {
    const shapes = symbolData && symbolData.shape;
    if (!Array.isArray(shapes)) {
        return [];
    }

    const pins = [];
    for (const shape of shapes) {
        if (typeof shape !== "string" || !shape.startsWith("P~")) {
            continue;
        }

        const sections = shape.split("^^");
        const pinFields = sections[0].split("~");
        const pad = pinFields[3];
        if (!pad) {
            continue;
        }

        const labels = sections
            .map(textFromEasyEdaSegment)
            .filter((label) => label && label !== pad);
        const rawName = labels[0] || pad;
        pins.push({
            name: rawName,
            pad,
        });
    }

    return pins.sort((left, right) => {
        const leftNumber = Number(left.pad);
        const rightNumber = Number(right.pad);
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
            return leftNumber - rightNumber;
        }
        return String(left.pad).localeCompare(String(right.pad), undefined, { numeric: true });
    });
}

function uniquePinEntries(pins) {
    const usedNames = new Map();
    return pins.map((pin) => {
        const rawName = normalizePinName(pin.name);
        const sanitizedName = /^\d+$/.test(rawName)
            ? String(pin.pad)
            : sanitizeIdentifier(rawName, `PIN_${pin.pad}`);
        const baseName = sanitizedName === "SH_LD"
            ? "SH_nLD"
            : (/^P_\d+$/.test(sanitizedName) && /^\d+$/.test(String(pin.pad)) ? String(pin.pad) : sanitizedName);
        const count = usedNames.get(baseName) || 0;
        usedNames.set(baseName, count + 1);
        const suffix = String(pin.pad).replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
        return {
            name: count === 0 ? baseName : `${baseName}_${suffix || count + 1}`,
            pad: pin.pad,
        };
    });
}

function normalizePinName(name) {
    const rawName = String(name || "").trim();
    if (/^SH\/LD$/i.test(rawName)) {
        return "SH_nLD";
    }

    return rawName.replace(/\//g, "_");
}

function inferPinGroups(pins) {
    const byName = new Map(pins.map((pin) => [pin.name, pin]));
    const inputNames = ["A", "B", "C", "D", "E", "F", "G", "H"];
    if (!inputNames.every((name) => byName.has(name))) {
        return pins;
    }

    const group = inputNames.map((name) => byName.get(name));
    if (byName.has("SER")) {
        group.push(byName.get("SER"));
    }

    return [
        ...pins,
        {
            name: "inputs",
            group: group.map((pin) => ({ name: pin.name, pad: pin.pad })),
        },
    ];
}

function componentInfo(component, assets) {
    const cPara = component.dataStr && component.dataStr.head && component.dataStr.head.c_para
        ? component.dataStr.head.c_para
        : {};

    return {
        partNumber: cPara["Manufacturer Part"] || cPara.name || component.title,
        manufacture: cPara.Manufacturer || cPara.Supplier || "Unknown",
        footprint: assets.footprint,
        symbol: assets.symbol,
        model: assets.model,
        LCSC: component.lcsc && component.lcsc.number || component.szlcsc && component.szlcsc.number,
        designatorPrefix: cPara.pre ? String(cPara.pre).replace(/\?$/, "") : "U",
    };
}

function renderInfo(info) {
    const lines = Object.entries(info)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `        ${key}: ${jsString(value)},`);
    return lines.join("\n");
}

function renderPinEntry(pin, indent = 8) {
    const padding = " ".repeat(indent);
    if (pin.group) {
        const groupPins = pin.group.map((child) => renderPinEntry(child, indent + 4)).join("\n");
        return `${padding}${pin.name}: [\n${groupPins}\n${padding}],`;
    }

    return `${padding}${pin.name}:${pin.pad},`;
}

function renderPins(pins) {
    return pins.map((pin) => renderPinEntry(pin)).join("\n");
}

function renderSchrunePart(partName, info, pins) {
    return `part ${partName} {\n` +
        `    info: {\n` +
        `${renderInfo(info)}\n` +
        `    }\n\n` +
        `    pins: [\n` +
        `${renderPins(pins)}\n` +
        `    ]\n` +
        `}\n`;
}

function kicadString(value) {
    return JSON.stringify(String(value));
}

function renderKiCadSymbol(partName, info, pins) {
    const prefix = info.designatorPrefix || "U";
    const pinSpacing = 2.54;
    const leftPins = pins.filter((_, index) => index % 2 === 0);
    const rightPins = pins.filter((_, index) => index % 2 === 1);
    const maxSidePins = Math.max(leftPins.length, rightPins.length, 1);
    const height = Math.max(10.16, (maxSidePins + 1) * pinSpacing);
    const width = 20.32;
    const top = height / 2;
    const leftX = -width / 2;
    const rightX = width / 2;

    function renderPin(pin, sidePins, side) {
        const index = sidePins.indexOf(pin);
        const y = top - ((index + 1) * pinSpacing);
        const x = side === "left" ? leftX - pinSpacing : rightX + pinSpacing;
        const angle = side === "left" ? 0 : 180;
        return `      (pin passive line (at ${x.toFixed(2)} ${y.toFixed(2)} ${angle}) (length ${pinSpacing.toFixed(2)})\n` +
            `        (name ${kicadString(pin.name)} (effects (font (size 1.27 1.27))))\n` +
            `        (number ${kicadString(pin.pad)} (effects (font (size 1.27 1.27))))\n` +
            `      )`;
    }

    const pinLines = [
        ...leftPins.map((pin) => renderPin(pin, leftPins, "left")),
        ...rightPins.map((pin) => renderPin(pin, rightPins, "right")),
    ];

    return `(kicad_symbol_lib (version 20211014) (generator Schrune)\n` +
        `  (symbol ${kicadString(partName)} (pin_names (offset 1.016)) (in_bom yes) (on_board yes)\n` +
        `    (property "Reference" ${kicadString(`${prefix}?`)} (at 0 ${(top + 2.54).toFixed(2)} 0)\n` +
        `      (effects (font (size 1.27 1.27)))\n` +
        `    )\n` +
        `    (property "Value" ${kicadString(partName)} (at 0 ${(-top - 2.54).toFixed(2)} 0)\n` +
        `      (effects (font (size 1.27 1.27)))\n` +
        `    )\n` +
        `    (property "Footprint" ${kicadString(info.footprint || "")} (at 0 ${(-top - 5.08).toFixed(2)} 0)\n` +
        `      (effects (font (size 1.27 1.27)) hide)\n` +
        `    )\n` +
        `    (property "Datasheet" "" (at 0 0 0)\n` +
        `      (effects (font (size 1.27 1.27)) hide)\n` +
        `    )\n` +
        `    (symbol ${kicadString(`${partName}_0_1`)}\n` +
        `      (rectangle (start ${leftX.toFixed(2)} ${top.toFixed(2)}) (end ${rightX.toFixed(2)} ${(-top).toFixed(2)})\n` +
        `        (stroke (width 0.254) (type default))\n` +
        `        (fill (type background))\n` +
        `      )\n` +
        `${pinLines.join("\n")}\n` +
        `    )\n` +
        `  )\n` +
        `)\n`;
}

function parseEasyEdaPads(footprintData) {
    const shapes = footprintData && footprintData.shape;
    if (!Array.isArray(shapes)) {
        return [];
    }

    const originX = Number(footprintData.head && footprintData.head.x) || 0;
    const originY = Number(footprintData.head && footprintData.head.y) || 0;
    return shapes
        .filter((shape) => typeof shape === "string" && shape.startsWith("PAD~"))
        .map((shape) => {
            const fields = shape.split("~");
            const layer = fields[6] || "1";
            const width = Math.abs(Number(fields[4]) || 1);
            const height = Math.abs(Number(fields[5]) || 1);
            const explicitDrill = Number(fields[9]) || Number(fields[13]) || 0;
            return {
                shape: String(fields[1] || "RECT").toLowerCase(),
                x: Number(fields[2]) - originX,
                y: -(Number(fields[3]) - originY),
                width,
                height,
                layer,
                number: fields[8] || "",
                drill: explicitDrill || (layer === "11" ? Math.min(width, height) * 0.5 : 0),
                rotation: Number(fields[11]) || 0,
            };
        })
        .filter((pad) => pad.number);
}

function parseEasyEdaGraphics(footprintData) {
    const shapes = footprintData && footprintData.shape;
    if (!Array.isArray(shapes)) {
        return [];
    }

    const originX = Number(footprintData.head && footprintData.head.x) || 0;
    const originY = Number(footprintData.head && footprintData.head.y) || 0;
    const graphics = [];

    for (const shape of shapes) {
        if (typeof shape !== "string") {
            continue;
        }

        const fields = shape.split("~");
        if (fields[0] === "TRACK") {
            const width = Number(fields[1]) || 0.12;
            const points = String(fields[3] || "").split(" ").map((point) => {
                const [x, y] = point.split(",").map(Number);
                return { x: x - originX, y: -(y - originY) };
            }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

            for (let i = 0; i < points.length - 1; i++) {
                graphics.push({
                    type: "line",
                    start: points[i],
                    end: points[i + 1],
                    width,
                });
            }
        }

        if (fields[0] === "RECT") {
            const x = Number(fields[1]) - originX;
            const y = -(Number(fields[2]) - originY);
            const width = Math.abs(Number(fields[3]) || 0);
            const height = Math.abs(Number(fields[4]) || 0);
            if (width && height) {
                graphics.push({
                    type: "rect",
                    start: { x, y },
                    end: { x: x + width, y: y - height },
                    width: Number(fields[5]) || 0.12,
                });
            }
        }

        if (fields[0] === "CIRCLE") {
            const x = Number(fields[1]) - originX;
            const y = -(Number(fields[2]) - originY);
            const radius = Math.abs(Number(fields[3]) || 0);
            if (radius) {
                graphics.push({
                    type: "circle",
                    center: { x, y },
                    end: { x: x + radius, y },
                    width: Number(fields[4]) || 0.12,
                });
            }
        }
    }

    return graphics;
}

function renderGraphic(graphic) {
    if (graphic.type === "line") {
        return `  (fp_line (start ${graphic.start.x.toFixed(4)} ${graphic.start.y.toFixed(4)}) ` +
            `(end ${graphic.end.x.toFixed(4)} ${graphic.end.y.toFixed(4)})\n` +
            `    (stroke (width ${graphic.width.toFixed(4)}) (type solid)) (layer "F.SilkS"))`;
    }

    if (graphic.type === "rect") {
        return `  (fp_rect (start ${graphic.start.x.toFixed(4)} ${graphic.start.y.toFixed(4)}) ` +
            `(end ${graphic.end.x.toFixed(4)} ${graphic.end.y.toFixed(4)})\n` +
            `    (stroke (width ${graphic.width.toFixed(4)}) (type solid)) (fill none) (layer "F.SilkS"))`;
    }

    return `  (fp_circle (center ${graphic.center.x.toFixed(4)} ${graphic.center.y.toFixed(4)}) ` +
        `(end ${graphic.end.x.toFixed(4)} ${graphic.end.y.toFixed(4)})\n` +
        `    (stroke (width ${graphic.width.toFixed(4)}) (type solid)) (fill none) (layer "F.SilkS"))`;
}

function isThroughHolePad(pad) {
    return pad.drill > 0 || pad.layer === "11";
}

function renderKiCadFootprint(partName, footprintData, stepFileName, modelProjectDir = `parts/${partName}`) {
    const pads = parseEasyEdaPads(footprintData);
    const padLines = pads.map((pad) => {
        const shape = pad.shape === "ellipse" || pad.shape === "oval" ? "oval" : pad.shape === "circle" ? "circle" : "rect";
        const throughHole = isThroughHolePad(pad);
        const padType = throughHole ? "thru_hole" : "smd";
        const layers = throughHole ? `"*.Cu" "*.Mask"` : `"F.Cu" "F.Paste" "F.Mask"`;
        const drill = throughHole ? ` (drill ${pad.drill.toFixed(4)})` : "";
        return `  (pad ${kicadString(pad.number)} ${padType} ${shape} (at ${pad.x.toFixed(4)} ${pad.y.toFixed(4)} ${pad.rotation}) ` +
            `(size ${pad.width.toFixed(4)} ${pad.height.toFixed(4)}) (layers ${layers})${drill})`;
    });
    const graphicLines = parseEasyEdaGraphics(footprintData).map(renderGraphic);
    const model = stepFileName
        ? `\n  (model "\${KIPRJMOD}/${modelProjectDir.replace(/\\/g, "/")}/${stepFileName}"\n` +
            `    (offset (xyz 0 0 0))\n` +
            `    (scale (xyz 1 1 1))\n` +
            `    (rotate (xyz 0 0 0))\n` +
            `  )`
        : "";

    const attr = pads.some(isThroughHolePad) ? "through_hole" : "smd";
    return `(footprint ${kicadString(partName)} (version 20241229) (generator Schrune)\n` +
        `  (attr ${attr})\n` +
        `  (fp_text reference "REF**" (at 0 -5 0) (layer "F.SilkS")\n` +
        `    (effects (font (size 1 1) (thickness 0.15)))\n` +
        `  )\n` +
        `  (fp_text value ${kicadString(partName)} (at 0 5 0) (layer "F.Fab")\n` +
        `    (effects (font (size 1 1) (thickness 0.15)))\n` +
        `  )\n` +
        `${graphicLines.length ? `${graphicLines.join("\n")}\n` : ""}` +
        `${padLines.join("\n")}${model}\n` +
        `)\n`;
}

function runEasyeda2KicadBridge(partName, component, destinationDir, modelProjectDir, options = {}) {
    const pythonPath = options.easyeda2KicadPythonPath || process.env.EASYEDA2KICAD_PYTHONPATH;
    const bridgePath = path.resolve(__dirname, "..", "scripts", "easyeda2kicad_bridge.py");
    const inputPath = path.join(os.tmpdir(), `schrune-${partName}-${Date.now()}.easyeda.json`);
    fs.writeFileSync(inputPath, JSON.stringify(component));

    const env = { ...process.env };
    if (pythonPath || process.env.PYTHONPATH) {
        env.PYTHONPATH = [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    const result = spawnSync(options.python || "python", [
        bridgePath,
        "--input", inputPath,
        "--output-dir", destinationDir,
        "--symbol-file", `${partName}.kicad_sym`,
        "--footprint-file", `${partName}.kicad_mod`,
        "--model-path", modelProjectDir ? `\${KIPRJMOD}/${modelProjectDir}` : "${KIPRJMOD}",
        "--footprint-lib", "Schrune",
    ], {
        env,
        encoding: "utf8",
    });

    try {
        fs.unlinkSync(inputPath);
    } catch (_error) {
        // Best-effort cleanup only.
    }

    if (result.status !== 0) {
        if (options.requireEasyeda2Kicad) {
            throw new Error(`easyeda2kicad failed: ${result.stderr || result.stdout}`);
        }
        return undefined;
    }

    return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

function modelDownloadCandidates(component) {
    const head = component.packageDetail
        && component.packageDetail.dataStr
        && component.packageDetail.dataStr.head
        ? component.packageDetail.dataStr.head
        : {};
    const uuid = head.uuid_3d;
    if (!uuid) {
        return [];
    }

    return [
        `${EASYEDA_STEP_MODEL_API}/${uuid}`,
        `https://modules.easyeda.com/${uuid}`,
        `https://modules.easyeda.com/${uuid}.step`,
        `https://modules.easyeda.com/${uuid}.STEP`,
        `https://modules.easyeda.com/3dmodel/${uuid}`,
        `https://modules.easyeda.com/3dmodel/${uuid}.step`,
        `https://modules.easyeda.com/model/${uuid}`,
        `https://modules.easyeda.com/model/${uuid}.step`,
    ];
}

async function tryDownloadModel(component, destinationDir, partName, options = {}) {
    const candidates = modelDownloadCandidates(component);
    const metadata = {
        uuid: component.packageDetail
            && component.packageDetail.dataStr
            && component.packageDetail.dataStr.head
            && component.packageDetail.dataStr.head.uuid_3d,
        attemptedUrls: candidates,
    };

    for (const url of candidates) {
        try {
            const content = await fetchBuffer(url, options.fetch);
            if (!isLikelyStepModel(content)) {
                throw new Error(`Response was not a STEP model: ${url}`);
            }
            const outputPath = path.join(destinationDir, `${partName}.step`);
            fs.writeFileSync(outputPath, content);
            return {
                fileName: `${partName}.step`,
                downloaded: true,
                metadata,
            };
        } catch (error) {
            metadata.lastError = error.message;
        }
    }

    return {
        fileName: undefined,
        downloaded: false,
        metadata,
    };
}

async function addLcscPart(partNumber, options = {}) {
    const component = await fetchEasyEdaComponent(partNumber, options);
    const cPara = component.dataStr && component.dataStr.head && component.dataStr.head.c_para
        ? component.dataStr.head.c_para
        : {};
    const partName = sanitizeIdentifier(cPara["Manufacturer Part"] || component.title || partNumber, partNumber);
    const partsDir = options.partsDir
        ? path.resolve(options.partsDir)
        : path.resolve(options.cwd || process.cwd(), "parts");
    const destinationDir = path.join(partsDir, sanitizeFileName(partName, partNumber));

    fs.mkdirSync(destinationDir, { recursive: true });

    const model = await tryDownloadModel(component, destinationDir, partName, options);
    const projectRoot = path.resolve(options.cwd || process.cwd());
    const modelProjectDir = path.relative(projectRoot, destinationDir).replace(/\\/g, "/");
    const pins = inferPinGroups(uniquePinEntries(extractPinsFromEasyEdaSymbol(component.dataStr)));
    const info = componentInfo(component, {
        symbol: `./${partName}.kicad_sym`,
        footprint: `./${partName}.kicad_mod`,
        model: model.fileName ? `./${model.fileName}` : undefined,
    });
    const schrunePath = path.join(destinationDir, `${partName}.schrune`);
    const footprintData = component.packageDetail && component.packageDetail.dataStr || {};
    const bridged = runEasyeda2KicadBridge(partName, component, destinationDir, modelProjectDir, options);
    if (!bridged) {
        fs.writeFileSync(path.join(destinationDir, `${partName}.kicad_sym`), renderKiCadSymbol(partName, info, pins));
        fs.writeFileSync(path.join(destinationDir, `${partName}.kicad_mod`), renderKiCadFootprint(
            partName,
            footprintData,
            model.downloaded ? model.fileName : undefined,
            modelProjectDir
        ));
    }
    fs.writeFileSync(schrunePath, renderSchrunePart(partName, info, pins));

    return {
        partName,
        directory: destinationDir,
        schrunePath,
        pins,
        modelDownloaded: model.downloaded,
    };
}

module.exports = {
    addLcscPart,
    extractPinsFromEasyEdaSymbol,
    fetchEasyEdaComponent,
    isLikelyStepModel,
    modelDownloadCandidates,
    parseEasyEdaPads,
    parseEasyEdaGraphics,
    renderKiCadFootprint,
    renderKiCadSymbol,
    renderSchrunePart,
    runEasyeda2KicadBridge,
    sanitizeIdentifier,
};
