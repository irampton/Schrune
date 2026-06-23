const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const GRID_X = 50.8;
const GRID_Y = 38.1;
const START_X = 35.56;
const START_Y = 35.56;
const PIN_LABEL_LENGTH = 5.08;
const KICAD_GENERATOR_VERSION = "10.0";
const KICAD_SCH_VERSION = 20260306;
const KICAD_PCB_VERSION = 20260206;

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

    for (const value of [info.partNumber, selected.mpn, componentKind(component)]) {
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
    if (!value) {
        return pins;
    }

    if (value.pad !== undefined && value.name !== undefined) {
        if (!seen.has(value)) {
            seen.add(value);
            pins.push(value);
        }
        return pins;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            flattenPins(entry, pins, seen);
        }
        return pins;
    }

    if (typeof value === "object") {
        if (Array.isArray(value.group)) {
            flattenPins(value.group, pins, seen);
            return pins;
        }

        for (const key of Object.keys(value)) {
            const child = value[key];
            if (child && typeof child === "object") {
                flattenPins(child, pins, seen);
            }
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
                x: x + (offset % 3) * 15.24,
                y: y + Math.floor(offset / 3) * 15.24,
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
    return {
        x: placement.x + pin.x,
        y: placement.y + pin.y,
    };
}

function labelEnd(point, pin) {
    if (pin.angle === 0) {
        return { x: point.x - PIN_LABEL_LENGTH, y: point.y };
    }
    if (pin.angle === 180) {
        return { x: point.x + PIN_LABEL_LENGTH, y: point.y };
    }
    if (pin.angle === 90) {
        return { x: point.x, y: point.y + PIN_LABEL_LENGTH };
    }
    return { x: point.x, y: point.y - PIN_LABEL_LENGTH };
}

function labelAngle(pin) {
    return pin.angle === 0 ? 180 : 0;
}

function labelPoint(start, end) {
    return {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
    };
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
    const footprintName = path.basename(symbol.footprintPath, ".kicad_mod");
    const pinLines = [...symbol.pins.keys()]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map((pinNumber) => `    (pin ${kicadString(pinNumber)} (uuid ${kicadId(`${projectName}:sch:${component.designator}:pin:${pinNumber}`)}))`);
    return [
        `  (symbol (lib_id ${kicadString(symbol.name)}) (at ${placement.x.toFixed(2)} ${placement.y.toFixed(2)} ${placement.rotation}) (unit 1)`,
        `    (in_bom yes) (on_board yes) (dnp no)`,
        `    (uuid ${kicadId(`${projectName}:sch:${component.designator}`)})`,
        renderSchematicProperty(projectName, component, "Reference", component.designator, placement.x, placement.y - 5.08),
        renderSchematicProperty(projectName, component, "Value", component.value || component.info.partNumber || componentKind(component), placement.x, placement.y + 5.08),
        renderSchematicProperty(projectName, component, "Footprint", `Schrune:${footprintName}`, placement.x, placement.y + 7.62, { hide: true }),
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
    const label = labelPoint(point, end);
    const seed = `${projectName}:${component.designator}:${pin.number}:${netName}`;
    const labelToken = options.globalLabels ? "global_label" : "label";
    const labelShape = labelToken === "global_label" ? " (shape input)" : "";
    return [
        `  (wire (pts (xy ${point.x.toFixed(2)} ${point.y.toFixed(2)}) (xy ${end.x.toFixed(2)} ${end.y.toFixed(2)}))`,
        `    (stroke (width 0) (type default))`,
        `    (uuid ${kicadId(`${seed}:wire`)})`,
        `  )`,
        `  (${labelToken} ${kicadString(netName)}${labelShape} (at ${label.x.toFixed(2)} ${label.y.toFixed(2)} ${labelAngle(pin)})`,
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
    const projectName = path.basename(filePath, ".schrune");
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
        for (const [index, pin] of flattenPins(component.pins).entries()) {
            if (!pin.net) {
                continue;
            }
            const padNumber = physicalPadNumber(component, pin, index);
            const symbolPin = symbolPins.get(padNumber);
            if (!symbolPin) {
                throw new Error(`${component.designator} pin ${padNumber} is missing from ${asset.symbolPath}`);
            }
            const point = pinEnd(placement, symbolPin);
            connections.push(renderNetConnection(projectName, component, pin.net, point, {
                ...symbolPin,
                number: padNumber,
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
    const openEnd = raw.indexOf("\n");
    const firstLine = openEnd === -1 ? raw : raw.slice(0, openEnd);
    const name = firstLine.match(/^\(footprint\s+"([^"]+)"/)
        || firstLine.match(/^\(module\s+([^\s)]+)/);
    if (!name) {
        throw new Error(`Invalid KiCad footprint: ${asset.footprintPath}`);
    }

    const valueText = component.value || component.info.partNumber || componentKind(component);
    let body = openEnd === -1 ? "" : raw.slice(openEnd + 1, -1).trimEnd();
    body = replaceFootprintText(body, "reference", component.designator);
    body = replaceFootprintText(body, "value", valueText);
    body = convertLegacyFootprintArcs(body);

    const pinNetByPad = new Map(flattenPins(component.pins).map((pin, index) => [physicalPadNumber(component, pin, index), pin.net]));
    body = addPadNets(body, pinNetByPad, netNumbers);

    const indentedBody = body.split("\n").map((line) => `    ${line}`).join("\n");
    return [
        `  (footprint ${kicadString(`Schrune:${name[1]}`)} (layer "F.Cu")`,
        `    (uuid ${kicadId(`${projectName}:pcb:${component.designator}`)})`,
        `    (at ${(placement.x * 1.25).toFixed(2)} ${(placement.y * 1.25).toFixed(2)} 0)`,
        `    (property "Reference" ${kicadString(component.designator)})`,
        `    (property "Value" ${kicadString(valueText)})`,
        indentedBody,
        `  )`,
    ].join("\n");
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
        const nextPadSource = netName && !/\(net\s+\d+\s+"[^"]*"\)/.test(padSource)
            ? `${padSource.slice(0, -1)} (net ${netNumbers.get(netName)} ${kicadString(netName)}))`
            : padSource;

        output += source.slice(cursor, openIndex);
        output += nextPadSource;
        cursor = closeIndex + 1;
        padPattern.lastIndex = closeIndex + 1;
    }

    return output + source.slice(cursor);
}

function renderPcb(filePath, compiled, assets, placements) {
    const projectName = path.basename(filePath, ".schrune");
    const netNames = netNamesFor(compiled);
    const netNumbers = new Map(netNames.map((netName, index) => [netName, index + 1]));
    const footprints = compiled.components.map((component) => {
        return transformFootprintForBoard(component, assets.get(component), placements.get(component), netNumbers, projectName);
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

function renderProject(projectName) {
    return `${JSON.stringify({
        board: {
            design_settings: {
                defaults: {},
            },
        },
        meta: {
            filename: `${projectName}.kicad_pro`,
            version: 1,
        },
        net_settings: {
            classes: [],
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
            symbolPath,
            footprintPath,
            pins: parseSymbolPins(extracted.source),
        });
    }

    return assets;
}

function writeKiCadFiles(filePath, compiled) {
    const projectName = path.basename(filePath, ".schrune");
    const outputDir = path.join(path.dirname(filePath), "KiCad");
    const projectPath = path.join(outputDir, `${projectName}.kicad_pro`);
    const schematicPath = path.join(outputDir, `${projectName}.kicad_sch`);
    const pcbPath = path.join(outputDir, `${projectName}.kicad_pcb`);
    const assets = collectAssets(filePath, compiled);
    const placements = componentPlacement(compiled);
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

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(projectPath, renderProject(projectName));
    fs.writeFileSync(schematicPath, renderSchematic(
        filePath,
        { ...compiled, components: rootComponents },
        assets,
        placements,
        {
            globalLabels: hasModuleSheets,
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
            placements,
            { globalLabels: true }
        ));
        moduleSchematicPaths[entry.name] = modulePath;
    }

    fs.writeFileSync(pcbPath, renderPcb(filePath, compiled, assets, placements));

    return {
        ...compiled,
        kicadDir: outputDir,
        kicadProjectPath: projectPath,
        schematicPath,
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
