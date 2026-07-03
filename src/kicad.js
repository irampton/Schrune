const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildPathsForEntry } = require("./project");

const GRID_X = 50.8;
const GRID_Y = 38.1;
const START_X = 35.56;
const START_Y = 35.56;
const PIN_LABEL_STUB_LENGTH = 7.62;
const GROUPED_COMPONENT_SPACING_X = 50.8;
const GROUPED_COMPONENT_SPACING_Y = 15.24;
const KICAD_GENERATOR_VERSION = "10.0";
const KICAD_SCH_VERSION = 20260306;
const KICAD_PCB_VERSION = 20260206;
const FOOTPRINT_LIBRARY_NAME = "Schrune";

function componentKind(component) {
    return component.constructor && component.constructor.name || "Component";
}

function kicadString(value) {
    return JSON.stringify(String(value ?? ""));
}

function kicadId(seed) {
    const hex = crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function walkFiles(dir, predicate, matches = []) {
    if (!fs.existsSync(dir)) {
        return matches;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(entryPath, predicate, matches);
        } else if (entry.isFile() && predicate(entryPath)) {
            matches.push(entryPath);
        }
    }

    return matches;
}

function candidateAssetNames(component, extension, infoKey) {
    const info = component.info || {};
    const selected = component.selectedPart || {};
    const names = new Set();

    if (info[infoKey] && path.basename(info[infoKey]) !== ".") {
        names.add(path.basename(info[infoKey]));
    }

    for (const value of [info.partNumber, selected.mpn, selected.partName, componentKind(component)]) {
        if (value) {
            names.add(`${sanitizeIdentifier(value)}${extension}`);
        }
    }

    return [...names];
}

function resolveAsset(filePath, component, extension, infoKey) {
    const sourceDir = path.dirname(filePath);
    const info = component.info || {};
    const direct = info[infoKey] && path.resolve(sourceDir, info[infoKey]);
    if (direct && fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return direct;
    }

    const partDirDirect = info[infoKey] && path.resolve(sourceDir, "parts", componentKind(component), info[infoKey]);
    if (partDirDirect && fs.existsSync(partDirDirect) && fs.statSync(partDirDirect).isFile()) {
        return partDirDirect;
    }

    const candidateNames = new Set(candidateAssetNames(component, extension, infoKey));
    const matches = walkFiles(path.join(sourceDir, "parts"), (entryPath) => {
        return path.extname(entryPath) === extension && candidateNames.has(path.basename(entryPath));
    });

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new Error(`${component.designator} has ambiguous ${extension} assets: ${matches.join(", ")}`);
    }

    throw new Error(`${component.designator} is missing a ${extension} asset`);
}

function flattenPins(value, pins = [], seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
        return pins;
    }

    if (value.pad !== undefined && value.name !== undefined) {
        seen.add(value);
        pins.push(value);
        return pins;
    }

    seen.add(value);

    if (Array.isArray(value)) {
        for (const entry of value) {
            flattenPins(entry, pins, seen);
        }
    }

    if (Array.isArray(value.group)) {
        flattenPins(value.group, pins, seen);
        return pins;
    }

    for (const key of Object.keys(value)) {
        if (key.startsWith("__")) {
            continue;
        }
        const child = value[key];
        if (child && typeof child === "object") {
            flattenPins(child, pins, seen);
        }
    }

    return pins;
}

function physicalPadNumber(component, pin, index) {
    const kind = componentKind(component);
    if (["Resistor", "Capacitor", "Inductor", "Diode"].includes(kind) && (pin.pad === 0 || pin.pad === 1)) {
        return String(index + 1);
    }

    return String(pin.pad);
}

function findMatching(source, openIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = openIndex; i < source.length; i++) {
        const char = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
        } else if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    throw new Error("Unbalanced KiCad S-expression");
}

function readExpressionName(source, openIndex) {
    let index = openIndex + 1;
    while (index < source.length && /\s/.test(source[index])) {
        index++;
    }

    let name = "";
    while (index < source.length) {
        const char = source[index];
        if (/\s|\(|\)/.test(char)) {
            break;
        }
        name += char;
        index++;
    }

    return name;
}

function findChildExpression(source, parentOpenIndex, childName) {
    const parentCloseIndex = findMatching(source, parentOpenIndex);
    let inString = false;
    let escaped = false;

    for (let i = parentOpenIndex + 1; i < parentCloseIndex; i++) {
        const char = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "(") {
            const name = readExpressionName(source, i);
            if (name === childName) {
                return {
                    openIndex: i,
                    closeIndex: findMatching(source, i),
                };
            }
            i = findMatching(source, i);
        }
    }

    return undefined;
}

