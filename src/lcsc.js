const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { commentFields } = require("./part-comment");
const { BUILD_DIR_NAME } = require("./project");

const EASYEDA_COMPONENT_API = "https://easyeda.com/api/products";

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

function componentInfo(component, assets, selectedPart) {
    const cPara = component.dataStr && component.dataStr.head && component.dataStr.head.c_para
        ? component.dataStr.head.c_para
        : {};
    const kind = selectedPart && selectedPart.kind;
    const generatedInfo = kind ? commentFields(kind, selectedPart) : {};

    return {
        partNumber: cPara["Manufacturer Part"] || cPara.name || component.title,
        manufacture: cPara.Manufacturer || cPara.Supplier || "Unknown",
        footprint: assets.footprint,
        package: selectedPart && selectedPart.package || cPara.package,
        symbol: assets.symbol,
        model: assets.model,
        LCSC: component.lcsc && component.lcsc.number || component.szlcsc && component.szlcsc.number,
        designatorPrefix: cPara.pre ? String(cPara.pre).replace(/\?$/, "") : "U",
        ...generatedInfo,
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

function mergeInfoIntoSchruneSource(source, info) {
    const infoMatch = source.match(/info\s*:\s*\{([\s\S]*?)\n(\s*)\}/);
    if (!infoMatch) {
        return source;
    }

    const originalBody = infoMatch[1];
    const closingIndent = infoMatch[2];
    const existing = new Map();
    const fieldPattern = /(^|\n)(\s*)([A-Za-z_]\w*)\s*:\s*("[^"]*"|'[^']*'|[^,\n]+)\s*,?/g;
    let match;

    while ((match = fieldPattern.exec(originalBody)) !== null) {
        existing.set(match[3], {
            indent: match[2],
            rawValue: match[4].trim(),
        });
    }

    for (const [key, value] of Object.entries(info)) {
        if (value === undefined) {
            continue;
        }
        existing.set(key, {
            indent: existing.get(key) ? existing.get(key).indent : `${closingIndent}    `,
            rawValue: jsString(value),
        });
    }

    const lines = [];
    for (const [key, entry] of existing.entries()) {
        lines.push(`${entry.indent}${key}: ${entry.rawValue},`);
    }
    const nextBlock = `info: {\n${lines.join("\n")}\n${closingIndent}}`;
    return source.replace(/info\s*:\s*\{[\s\S]*?\n\s*\}/, nextBlock);
}

function updateExistingSchruneFile(schrunePath, partName, info, pins) {
    if (!fs.existsSync(schrunePath)) {
        fs.writeFileSync(schrunePath, renderSchrunePart(partName, info, pins));
        return;
    }

    const current = fs.readFileSync(schrunePath, "utf8");
    fs.writeFileSync(schrunePath, mergeInfoIntoSchruneSource(current, info));
}

function normalizePythonCommand(command) {
    if (!command || typeof command !== "string") {
        return undefined;
    }

    return command.trim() || undefined;
}

function pythonCandidates(options = {}) {
    const candidates = [
        normalizePythonCommand(options.python),
        normalizePythonCommand(process.env.EASYEDA2KICAD_PYTHON),
        "python3",
        "python",
    ].filter(Boolean);

    return [...new Set(candidates)];
}

function pythonEnvironment(pythonPath) {
    const env = { ...process.env };
    if (pythonPath || process.env.PYTHONPATH) {
        env.PYTHONPATH = [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    return env;
}

function formatBridgeFailure(attempts) {
    const lines = [
        "easyeda2kicad is required to import LCSC parts.",
        "Run `schrune tools install-easyeda2kicad`, or configure a usable Python interpreter.",
    ];

    if (attempts.length) {
        lines.push(`Tried: ${attempts.join("; ")}`);
    }

    return lines.join(" ");
}

function runEasyeda2KicadBridge(partName, component, destinationDir, modelProjectDir, options = {}) {
    if (typeof options.bridgeRunner === "function") {
        return options.bridgeRunner(partName, component, destinationDir, modelProjectDir, options);
    }

    const pythonPath = options.easyeda2KicadPythonPath || process.env.EASYEDA2KICAD_PYTHONPATH;
    const bridgePath = path.resolve(__dirname, "..", "scripts", "easyeda2kicad_bridge.py");
    const inputPath = path.join(os.tmpdir(), `schrune-${partName}-${Date.now()}.easyeda.json`);
    fs.writeFileSync(inputPath, JSON.stringify(component));

    const attempts = [];
    const env = pythonEnvironment(pythonPath);
    const candidateList = pythonCandidates(options);

    try {
        for (const python of candidateList) {
            const result = spawnSync(python, [
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

            if (result.status === 0) {
                const stdout = String(result.stdout || "").trim();
                const lastLine = stdout.split(/\r?\n/).pop();
                return lastLine ? JSON.parse(lastLine) : {};
            }

            const reason = result.error
                ? result.error.code === "ENOENT"
                    ? `${python} not found`
                    : `${python} failed to start: ${result.error.message}`
                : `${python} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`;
            attempts.push(reason);
        }
    } finally {
        try {
            fs.unlinkSync(inputPath);
        } catch (_error) {
            // Best-effort cleanup only.
        }
    }

    throw new Error(formatBridgeFailure(attempts));
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

    const projectRoot = path.resolve(options.cwd || process.cwd());
    const kicadProjectRoot = path.join(projectRoot, BUILD_DIR_NAME);
    const modelProjectDir = path.relative(kicadProjectRoot, destinationDir).replace(/\\/g, "/");
    const pins = inferPinGroups(uniquePinEntries(extractPinsFromEasyEdaSymbol(component.dataStr)));
    const schrunePath = path.join(destinationDir, `${partName}.schrune`);
    const bridged = await runEasyeda2KicadBridge(partName, component, destinationDir, modelProjectDir, options);
    if (!bridged) {
        throw new Error("easyeda2kicad bridge did not complete successfully");
    }
    const info = componentInfo(component, {
        symbol: `./${partName}.kicad_sym`,
        footprint: `./${partName}.kicad_mod`,
        model: bridged.modelFile ? `./${bridged.modelFile}` : undefined,
    }, options.part);

    if (options.updateExistingSchrune) {
        updateExistingSchruneFile(schrunePath, partName, info, pins);
    } else {
        fs.writeFileSync(schrunePath, renderSchrunePart(partName, info, pins));
    }

    return {
        partName,
        directory: destinationDir,
        schrunePath,
        pins,
        lcsc: partNumber.toUpperCase(),
        modelDownloaded: Boolean(bridged.modelDownloaded),
    };
}

module.exports = {
    addLcscPart,
    extractPinsFromEasyEdaSymbol,
    fetchEasyEdaComponent,
    formatBridgeFailure,
    runEasyeda2KicadBridge,
    sanitizeIdentifier,
};