function extractSymbol(symbolText) {
    const libraryOpenIndex = symbolText.indexOf("(kicad_symbol_lib");
    if (libraryOpenIndex !== -1) {
        const symbolBlock = findChildExpression(symbolText, libraryOpenIndex, "symbol");
        if (!symbolBlock) {
            throw new Error("KiCad symbol file does not contain a symbol");
        }

        const nameMatch = symbolText.slice(symbolBlock.openIndex, symbolBlock.closeIndex + 1)
            .match(/^\(symbol\s+"([^"]+)"/);
        if (!nameMatch) {
            throw new Error("KiCad symbol file does not contain a symbol");
        }

        return {
            name: nameMatch[1],
            source: symbolText.slice(symbolBlock.openIndex, symbolBlock.closeIndex + 1),
        };
    }

    const openIndex = symbolText.indexOf("(symbol");
    if (openIndex === -1) {
        throw new Error("KiCad symbol file does not contain a symbol");
    }

    const closeIndex = findMatching(symbolText, openIndex);
    const nameMatch = symbolText.slice(openIndex, closeIndex + 1).match(/^\(symbol\s+"([^"]+)"/);
    if (!nameMatch) {
        throw new Error("KiCad symbol file does not contain a symbol");
    }
    return {
        name: nameMatch[1],
        source: symbolText.slice(openIndex, closeIndex + 1),
    };
}

function extractFootprintName(footprintText) {
    const trimmed = footprintText.trim();
    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    const nameMatch = firstLine.match(/^\(footprint\s+"([^"]+)"/) || firstLine.match(/^\(module\s+([^\s)]+)/);
    if (!nameMatch) {
        throw new Error("KiCad footprint file does not contain a footprint");
    }

    return nameMatch[1];
}

function parseSymbolPins(symbolSource) {
    const pins = new Map();
    const pinPattern = /\(pin\b/g;
    let match;

    while ((match = pinPattern.exec(symbolSource)) !== null) {
        const closeIndex = findMatching(symbolSource, match.index);
        const pinSource = symbolSource.slice(match.index, closeIndex + 1);
        const at = pinSource.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/);
        const length = pinSource.match(/\(length\s+(-?\d+(?:\.\d+)?)\)/);
        const number = pinSource.match(/\(number\s+"([^"]+)"/);
        if (!at || !length || !number) {
            pinPattern.lastIndex = closeIndex + 1;
            continue;
        }

        pins.set(String(number[1]), {
            x: Number(at[1]),
            y: Number(at[2]),
            angle: Number(at[3]),
            length: Number(length[1]),
        });
        pinPattern.lastIndex = closeIndex + 1;
    }

    return pins;
}

function netNamesFor(compiled) {
    return [...compiled.netList].map(String).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function passiveNetPair(component) {
    const pins = flattenPins(component.pins).filter((pin) => pin.net);
    if (pins.length !== 2) {
        return undefined;
    }
    return pins.map((pin) => pin.net).sort().join("\0");
}

function componentPlacement(compiled) {
    const groups = new Map();
    const order = [];

    for (const component of compiled.components) {
        const pair = passiveNetPair(component);
        const moduleName = component.__schrune && component.__schrune.moduleName || "";
        const moduleKey = moduleName || "__top__";
        const key = pair && /^[RCLD]/.test(component.designator)
            ? `module:${moduleKey}:passive:${pair}`
            : `module:${moduleKey}:component:${component.designator}`;
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key).push(component);
    }

    const placements = new Map();
    order.forEach((key, index) => {
        const column = index % 4;
        const row = Math.floor(index / 4);
        const x = START_X + column * GRID_X;
        const y = START_Y + row * GRID_Y;
        groups.get(key).forEach((component, offset) => {
            placements.set(component, {
                x: x + (offset % 3) * GROUPED_COMPONENT_SPACING_X,
                y: y + Math.floor(offset / 3) * GROUPED_COMPONENT_SPACING_Y,
                rotation: 0,
            });
        });
    });

    return placements;
}

function renderLibSymbols(symbols) {
    const rendered = [...symbols.values()].map((symbol) => {
        return hideLibrarySymbolDisplayProperties(symbol.source).split("\n").map((line) => `    ${line}`).join("\n");
    });
    return `  (lib_symbols\n${rendered.join("\n")}\n  )`;
}

function propertyKey(propertySource) {
    const match = propertySource.match(/^\(property\s+"([^"]+)"/)
        || propertySource.match(/^\(property\s*\n\s+"([^"]+)"/);
    return match && match[1];
}

function normalizePropertyHide(propertySource) {
    const effectsIndex = propertySource.indexOf("(effects");
    if (effectsIndex === -1) {
        return propertySource;
    }

    const effectsEnd = findMatching(propertySource, effectsIndex);
    const effectsSource = propertySource.slice(effectsIndex, effectsEnd + 1);
    const hidden = /\(hide\s+yes\)|\shide(?:\s|\))/.test(effectsSource)
        || /\(hide\s+yes\)/.test(propertySource);
    const normalizedEffectsSource = effectsSource
        .replace(/\s+\(hide\s+yes\)/g, "")
        .replace(/\shide(?=\s|\))/g, "");
    const withoutEffectsHide = propertySource.slice(0, effectsIndex)
        + normalizedEffectsSource
        + propertySource.slice(effectsEnd + 1);

    if (!hidden || /\(hide\s+yes\)/.test(withoutEffectsHide)) {
        return withoutEffectsHide;
    }

    const nextEffectsIndex = withoutEffectsHide.indexOf("(effects");
    return `${withoutEffectsHide.slice(0, nextEffectsIndex)}(hide yes) ${withoutEffectsHide.slice(nextEffectsIndex)}`;
}

function hidePropertyEffects(propertySource) {
    const normalizedPropertySource = normalizePropertyHide(propertySource);
    const effectsIndex = normalizedPropertySource.indexOf("(effects");
    if (effectsIndex === -1) {
        return normalizedPropertySource;
    }

    if (/\(hide\s+yes\)/.test(normalizedPropertySource)) {
        return normalizedPropertySource;
    }

    return `${normalizedPropertySource.slice(0, effectsIndex)}(hide yes) ${normalizedPropertySource.slice(effectsIndex)}`;
}

function hideLibrarySymbolDisplayProperties(source) {
    let output = "";
    let cursor = 0;
    const propertyPattern = /\(property\b/g;
    let match;

    while ((match = propertyPattern.exec(source)) !== null) {
        const openIndex = match.index;
        const closeIndex = findMatching(source, openIndex);
        const propertySource = source.slice(openIndex, closeIndex + 1);
        const key = propertyKey(propertySource);
        const nextPropertySource = key === "Reference" || key === "Value"
            ? hidePropertyEffects(propertySource)
            : normalizePropertyHide(propertySource);

        output += source.slice(cursor, openIndex);
        output += nextPropertySource;
        cursor = closeIndex + 1;
        propertyPattern.lastIndex = closeIndex + 1;
    }

    return output + source.slice(cursor);
}

function pinEnd(placement, pin) {
    const angle = pin.angle === 90 ? 270 : pin.angle === 270 ? 90 : pin.angle;
    return {
        x: placement.x + pin.x,
        y: placement.y - pin.y,
        angle,
    };
}

function labelTextPoint(point, pin) {
    const stubLength = pin.stubLength || PIN_LABEL_STUB_LENGTH;
    if (pin.angle === 0) {
        return { x: point.x - stubLength, y: point.y };
    }
    if (pin.angle === 180) {
        return { x: point.x + stubLength, y: point.y };
    }
    if (pin.angle === 90) {
        return { x: point.x, y: point.y - stubLength };
    }
    return {
        x: point.x,
        y: point.y + stubLength,
    };
}

function labelEnd(point, pin) {
    return labelTextPoint(point, pin);
}

function labelAngle(pin) {
    if (pin.angle === 90 || pin.angle === 270) {
        return 90;
    }
    return pin.angle === 0 ? 180 : 0;
}

function labelJustify(pin) {
    if (pin.angle === 0 || pin.angle === 90) {
        return "right";
    }
    return "left";
}

function renderSchematicProperty(_projectName, _component, name, value, x, y, options = {}) {
    const hidden = options.hide ? " (hide yes)" : "";
    return [
        `    (property ${kicadString(name)} ${kicadString(value)} (at ${x.toFixed(2)} ${y.toFixed(2)} 0)${hidden}`,
        `      (effects (font (size 1.27 1.27)))`,
        `    )`,
    ].join("\n");
}

function renderSchematicSymbol(component, symbol, placement, projectName) {
    const pinLines = [...symbol.pins.keys()]
        .map((pinNumber) => {
            const pin = symbol.pins.get(pinNumber);
            const geometry = `${pin.x}:${pin.y}:${pin.angle}:${pin.length}`;
            return `    (pin ${kicadString(pinNumber)} (uuid ${kicadId(`${projectName}:sch:${component.designator}:pin:${pinNumber}:${geometry}`)}))`;
        });
    const symbolGeometry = [...symbol.pins.entries()]
        .map(([pinNumber, pin]) => `${pinNumber}:${pin.x}:${pin.y}:${pin.angle}:${pin.length}`)
        .join("|");
    const symbolInstanceSeed = `${projectName}:sch:${component.designator}:${symbol.name}:${placement.x}:${placement.y}:${placement.rotation}:${symbolGeometry}`;
    const dnp = component.place === false;
    return [
        `  (symbol (lib_id ${kicadString(symbol.name)}) (at ${placement.x.toFixed(2)} ${placement.y.toFixed(2)} ${placement.rotation}) (unit 1)`,
        `    (in_bom ${dnp ? "no" : "yes"}) (on_board yes) (dnp ${dnp ? "yes" : "no"})`,
        `    (uuid ${kicadId(symbolInstanceSeed)})`,
        renderSchematicProperty(projectName, component, "Reference", component.designator, placement.x, placement.y - 5.08),
        renderSchematicProperty(projectName, component, "Value", component.value || component.info.partNumber || componentKind(component), placement.x, placement.y + 5.08),
        renderSchematicProperty(projectName, component, "Footprint", `${FOOTPRINT_LIBRARY_NAME}:${symbol.footprintName}`, placement.x, placement.y + 7.62, { hide: true }),
        ...pinLines,
        `    (instances`,
        `      (project ${kicadString(projectName)}`,
        `        (path "/"`,
        `          (reference ${kicadString(component.designator)})`,
        `          (unit 1)`,
        `        )`,
        `      )`,
        `    )`,
        `  )`,
    ].join("\n");
}

function renderNetConnection(projectName, component, netName, point, pin, options = {}) {
    const end = labelEnd(point, pin);
    const seed = `${projectName}:${component.designator}:${pin.number}:${netName}:${point.x}:${point.y}:${end.x}:${end.y}`;
    const labelToken = options.globalLabels ? "global_label" : "label";
    const labelShape = labelToken === "global_label" ? " (shape input)" : "";
    return [
        `  (wire (pts (xy ${point.x.toFixed(2)} ${point.y.toFixed(2)}) (xy ${end.x.toFixed(2)} ${end.y.toFixed(2)}))`,
        `    (stroke (width 0) (type default))`,
        `    (uuid ${kicadId(`${seed}:wire`)})`,
        `  )`,
        `  (${labelToken} ${kicadString(netName)}${labelShape} (at ${end.x.toFixed(2)} ${end.y.toFixed(2)} ${labelAngle(pin)})`,
        `    (effects (font (size 1.27 1.27)))`,
        `    (uuid ${kicadId(`${seed}:label`)})`,
        `  )`,
    ].join("\n");
}

function renderSheetEntry(projectName, sheetName, sheetFile, x, y) {
    return [
        `  (sheet (at ${x.toFixed(2)} ${y.toFixed(2)}) (size 30.48 15.24)`,
        `    (stroke (width 0.1524) (type solid))`,
        `    (fill (color 0 0 0 0.0000))`,
        `    (uuid ${kicadId(`${projectName}:sheet:${sheetName}`)})`,
        `    (property "Sheetname" ${kicadString(sheetName)} (at ${x.toFixed(2)} ${(y - 1.27).toFixed(2)} 0)`,
        `      (effects (font (size 1.27 1.27)) (justify left bottom))`,
        `    )`,
        `    (property "Sheetfile" ${kicadString(sheetFile)} (at ${x.toFixed(2)} ${(y + 16.51).toFixed(2)} 0)`,
        `      (effects (font (size 1.27 1.27)) (justify left top))`,
        `    )`,
        `  )`,
    ].join("\n");
}

function renderSchematic(filePath, compiled, assets, placements, options = {}) {
    const projectName = options.projectName || path.basename(filePath, ".schrune");
    const symbols = new Map();
    const instances = [];
    const connections = [];
    const sheetEntries = options.sheetEntries || [];

    for (const component of compiled.components) {
        const asset = assets.get(component);
        symbols.set(asset.name, asset);
        const placement = placements.get(component);
        instances.push(renderSchematicSymbol(component, asset, placement, projectName));

        const symbolPins = asset.pins;
        const fanoutLengths = new Map();
        const groupedPins = new Map();
        for (const [padNumber, symbolPin] of symbolPins.entries()) {
            const point = pinEnd(placement, symbolPin);
            const side = String(point.angle);
            if (!groupedPins.has(side)) {
                groupedPins.set(side, []);
            }
            groupedPins.get(side).push({
                padNumber,
                point,
            });
        }
        for (const [side, sidePins] of groupedPins.entries()) {
            sidePins.sort((left, right) => {
                if (side === "0" || side === "180") {
                    return left.point.y - right.point.y;
                }
                return left.point.x - right.point.x;
            });
            sidePins.forEach((entry, index) => {
                fanoutLengths.set(entry.padNumber, PIN_LABEL_STUB_LENGTH + (index * 2.54));
            });
        }

        for (const [index, pin] of flattenPins(component.pins).entries()) {
            if (!pin.net) {
                continue;
            }
            const padNumber = physicalPadNumber(component, pin, index);
            const symbolPin = symbolPins.get(padNumber);
            if (!symbolPin) {
                continue;
            }
            const point = pinEnd(placement, symbolPin);
            connections.push(renderNetConnection(projectName, component, pin.net, point, {
                ...point,
                length: symbolPin.length,
                number: padNumber,
                stubLength: fanoutLengths.get(padNumber),
            }, options));
        }
    }

    return [
        `(kicad_sch (version ${KICAD_SCH_VERSION}) (generator "Schrune") (generator_version "${KICAD_GENERATOR_VERSION}")`,
        `  (uuid ${kicadId(`${projectName}:sheet`)})`,
        `  (paper "A4")`,
        renderLibSymbols(symbols),
        ...instances,
        ...connections,
        ...sheetEntries,
        `  (sheet_instances`,
        `    (path "/"`,
        `      (page "1")`,
        `    )`,
        `  )`,
        `)`,
        "",
    ].join("\n");
}

function transformFootprintForBoard(component, asset, placement, netNumbers, projectName) {
    const raw = fs.readFileSync(asset.footprintPath, "utf8").trim();
    extractFootprintName(raw);

    const valueText = component.value || component.info.partNumber || componentKind(component);
    const openEnd = raw.indexOf("\n");
    let body = openEnd === -1 ? "" : raw.slice(openEnd + 1, -1).trimEnd();
    body = replaceFootprintText(body, "reference", component.designator);
    body = replaceFootprintText(body, "value", valueText);
    body = convertLegacyFootprintArcs(body);

    const pinNetByPad = new Map(flattenPins(component.pins).map((pin, index) => [physicalPadNumber(component, pin, index), pin.net]));
    body = addPadNets(body, pinNetByPad, netNumbers);
    if (component.place === false && !/\(attr\b[^)]*\bdnp\b/.test(body)) {
        body = `  (attr dnp)\n${body}`;
    }

    const indentedBody = body.split("\n").map((line) => `    ${line}`).join("\n");
    return [
        `  (footprint ${kicadString(`${FOOTPRINT_LIBRARY_NAME}:${asset.footprintName}`)} (layer "F.Cu")`,
        `    (uuid ${kicadId(`${projectName}:pcb:${component.designator}`)})`,
        `    (at ${(placement.x * 1.25).toFixed(2)} ${(placement.y * 1.25).toFixed(2)} 0)`,
        `    (property "Reference" ${kicadString(component.designator)})`,
        `    (property "Value" ${kicadString(valueText)})`,
        indentedBody,
        `  )`,
    ].join("\n");
}

function renderFootprintLibraryTable() {
    return [
        `(fp_lib_table`,
        `  (lib (name ${kicadString(FOOTPRINT_LIBRARY_NAME)})`,
        `    (type "KiCad")`,
        `    (uri "\${KIPRJMOD}/${FOOTPRINT_LIBRARY_NAME}.pretty")`,
        `    (options "")`,
        `    (descr "Project-local Schrune footprint library")`,
        `  )`,
        `)`,
        "",
    ].join("\n");
}

function writeFootprintLibrary(outputDir, assets) {
    const libraryDir = path.join(outputDir, `${FOOTPRINT_LIBRARY_NAME}.pretty`);
    fs.rmSync(libraryDir, { recursive: true, force: true });
    fs.mkdirSync(libraryDir, { recursive: true });

    const written = new Map();
    for (const asset of assets.values()) {
        const targetPath = path.join(libraryDir, `${asset.footprintName}.kicad_mod`);
        const source = fs.readFileSync(asset.footprintPath, "utf8");
        const existing = written.get(targetPath);
        if (existing !== undefined && existing !== source) {
            throw new Error(`Conflicting footprint library entry "${asset.footprintName}"`);
        }
        fs.writeFileSync(targetPath, source);
        written.set(targetPath, source);
    }

    return libraryDir;
}

function replaceFootprintText(source, type, text) {
    const pattern = new RegExp(`\\(fp_text\\s+${type}\\s+(?:"[^"]*"|[^\\s)]+)`);
    if (pattern.test(source)) {
        return source.replace(pattern, `(fp_text ${type} ${kicadString(text)}`);
    }

    const y = type === "reference" ? -2 : 2;
    return [
        `(fp_text ${type} ${kicadString(text)} (at 0 ${y} 0) (layer "F.SilkS")`,
        `  (effects (font (size 1 1) (thickness 0.15)))`,
        `)`,
        source,
    ].join("\n");
}

function rotatePoint(point, center, degrees) {
    const radians = degrees * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + (dx * cos) - (dy * sin),
        y: center.y + (dx * sin) + (dy * cos),
    };
}

function formatPcbNumber(value) {
    return Object.is(value, -0) ? "0.00" : value.toFixed(2);
}

function convertLegacyFootprintArcs(source) {
    return source.replace(
        /\(fp_arc\s+\(start\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)\s+\(end\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)\s+\(angle\s+(-?\d+(?:\.\d+)?)\)/g,
        (_match, centerX, centerY, startX, startY, angle) => {
            const center = { x: Number(centerX), y: Number(centerY) };
            const start = { x: Number(startX), y: Number(startY) };
            const mid = rotatePoint(start, center, Number(angle) / 2);
            const end = rotatePoint(start, center, Number(angle));

            return `(fp_arc (start ${formatPcbNumber(start.x)} ${formatPcbNumber(start.y)}) ` +
                `(mid ${formatPcbNumber(mid.x)} ${formatPcbNumber(mid.y)}) ` +
                `(end ${formatPcbNumber(end.x)} ${formatPcbNumber(end.y)})`;
        }
    );
}

function addPadNets(source, pinNetByPad, netNumbers) {
    let output = "";
    let cursor = 0;
    const padPattern = /\(pad\s+(?:"([^"]+)"|([^\s)]+))/g;
    let match;

    while ((match = padPattern.exec(source)) !== null) {
        const openIndex = match.index;
        const closeIndex = findMatching(source, openIndex);
        const padSource = source.slice(openIndex, closeIndex + 1);
        const netName = pinNetByPad.get(String(match[1] || match[2]));
        let nextPadSource = padSource;
        if (netName) {
            const nextNetSource = `(net ${netNumbers.get(netName)} ${kicadString(netName)})`;
            if (/\(net\s+\d+\s+"[^"]*"\)/.test(nextPadSource)) {
                nextPadSource = nextPadSource.replace(/\(net\s+\d+\s+"[^"]*"\)/, nextNetSource);
            } else {
                nextPadSource = `${nextPadSource.slice(0, -1)} ${nextNetSource})`;
            }
        }

        output += source.slice(cursor, openIndex);
        output += nextPadSource;
        cursor = closeIndex + 1;
        padPattern.lastIndex = closeIndex + 1;
    }

    return output + source.slice(cursor);
}

function renderPcb(filePath, compiled, assets, placements, options = {}) {
    const projectName = options.projectName || path.basename(filePath, ".schrune");
    const netNames = netNamesFor(compiled);
    const netNumbers = new Map(netNames.map((netName, index) => [netName, index + 1]));
    const footprints = compiled.components.map((component) => {
        const placement = placements.get(component);
        return transformFootprintForBoard(component, assets.get(component), placement, netNumbers, projectName);
    });

    return [
        `(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator "Schrune") (generator_version "${KICAD_GENERATOR_VERSION}")`,
        `  (general`,
        `    (thickness 1.6)`,
        `  )`,
        `  (paper "A4")`,
        `  (layers`,
        `    (0 "F.Cu" signal)`,
        `    (31 "B.Cu" signal)`,
        `    (32 "B.Adhes" user "B.Adhesive")`,
        `    (33 "F.Adhes" user "F.Adhesive")`,
        `    (34 "B.Paste" user)`,
        `    (35 "F.Paste" user)`,
        `    (36 "B.SilkS" user "B.Silkscreen")`,
        `    (37 "F.SilkS" user "F.Silkscreen")`,
        `    (38 "B.Mask" user)`,
        `    (39 "F.Mask" user)`,
        `    (44 "Edge.Cuts" user)`,
        `    (45 "Margin" user)`,
        `    (46 "B.CrtYd" user "B.Courtyard")`,
        `    (47 "F.CrtYd" user "F.Courtyard")`,
        `    (48 "B.Fab" user)`,
        `    (49 "F.Fab" user)`,
        `  )`,
        `  (net 0 "")`,
        ...netNames.map((netName) => `  (net ${netNumbers.get(netName)} ${kicadString(netName)})`),
        ...footprints,
        `)`,
        "",
    ].join("\n");
}

function findChildExpressions(source, parentOpenIndex, childName) {
    const parentCloseIndex = findMatching(source, parentOpenIndex);
    const matches = [];
    let inString = false;
    let escaped = false;

    for (let i = parentOpenIndex + 1; i < parentCloseIndex; i++) {
        const char = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "(") {
            const name = readExpressionName(source, i);
            const closeIndex = findMatching(source, i);
            if (!childName || name === childName) {
                matches.push({
                    openIndex: i,
                    closeIndex,
                    source: source.slice(i, closeIndex + 1),
                });
            }
            i = closeIndex;
        }
    }

    return matches;
}

function replaceExpressionRange(source, expressions, replacement) {
    if (!expressions.length) {
        return source;
    }

    const start = expressions[0].openIndex;
    const end = expressions[expressions.length - 1].closeIndex + 1;
    return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function parsePcbNetMap(pcbSource) {
    const rootOpenIndex = pcbSource.indexOf("(kicad_pcb");
    if (rootOpenIndex === -1) {
        return new Map();
    }

    const nets = new Map();
    for (const expression of findChildExpressions(pcbSource, rootOpenIndex, "net")) {
        const match = expression.source.match(/^\(net\s+(\d+)\s+"([^"]*)"\)$/);
        if (match) {
            nets.set(Number(match[1]), match[2]);
        }
    }
    return nets;
}

function footprintReference(footprintSource) {
    const propertyMatch = footprintSource.match(/\(property\s+"Reference"\s+"([^"]+)"/);
    if (propertyMatch) {
        return propertyMatch[1];
    }

    const textMatch = footprintSource.match(/\(fp_text\s+reference\s+"([^"]+)"/);
    return textMatch && textMatch[1];
}

function footprintMap(pcbSource) {
    const rootOpenIndex = pcbSource.indexOf("(kicad_pcb");
    if (rootOpenIndex === -1) {
        return new Map();
    }

    const footprints = new Map();
    for (const expression of findChildExpressions(pcbSource, rootOpenIndex, "footprint")) {
        const reference = footprintReference(expression.source);
        if (reference) {
            footprints.set(reference, expression.source);
        }
    }
    return footprints;
}

function preserveFootprintPlacement(nextFootprint, previousFootprint) {
    if (!previousFootprint) {
        return nextFootprint;
    }

    let output = nextFootprint;
    const previousAt = previousFootprint.match(/\n(\s*)\(at\s+([^)]+)\)/);
    if (previousAt) {
        output = output.replace(/\n(\s*)\(at\s+[^)]+\)/, `\n$1(at ${previousAt[2]})`);
    }

    const previousLayer = previousFootprint.match(/^\s*\(footprint\s+"[^"]+"\s+\(layer\s+"([^"]+)"\)/);
    if (previousLayer) {
        output = output.replace(/^(\s*\(footprint\s+"[^"]+"\s+\(layer\s+)"[^"]+"(\))/, `$1"${previousLayer[1]}"$2`);
    }

    return output;
}

function remapPcbItemNetNumbers(pcbSource, previousNetNumbers, nextNetNumbers) {
    return pcbSource.replace(/\(net\s+(\d+)\)/g, (match, numberText) => {
        const previousName = previousNetNumbers.get(Number(numberText));
        if (!previousName) {
            return match;
        }

        return `(net ${nextNetNumbers.get(previousName) || 0})`;
    });
}

function insertBeforeRootClose(source, replacement) {
    const rootOpenIndex = source.indexOf("(kicad_pcb");
    if (rootOpenIndex === -1) {
        return source;
    }

    const rootCloseIndex = findMatching(source, rootOpenIndex);
    return `${source.slice(0, rootCloseIndex).trimEnd()}\n${replacement}\n${source.slice(rootCloseIndex)}`;
}

function refreshExistingPcb(existingPcb, nextPcb) {
    const existingRootOpenIndex = existingPcb.indexOf("(kicad_pcb");
    const nextRootOpenIndex = nextPcb.indexOf("(kicad_pcb");
    if (existingRootOpenIndex === -1 || nextRootOpenIndex === -1) {
        return nextPcb;
    }

    const nextNetExpressions = findChildExpressions(nextPcb, nextRootOpenIndex, "net");
    const nextFootprintExpressions = findChildExpressions(nextPcb, nextRootOpenIndex, "footprint");
    const nextNetNumbersByName = new Map([...parsePcbNetMap(nextPcb)].map(([number, name]) => [name, number]));
    const previousNetNumbers = parsePcbNetMap(existingPcb);
    const previousFootprints = footprintMap(existingPcb);

    let refreshed = remapPcbItemNetNumbers(existingPcb, previousNetNumbers, nextNetNumbersByName);
    const refreshedRootOpenIndex = refreshed.indexOf("(kicad_pcb");
    const existingNetExpressions = findChildExpressions(refreshed, refreshedRootOpenIndex, "net");
    const nextNetBlock = nextNetExpressions.map((expression) => `  ${expression.source}`).join("\n");
    refreshed = existingNetExpressions.length
        ? replaceExpressionRange(refreshed, existingNetExpressions, nextNetBlock)
        : insertBeforeRootClose(refreshed, nextNetBlock);

    const refreshedRootAfterNets = refreshed.indexOf("(kicad_pcb");
    const existingFootprintExpressions = findChildExpressions(refreshed, refreshedRootAfterNets, "footprint");
    const nextFootprintBlock = nextFootprintExpressions
        .map((expression) => {
            const reference = footprintReference(expression.source);
            return preserveFootprintPlacement(expression.source, previousFootprints.get(reference));
        })
        .join("\n");

    return existingFootprintExpressions.length
        ? replaceExpressionRange(refreshed, existingFootprintExpressions, nextFootprintBlock)
        : insertBeforeRootClose(refreshed, nextFootprintBlock);
}

function renderProject(projectName) {
    return `${JSON.stringify({
        board: {
            design_settings: {
                defaults: {},
            },
        },
        boards: [{
            filename: `${projectName}.kicad_pcb`,
            name: projectName,
            uuid: "00000000-0000-0000-0000-000000000000",
        }],
        meta: {
            filename: `${projectName}.kicad_pro`,
            version: 1,
        },
        net_settings: {
            classes: [],
        },
        schematic: {
            annotate_start_num: 0,
            bom_export_filename: "${PROJECTNAME}.csv",
            meta: {
                version: 1,
            },
            page_layout_descr_file: "",
            plot_directory: "",
            reuse_designators: true,
            subpart_first_id: 65,
            subpart_id_separator: 0,
            top_level_sheets: [{
                filename: `${projectName}.kicad_sch`,
                name: projectName,
                uuid: "00000000-0000-0000-0000-000000000000",
            }],
            used_designators: "",
            variants: [],
        },
    }, null, 2)}\n`;
}

function collectAssets(filePath, compiled) {
    const assets = new Map();

    for (const component of compiled.components) {
        const symbolPath = resolveAsset(filePath, component, ".kicad_sym", "symbol");
        const footprintPath = resolveAsset(filePath, component, ".kicad_mod", "footprint");
        const extracted = extractSymbol(fs.readFileSync(symbolPath, "utf8"));
        assets.set(component, {
            ...extracted,
            footprintName: path.basename(footprintPath, ".kicad_mod"),
            symbolPath,
            footprintPath,
            pins: parseSymbolPins(extracted.source),
        });
    }

    return assets;
}

function writeKiCadFiles(filePath, compiled, options = {}) {
    const projectName = options.projectName || path.basename(filePath, ".schrune");
    const outputPaths = buildPathsForEntry(filePath, projectName);
    const outputDir = outputPaths.buildDir;
    const projectPath = outputPaths.kicadProjectPath;
    const schematicPath = outputPaths.schematicPath;
    const pcbPath = outputPaths.pcbPath;
    const assets = collectAssets(filePath, compiled);
    const schematicPlacements = componentPlacement(compiled);
    const moduleGroups = new Map();
    for (const component of compiled.components) {
        const moduleName = component.__schrune && component.__schrune.moduleName;
        if (moduleName) {
            if (!moduleGroups.has(moduleName)) {
                moduleGroups.set(moduleName, []);
            }
            moduleGroups.get(moduleName).push(component);
        }
    }
    const hasModuleSheets = moduleGroups.size > 0;
    const rootComponents = hasModuleSheets
        ? compiled.components.filter((component) => !(component.__schrune && component.__schrune.moduleName))
        : compiled.components;
    const sheetEntries = [...moduleGroups.keys()].map((moduleName, index) => ({
        name: moduleName,
        file: `${projectName}_${sanitizeIdentifier(moduleName)}.kicad_sch`,
        x: START_X,
        y: START_Y + index * 22.86,
    }));
    const moduleSchematicPaths = {};
    const footprintLibraryPath = writeFootprintLibrary(outputDir, assets);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(projectPath, renderProject(projectName));
    fs.writeFileSync(path.join(outputDir, "fp-lib-table"), renderFootprintLibraryTable());
    fs.writeFileSync(schematicPath, renderSchematic(
        filePath,
        { ...compiled, components: rootComponents },
        assets,
        schematicPlacements,
        {
            globalLabels: hasModuleSheets,
            projectName,
            sheetEntries: sheetEntries.map((entry) => renderSheetEntry(projectName, entry.name, entry.file, entry.x, entry.y)),
        }
    ));

    for (const entry of sheetEntries) {
        const moduleComponents = moduleGroups.get(entry.name);
        const modulePath = path.join(outputDir, entry.file);
        fs.writeFileSync(modulePath, renderSchematic(
            filePath,
            { ...compiled, components: moduleComponents },
            assets,
            schematicPlacements,
            { globalLabels: true, projectName }
        ));
        moduleSchematicPaths[entry.name] = modulePath;
    }

    const nextPcb = renderPcb(filePath, compiled, assets, componentPlacement(compiled), { projectName });
    const pcbSource = fs.existsSync(pcbPath)
        ? refreshExistingPcb(fs.readFileSync(pcbPath, "utf8"), nextPcb)
        : nextPcb;
    fs.writeFileSync(pcbPath, pcbSource);

    return {
        ...compiled,
        kicadDir: outputDir,
        kicadProjectPath: projectPath,
        schematicPath,
        footprintLibraryPath,
        moduleSchematicPaths,
        pcbPath,
    };
}

module.exports = {
    collectAssets,
    componentPlacement,
    flattenPins,
    renderPcb,
    renderSchematic,
    writeKiCadFiles,
};
