#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline/promises");
const { spawn } = require("child_process");
const { addLcscPart } = require("./lcsc");
const { assignDesignators, buildDesignatorState, readDesignatorState, readPartsLock, step3, writeDesignatorState } = require("./bom");
const { writeKiCadFiles } = require("./kicad");
const {
    PROJECT_FILE,
    addPartToProjectConfig,
    findProjectConfig,
    findProjectConfigInDirectory,
    manifestBuildRecord,
    relativeManifestPath,
    resolveBuildTarget,
    writeProjectConfig,
} = require("./project");

const ANSI = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    gray: "\x1b[90m",
};

function supportsColor(stream = process.stderr) {
    return process.env.FORCE_COLOR || (stream && stream.isTTY && !process.env.NO_COLOR);
}

function colorize(value, color, stream = process.stderr) {
    if (!supportsColor(stream)) {
        return value;
    }

    return `${ANSI[color]}${value}${ANSI.reset}`;
}

function createProgress(stream = process.stderr) {
    const frames = ["-", "\\", "|", "/"];
    const enabled = Boolean(stream.isTTY);
    let timer;
    let index = 0;
    let message = "";

    function render(prefix) {
        if (!enabled) {
            return;
        }
        stream.write(`\r${colorize(prefix, "yellow", stream)} ${message}`);
    }

    function clear() {
        if (!enabled) {
            return;
        }
        stream.write(`\r${" ".repeat(message.length + 4)}\r`);
    }

    function stopTimer() {
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
    }

    return {
        start(nextMessage) {
            stopTimer();
            message = nextMessage;
            if (!enabled) {
                stream.write(`${colorize("...", "yellow", stream)} ${message}\n`);
                return;
            }
            index = 0;
            render(frames[index]);
            timer = setInterval(() => {
                index = (index + 1) % frames.length;
                render(frames[index]);
            }, 80);
        },
        update(nextMessage) {
            message = nextMessage;
            if (!enabled) {
                stream.write(`${colorize("...", "yellow", stream)} ${message}\n`);
                return;
            }
            render(frames[index]);
        },
        succeed(nextMessage = message) {
            stopTimer();
            if (!enabled) {
                stream.write(`${colorize("[done]", "green", stream)} ${nextMessage}\n`);
                return;
            }
            clear();
            stream.write(`${colorize("[done]", "green", stream)} ${nextMessage}\n`);
        },
        fail(nextMessage = message) {
            stopTimer();
            if (!enabled) {
                stream.write(`${colorize("[failed]", "red", stream)} ${nextMessage}\n`);
                return;
            }
            clear();
            stream.write(`${colorize("[failed]", "red", stream)} ${nextMessage}\n`);
        },
        stop() {
            stopTimer();
            clear();
        },
    };
}

class CompileError extends Error {
    constructor(message, location = {}, options = {}) {
        super(message, options);
        this.name = "CompileError";
        this.filePath = location.filePath;
        this.line = location.line;
        this.column = location.column;
        this.sourceLine = location.sourceLine;
        this.statement = location.statement;
    }
}

function sourceLocation(source, index) {
    const boundedIndex = Math.max(0, Math.min(index, source.length));
    const before = source.slice(0, boundedIndex);
    const lines = before.split(/\r?\n/);
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    const sourceLine = source.split(/\r?\n/)[line - 1] || "";
    return { line, column, sourceLine };
}

function attachSourceLocation(error, filePath, source, index, statement) {
    if (error instanceof CompileError || error.filePath) {
        return error;
    }

    const location = {
        filePath,
        ...sourceLocation(source, index),
        statement,
    };
    const wrapped = new CompileError(error.message, location, { cause: error });
    wrapped.stack = error.stack;
    return wrapped;
}

function formatError(error, stream = process.stderr) {
    const lines = [];
    const label = colorize("Error:", "red", stream);
    lines.push(`${label} ${error.message}`);

    if (error.filePath && error.line) {
        const location = `${error.filePath}:${error.line}:${error.column || 1}`;
        lines.push(`${colorize("at", "yellow", stream)} ${location}`);
        if (error.sourceLine) {
            lines.push(colorize(`  ${error.sourceLine.trimEnd()}`, "gray", stream));
            const caretColumn = Math.max(1, error.column || 1);
            lines.push(colorize(`  ${" ".repeat(caretColumn - 1)}^`, "red", stream));
        }
    }

    if (error.stack) {
        lines.push(colorize("Stack trace:", "red", stream));
        lines.push(error.stack);
    }

    return lines.join("\n");
}

function stripComments(source) {
    return source.replace(/\/\/.*$/gm, "");
}

function findMatching(source, openIndex, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = openIndex; i < source.length; i++) {
        const char = source[i];
        const prev = source[i - 1];

        if (inString) {
            if (char === stringChar && prev !== "\\") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }

        if (char === openChar) {
            depth++;
        } else if (char === closeChar) {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    throw new Error(`Could not find matching ${closeChar}`);
}

function extractBlocks(source, keyword, options = {}) {
    const blocks = [];
    const parameters = options.allowParameters ? "\\s*(\\([^)]*\\))?" : "";
    const pattern = new RegExp(`\\b${keyword}\\s+([A-Za-z_]\\w*)${parameters}\\s*\\{`, "g");
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const openIndex = source.indexOf("{", match.index);
        const closeIndex = findMatching(source, openIndex, "{", "}");
        blocks.push({
            name: match[1],
            parameters: match[2] ? match[2].slice(1, -1).trim() : "",
            startIndex: match.index,
            openIndex,
            bodyStart: openIndex + 1,
            bodyEnd: closeIndex,
            body: source.slice(openIndex + 1, closeIndex),
        });
        pattern.lastIndex = closeIndex + 1;
    }

    return blocks;
}

function splitStatements(body) {
    const statements = [];
    let start = 0;
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i < body.length; i++) {
        const char = body[i];
        const prev = body[i - 1];

        if (inString) {
            if (char === stringChar && prev !== "\\") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }

        if (char === "(" || char === "[" || char === "{") {
            depth++;
        } else if (char === ")" || char === "]" || char === "}") {
            depth--;
        } else if ((char === ";" || char === "\n") && depth === 0) {
            const statement = body.slice(start, i).trim();
            if (statement && (char === ";" || isCompleteLineStatement(statement))) {
                statements.push(statement);
                start = i + 1;
            }
        }
    }

    const tail = body.slice(start).trim();
    if (tail) {
        statements.push(tail);
    }

    return statements;
}

function isCompleteLineStatement(statement) {
    return [
        /^(net|rail)\s+[A-Za-z_]\w*$/,
        /^val\s+[A-Za-z_]\w*\s*=\s*.+$/,
        /^.+?\.name\s*=\s*.+$/,
        /^[A-Za-z_]\w*\.voltage\s*=\s*.+$/,
        /^[A-Za-z_]\w*\.place\s*=\s*(?:true|false)$/,
        /^(?:part\s+)?[A-Za-z_]\w*\s*=\s*new\s+[A-Za-z_]\w*\s*\([\s\S]*\)$/,
        /^(?:part\s+)?[A-Za-z_]\w*\s*=\s*new\s+[A-Za-z_]\w*$/,
        /^part\[\d+\]\s+[A-Za-z_]\w*\s*=\s*new\s+[A-Za-z_]\w*\s*\([\s\S]*\)$/,
        /^mod\s+[A-Za-z_]\w*\s*=\s*new\s+[A-Za-z_]\w*\s*\([\s\S]*\)$/,
        /^.+?\s*~\s*.+$/,
        /^.+?\s*~>\s*.+$/,
        /^for\s*\(/,
        /^if\s*\(/,
    ].some((pattern) => pattern.test(statement));
}

function parseValue(value) {
    const trimmed = value.trim().replace(/,$/, "");
    const quoted = trimmed.match(/^["'](.*)["']$/);
    return quoted ? quoted[1] : trimmed;
}

function parseInfo(body) {
    const infoMatch = body.match(/\binfo\s*:\s*\{/);
    if (!infoMatch) {
        return {};
    }

    const openIndex = body.indexOf("{", infoMatch.index);
    const closeIndex = findMatching(body, openIndex, "{", "}");
    const infoBody = body.slice(openIndex + 1, closeIndex);
    const info = {};
    const pattern = /([A-Za-z_]\w*)\s*:\s*("[^"]*"|'[^']*'|[^,\n]+)\s*,?/g;
    let match;

    while ((match = pattern.exec(infoBody)) !== null) {
        info[match[1]] = parseValue(match[2]);
    }

    return info;
}

function parsePins(body) {
    const pinsMatch = body.match(/\bpins\s*:\s*\[/);
    if (!pinsMatch) {
        return [];
    }

    const openIndex = body.indexOf("[", pinsMatch.index);
    const closeIndex = findMatching(body, openIndex, "[", "]");
    const pinsBody = body.slice(openIndex + 1, closeIndex);
    return parsePinEntries(pinsBody);
}

function splitTopLevelEntries(body) {
    const entries = [];
    let start = 0;
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i <= body.length; i++) {
        const char = body[i];
        const prev = body[i - 1];

        if (inString) {
            if (char === stringChar && prev !== "\\") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }

        if (char === "[" || char === "{" || char === "(") {
            depth++;
        } else if (char === "]" || char === "}" || char === ")") {
            depth--;
        }

        if ((char === "," || char === "\n" || i === body.length) && depth === 0) {
            const entry = body.slice(start, i).trim().replace(/,$/, "");
            if (entry) {
                entries.push(entry);
            }
            start = i + 1;
        }
    }

    return entries;
}

function parsePinEntries(body) {
    const pins = [];

    for (const entry of splitTopLevelEntries(body)) {
        const railMatch = entry.match(/^rail\s+([A-Za-z_]\w*)\s*:\s*\{([\s\S]*)\}$/);
        if (railMatch) {
            pins.push({
                name: railMatch[1],
                group: parsePinObjectEntries(railMatch[2], ["h", "l"]),
                objectGroup: true,
                rail: true,
            });
            continue;
        }

        const netGroupMatch = entry.match(/^net<([A-Za-z_]\w*)>\s+([A-Za-z_]\w*)\s*:\s*\{([\s\S]*)\}$/);
        if (netGroupMatch) {
            const type = normalizeNetType(netGroupMatch[1]);
            pins.push({
                name: netGroupMatch[2],
                group: parsePinObjectEntries(netGroupMatch[3], netTypeSignals(type)),
                objectGroup: true,
                netGroupType: type,
            });
            continue;
        }

        const nestedMatch = entry.match(/^([A-Za-z_]\w*)\s*:\s*\[([\s\S]*)\]$/);
        if (nestedMatch) {
            pins.push({
                name: nestedMatch[1],
                group: parsePinEntries(nestedMatch[2]),
            });
            continue;
        }

        const match = entry.match(/^([A-Za-z_]\w*|\d+)\s*:\s*([A-Za-z0-9_]+(?:\s*~\s*[A-Za-z0-9_]+)*)$/);
        if (!match) {
            throw new Error(`Invalid pin entry "${entry}"`);
        }
        pins.push(parsePinEntry(match[1], match[2]));
    }

    return pins;
}

function parsePinObjectEntries(body, requiredNames = []) {
    const entries = new Map();
    for (const entry of splitTopLevelEntries(body)) {
        const match = entry.match(/^([A-Za-z_]\w*)\s*:\s*([A-Za-z0-9_]+(?:\s*~\s*[A-Za-z0-9_]+)*)$/);
        if (!match) {
            throw new Error(`Invalid pin group entry "${entry}"`);
        }
        entries.set(match[1], parsePinEntry(match[1], match[2]));
    }

    for (const name of requiredNames) {
        if (!entries.has(name)) {
            throw new Error(`Pin group is missing "${name}"`);
        }
    }

    return [...entries.values()];
}

function parsePadValue(value) {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function parsePinEntry(name, pads) {
    const padValues = pads.split("~").map(parsePadValue);
    if (padValues.length === 1) {
        return {
            name,
            pad: padValues[0],
        };
    }

    return {
        name,
        group: padValues.map((pad) => ({
            name: String(pad),
            pad,
        })),
    };
}

function parseConstructorArgs(args) {
    const params = {};
    let start = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i <= args.length; i++) {
        const char = args[i];
        const prev = args[i - 1];

        if (inString) {
            if (char === stringChar && prev !== "\\") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }

        if (char === "," || i === args.length) {
            const pair = args.slice(start, i).trim();
            if (pair) {
                const match = pair.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
                if (!match) {
                    throw new Error(`Invalid constructor parameter "${pair}"`);
                }
                params[match[1]] = parseValue(match[2]);
            }
            start = i + 1;
        }
    }

    return params;
}

function parseConstructorArgExpressions(args) {
    const params = {};
    let start = 0;
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i <= args.length; i++) {
        const char = args[i];
        const prev = args[i - 1];

        if (inString) {
            if (char === stringChar && prev !== "\\") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }

        if (char === "(" || char === "[" || char === "{") {
            depth++;
        } else if (char === ")" || char === "]" || char === "}") {
            depth--;
        }

        if ((char === "," || i === args.length) && depth === 0) {
            const pair = args.slice(start, i).trim();
            if (pair) {
                const match = pair.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
                if (!match) {
                    throw new Error(`Invalid constructor parameter "${pair}"`);
                }
                params[match[1]] = match[2].trim();
            }
            start = i + 1;
        }
    }

    return params;
}

function splitConnectionChain(statement) {
    if (statement.includes("~>")) {
        return undefined;
    }

    const parts = splitTopLevelOperator(statement, "~");
    return parts.length > 1 ? parts : undefined;
}

function splitTopLevelOperator(body, operator) {
    const parts = [];
    let start = 0;
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i < body.length; i++) {
        const char = body[i];
        const prev = body[i - 1];

        if (inString) {
            if (char === stringChar && prev !== "\\") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" || char === "'") {
            inString = true;
            stringChar = char;
            continue;
        }

        if (char === "(" || char === "[" || char === "{") {
            depth++;
        } else if (char === ")" || char === "]" || char === "}") {
            depth--;
        }

        if (char === operator && depth === 0) {
            const part = body.slice(start, i).trim();
            if (part) {
                parts.push(part);
            }
            start = i + 1;
        }
    }

    const tail = body.slice(start).trim();
    if (tail) {
        parts.push(tail);
    }
    return parts;
}

function parseInlineNetDeclaration(statement) {
    const match = statement.match(/^net(?:<([A-Za-z_]\w*)>)?\s+([A-Za-z_]\w*)\s*~\s*([\s\S]+)$/);
    if (!match) {
        return undefined;
    }

    return {
        kind: "net",
        type: match[1] ? normalizeNetType(match[1]) : undefined,
        name: match[2],
        rest: match[3].trim(),
        inlineAnchor: true,
    };
}

function parsePart(source, filePath) {
    const parts = extractBlocks(source, "part");
    const templates = new Map();

    for (const part of parts) {
        try {
            templates.set(part.name, {
                name: part.name,
                info: parseInfo(part.body),
                pins: parsePins(part.body),
            });
        } catch (error) {
            const messageMatch = error.message && error.message.match(/"([^"]+)"/);
            const entryIndex = messageMatch ? part.body.indexOf(messageMatch[1]) : -1;
            const locationIndex = entryIndex >= 0 ? part.bodyStart + entryIndex : part.startIndex;
            throw attachSourceLocation(error, filePath, source, locationIndex);
        }
    }

    return templates;
}

function parseModules(source, filePath) {
    return new Map(extractBlocks(source, "module", { allowParameters: true }).map((module) => [
        module.name,
        {
            name: module.name,
            parameters: module.parameters
                ? module.parameters.split(",").map((parameter) => parameter.trim()).filter(Boolean)
                : [],
            body: module.body,
            filePath,
            source,
            bodyStart: module.bodyStart,
            startIndex: module.startIndex,
        },
    ]));
}

function includedFiles(filePath, loaded = new Set()) {
    const resolvedPath = path.resolve(filePath);
    if (loaded.has(resolvedPath)) {
        return [];
    }

    loaded.add(resolvedPath);
    const baseDir = path.dirname(resolvedPath);
    const rawSource = fs.readFileSync(resolvedPath, "utf8");
    const source = stripComments(rawSource);
    const includePattern = /^\s*#include\s+["']([^"']+)["']/gm;
    const files = [];
    let match;

    while ((match = includePattern.exec(source)) !== null) {
        const includePath = findInclude(baseDir, match[1]);
        files.push(includePath, ...includedFiles(includePath, loaded));
    }

    return files;
}

function createPrimitiveTemplates() {
    const names = ["Resistor", "Capacitor", "Diode", "Inductor"];
    const prefixes = {
        Resistor: "R",
        Capacitor: "C",
        Diode: "D",
        Inductor: "L",
    };
    return new Map(names.map((name) => [name, {
        name,
        primitive: true,
        info: {
            partNumber: name,
            manufacture: "Generic",
            footprint: undefined,
            symbol: "./",
            model: "./",
            LCSC: undefined,
            designatorPrefix: prefixes[name],
        },
        pins: [
            { name: "0", pad: 0 },
            { name: "1", pad: 1 },
        ],
    }]));
}

function createComponent(template, params = {}) {
    if (template.primitive && !("value" in params) && !("LCSC" in params) && !("lcsc" in params)) {
        throw new Error(`${template.name} requires a value or LCSC part`);
    }
    const footprint = params.footprint;

    const Component = {
        [template.name]: class {
            constructor() {
                this.info = {
                    ...template.info,
                    footprint: footprint || template.info.footprint,
                    LCSC: params.LCSC || params.lcsc || template.info.LCSC,
                };
                this.place = true;
                this.pins = [];
                if (template.primitive) {
                    Object.assign(this, params);
                    this.footprint = footprint;
                }

                addPins(this.pins, template.pins);
            }
        }
    }[template.name];

    return new Component();
}

function createComponentInstances(template, params, count) {
    return Array.from({ length: count }, () => createComponent(template, params));
}

function annotateComponent(component, name, index, modulePath = []) {
    component.__schrune = {
        ...(component.__schrune || {}),
        name,
        arrayIndex: index,
        modulePath,
        moduleName: modulePath.join("."),
    };
    return component;
}

function addPins(target, pins, indexed = false) {
    for (const pin of pins) {
        if (pin.group) {
            const group = pin.objectGroup ? {} : [];
            if (pin.rail) {
                group.__pinRail = true;
            }
            if (pin.netGroupType) {
                group.__pinNetGroup = true;
                group.type = pin.netGroupType;
            }
            addPins(group, pin.group, !pin.objectGroup);
            target[pin.name] = group;
            continue;
        }

        const pinValue = {
            name: pin.name,
            pad: pin.pad,
            net: "",
        };

        if (indexed) {
            target.push(pinValue);
        }

        if (/^\d+$/.test(pin.name)) {
            target[Number(pin.name)] = pinValue;
        } else {
            target[pin.name] = pinValue;
        }
    }
}

function findInclude(baseDir, includeName) {
    const directPath = path.resolve(baseDir, includeName);
    if (fs.existsSync(directPath)) {
        return directPath;
    }
    const includeFileNames = path.extname(includeName)
        ? [includeName]
        : [includeName, `${includeName}.schrune`];

    const matches = [];

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(entryPath);
            } else if (entry.isFile() && includeFileNames.includes(entry.name)) {
                matches.push(entryPath);
            }
        }
    }

    walk(baseDir);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new Error(`Include "${includeName}" is ambiguous`);
    }

    throw new Error(`Could not resolve include "${includeName}"`);
}

function loadFile(filePath, loaded = new Set()) {
    const resolvedPath = path.resolve(filePath);
    if (loaded.has(resolvedPath)) {
        return { source: "", templates: new Map(), modules: new Map() };
    }

    loaded.add(resolvedPath);
    const baseDir = path.dirname(resolvedPath);
    const rawSource = fs.readFileSync(resolvedPath, "utf8");
    const source = stripComments(rawSource);
    const templates = createPrimitiveTemplates();
    const modules = new Map();
    const importMatch = source.match(/^\s*#import\b/m);
    if (importMatch) {
        throw attachSourceLocation(new Error("Use #include to add files"), resolvedPath, source, importMatch.index);
    }

    const includePattern = /^\s*#include\s+["']([^"']+)["']/gm;
    let match;

    while ((match = includePattern.exec(source)) !== null) {
        const includePath = findInclude(baseDir, match[1]);
        const includeFile = loadFile(includePath, loaded);
        for (const [name, template] of includeFile.templates) {
            templates.set(name, template);
        }
        for (const [name, module] of includeFile.modules) {
            modules.set(name, module);
        }
    }

    for (const [name, template] of parsePart(source, resolvedPath)) {
        templates.set(name, template);
    }
    for (const [name, module] of parseModules(source, resolvedPath)) {
        modules.set(name, module);
    }

    return { source, templates, modules };
}

function uniqueNetName(preferred, used) {
    let name = preferred;
    let index = 1;

    while (used.has(name)) {
        name = `${preferred}_${index}`;
        index++;
    }

    used.add(name);
    return name;
}

const UNIT_PREFIX_MULTIPLIERS = {
    T: 1e12,
    G: 1e9,
    M: 1e6,
    k: 1e3,
    K: 1e3,
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
};

function createVal(number, unit = "") {
    return {
        number,
        unit,
        valueOf() {
            return this.number;
        },
        toString() {
            return `${this.number}${this.unit}`;
        },
    };
}

function parseValLiteral(literal) {
    const match = String(literal).trim().match(/^(-?\d+(?:\.\d+)?)([A-Za-z][A-Za-z0-9_/%]*)$/);
    if (!match) {
        return undefined;
    }

    const unit = match[2];
    const multiplier = unit.length > 1 && UNIT_PREFIX_MULTIPLIERS[unit[0]] !== undefined
        ? UNIT_PREFIX_MULTIPLIERS[unit[0]]
        : 1;
    return createVal(Number(match[1]) * multiplier, unit);
}

function normalizeValueExpression(expression) {
    return expression.replace(/(^|[^A-Za-z0-9_."'])(-?\d+(?:\.\d+)?[A-Za-z][A-Za-z0-9_/%]*)/g, (_match, prefix, literal) => {
        const value = parseValLiteral(literal);
        return value ? `${prefix}__val(${value.number}, ${jsString(value.unit)})` : `${prefix}${literal}`;
    });
}

function evaluateValueExpression(expression, scope, componentsByName) {
    const trimmed = expression.trim();
    const quoted = trimmed.match(/^["'](.*)["']$/);
    if (quoted) {
        return quoted[1];
    }
    if (trimmed.includes("+/-")) {
        return parseValue(trimmed);
    }

    const values = {
        __val: createVal,
        ...evaluationScope(scope, componentsByName),
    };
    const names = Object.keys(values);
    try {
        return Function(...names, `"use strict"; return (${normalizeValueExpression(trimmed)});`)(...Object.values(values));
    } catch (_error) {
        return parseValue(trimmed);
    }
}

function evaluateArgumentList(args, scope, componentsByName) {
    return Object.fromEntries(Object.entries(parseConstructorArgExpressions(args)).map(([name, expression]) => [
        name,
        evaluateValueExpression(expression, scope, componentsByName),
    ]));
}

function moduleNetBinding(expression, modulesByName) {
    const parts = expression.trim().split(".");
    if (!modulesByName || parts.length < 2 || !modulesByName.has(parts[0])) {
        return undefined;
    }

    let owner = modulesByName.get(parts[0]).nets;
    for (let i = 1; i < parts.length - 1; i++) {
        owner = owner[parts[i]];
        if (!owner || typeof owner !== "object") {
            return undefined;
        }
    }

    const key = parts[parts.length - 1];
    if (!(key in owner)) {
        return undefined;
    }

    return {
        value: owner[key],
        set(value) {
            if (isNetRef(owner[key])) {
                owner[key].value = netRefName(value);
                owner[key].aliasOf = isNetRef(value) ? value : undefined;
                return;
            }
            owner[key] = value;
        },
    };
}

function netBinding(expression, nets, modulesByName) {
    const value = expression.trim();
    const railMatch = value.match(/^([A-Za-z_]\w*)\.(h|l)$/);
    if (railMatch) {
        const rail = nets[railMatch[1]];
        if (rail && typeof rail === "object") {
            return {
                value: rail[railMatch[2]],
                set(nextValue) {
                    if (isNetRef(rail[railMatch[2]])) {
                        rail[railMatch[2]].value = netRefName(nextValue);
                        rail[railMatch[2]].aliasOf = isNetRef(nextValue) ? nextValue : undefined;
                        return;
                    }
                    rail[railMatch[2]] = nextValue;
                },
            };
        }
    }

    const netGroupMatch = value.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
    if (netGroupMatch) {
        const owner = nets[netGroupMatch[1]];
        if (owner && typeof owner === "object" && netGroupMatch[2] in owner) {
            return {
                value: owner[netGroupMatch[2]],
                set(nextValue) {
                    if (isNetRef(owner[netGroupMatch[2]])) {
                        owner[netGroupMatch[2]].value = netRefName(nextValue);
                        owner[netGroupMatch[2]].aliasOf = isNetRef(nextValue) ? nextValue : undefined;
                        return;
                    }
                    owner[netGroupMatch[2]] = nextValue;
                },
            };
        }
    }

    if (value in nets) {
        return {
            value: nets[value],
            set(nextValue) {
                if (isNetRef(nets[value])) {
                    nets[value].value = netRefName(nextValue);
                    nets[value].aliasOf = isNetRef(nextValue) ? nextValue : undefined;
                    return;
                }
                nets[value] = nextValue;
            },
        };
    }

    return moduleNetBinding(value, modulesByName);
}

function readNetReference(expression, nets, modulesByName) {
    const binding = netBinding(expression, nets, modulesByName);
    if (!binding) {
        throw new Error(`Unknown net "${expression.trim()}"`);
    }

    return binding.value;
}

function getNetValue(expression, nets, modulesByName) {
    const binding = netBinding(expression, nets, modulesByName);
    return binding && binding.value;
}

function connectNetBindings(left, right, leftExpression, rightExpression, nameOverrides, netAliases = new Map()) {
    function resolvedName(expression, binding) {
        return netRefName(rootNetRef(binding.value));
    }

    if (isNetGroup(left.value) || isNetGroup(right.value)) {
        if (!isNetGroup(left.value) || !isNetGroup(right.value)) {
            throw new Error(`Connection joins net group and net "${leftExpression} ~ ${rightExpression}"`);
        }
        if (left.value.type !== right.value.type) {
            throw new Error(`Connection joins net groups of different types "${left.value.type}" and "${right.value.type}"`);
        }

        for (const signalName of netTypeSignals(left.value.type)) {
            const leftSignal = left.value[signalName];
            const rightSignal = right.value[signalName];
            if (!leftSignal || !rightSignal) {
                throw new Error(`Net group "${left.value.type}" is missing signal "${signalName}"`);
            }
            connectNetBindings(
                { value: leftSignal, set(value) { left.value[signalName] = value; } },
                { value: rightSignal, set(value) { right.value[signalName] = value; } },
                `${leftExpression}.${signalName}`,
                `${rightExpression}.${signalName}`,
                nameOverrides,
                netAliases
            );
        }
        return;
    }

    if (isRailValue(left.value) || isRailValue(right.value)) {
        if (!isRailValue(left.value) || !isRailValue(right.value)) {
            throw new Error(`Connection joins rail and net "${leftExpression} ~ ${rightExpression}"`);
        }

        connectNetBindings(
            { value: left.value.h, set(value) { left.value.h = value; } },
            { value: right.value.h, set(value) { right.value.h = value; } },
            `${leftExpression}.h`,
            `${rightExpression}.h`,
            nameOverrides,
            netAliases
        );
        connectNetBindings(
            { value: left.value.l, set(value) { left.value.l = value; } },
            { value: right.value.l, set(value) { right.value.l = value; } },
            `${leftExpression}.l`,
            `${rightExpression}.l`,
            nameOverrides,
            netAliases
        );
        return;
    }

    const leftRoot = rootNetRef(left.value);
    const rightRoot = rootNetRef(right.value);
    const leftName = netRefName(leftRoot);
    const rightName = netRefName(rightRoot);

    if (leftName === rightName) {
        return;
    }

    const leftNamed = isNetRef(leftRoot) && leftRoot.isOverride && !isScopedNetRef(leftRoot);
    const rightNamed = isNetRef(rightRoot) && rightRoot.isOverride && !isScopedNetRef(rightRoot);
    const leftResolvedName = resolvedName(leftExpression, left);
    const rightResolvedName = resolvedName(rightExpression, right);

    if (leftNamed && rightNamed) {
        throw new Error(`Connection joins nets "${leftResolvedName}" and "${rightResolvedName}"`);
    }

    if (leftNamed) {
        netAliases.set(rightResolvedName, leftResolvedName);
        right.set(leftRoot);
        return;
    }

    netAliases.set(leftResolvedName, rightResolvedName);
    left.set(rightRoot);
}

function resolveNetConnection(leftExpression, rightExpression, nets, nameOverrides, modulesByName, netAliases) {
    const left = netBinding(leftExpression, nets, modulesByName);
    const right = netBinding(rightExpression, nets, modulesByName);
    if (!left || !right) {
        throw new Error(`Unknown net connection "${leftExpression} ~ ${rightExpression}"`);
    }

    connectNetBindings(left, right, leftExpression, rightExpression, nameOverrides, netAliases);
}

function evaluateIndex(expression, scope) {
    const trimmed = expression.trim();
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
    }

    const names = Object.keys(scope);
    const values = Object.values(scope);
    return Function(...names, `"use strict"; return (${trimmed});`)(...values);
}

function evaluationScope(scope, componentsByName) {
    return {
        ...Object.fromEntries(componentsByName.entries()),
        ...scope,
    };
}

function evaluateExpression(expression, scope, componentsByName) {
    const values = evaluationScope(scope, componentsByName);
    const names = Object.keys(values);
    return Function(...names, `"use strict"; return (${expression});`)(...Object.values(values));
}

function parseComponentReference(expression, scope = {}) {
    const value = expression.trim();
    const arrayMatch = value.match(/^([A-Za-z_]\w*)\[(.+)\]$/);
    if (arrayMatch) {
        return {
            name: arrayMatch[1],
            index: evaluateIndex(arrayMatch[2], scope),
        };
    }

    if (/^[A-Za-z_]\w*$/.test(value)) {
        return {
            name: value,
            index: undefined,
        };
    }

    return undefined;
}

function componentRefName(componentRef, scope = {}) {
    const localName = componentRef.index === undefined ? componentRef.name : `${componentRef.name}_${componentRef.index}`;
    return `${scope.__pathPrefix || ""}${localName}`;
}

function getComponentValue(componentsByName, componentRef) {
    const component = componentsByName.get(componentRef.name);
    if (!component) {
        throw new Error(`Unknown component "${componentRef.name}"`);
    }

    if (componentRef.index === undefined) {
        return component;
    }

    if (!Array.isArray(component)) {
        throw new Error(`Component "${componentRef.name}" is not an array`);
    }

    return component[componentRef.index];
}

function getPinFromPath(component, pathParts) {
    let value = component.pins;
    for (const part of pathParts) {
        value = value[part];
        if (!value) {
            return undefined;
        }
    }
    return value;
}

function collectLeafPinPaths(value, path = [], paths = []) {
    if (!value || typeof value !== "object") {
        return paths;
    }

    if (value.pad !== undefined && value.name !== undefined) {
        paths.push([...path]);
        return paths;
    }

    for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("__")) {
            continue;
        }
        collectLeafPinPaths(child, [...path, /^\d+$/.test(key) ? Number(key) : key], paths);
    }

    return paths;
}

function parsePathParts(pathExpression, scope = {}) {
    const parts = [];
    let rest = pathExpression;

    while (rest) {
        if (rest[0] === ".") {
            const match = rest.match(/^\.([A-Za-z_]\w*|\d+)/);
            if (!match) {
                return undefined;
            }
            parts.push(match[1]);
            rest = rest.slice(match[0].length);
            continue;
        }

        if (rest[0] === "[") {
            const closeIndex = findMatching(rest, 0, "[", "]");
            parts.push(evaluateIndex(rest.slice(1, closeIndex), scope));
            rest = rest.slice(closeIndex + 1);
            continue;
        }

        return undefined;
    }

    return parts;
}

function getPinKey(expression, scope = {}) {
    const value = expression.trim();
    const nameMatch = value.match(/^([A-Za-z_]\w*)/);
    if (!nameMatch) {
        return undefined;
    }

    const name = nameMatch[1];
    let rest = value.slice(name.length);
    let componentRef = { name, index: undefined };

    if (rest.startsWith("[")) {
        const closeIndex = findMatching(rest, 0, "[", "]");
        const indexExpression = rest.slice(1, closeIndex);
        const afterIndex = rest.slice(closeIndex + 1);
        if (!afterIndex) {
            const pin = evaluateIndex(indexExpression, scope);
            const componentName = componentRefName(componentRef, scope);
            return {
                componentRef,
                path: [pin],
                key: `${componentName}[${pin}]`,
                defaultNetName: `${componentName}_${pin}`,
            };
        }

        componentRef = { name, index: evaluateIndex(indexExpression, scope) };
        rest = afterIndex;
    }

    if (!rest) {
        return undefined;
    }

    const path = parsePathParts(rest, scope);
    if (!path || !path.length) {
        return undefined;
    }

    const componentName = componentRefName(componentRef, scope);
    const suffix = path.map((part) => /^\d+$/.test(String(part)) ? `[${part}]` : `.${part}`).join("");
    const defaultSuffix = path.map((part) => String(part)).join("_");
    return {
        componentRef,
        path,
        key: `${componentName}${suffix}`,
        defaultNetName: `${componentName}_${defaultSuffix}`,
    };
}

function getComponentPin(componentsByName, expression, scope = {}) {
    const pinKey = getPinKey(expression, scope);
    if (!pinKey) {
        return undefined;
    }

    const component = getComponentValue(componentsByName, pinKey.componentRef);
    return getPinFromPath(component, pinKey.path);
}

function readEndpoint(expression, componentsByName, nets, scope = {}, modulesByName) {
    const net = getNetValue(expression, nets, modulesByName);
    if (net !== undefined) {
        return {
            type: "net",
            value: net,
        };
    }

    const pinKey = getPinKey(expression, scope);
    if (!pinKey) {
        throw new Error(`Unknown connection endpoint "${expression}"`);
    }

    const pin = getComponentPin(componentsByName, expression, scope);
    if (!pin) {
        throw new Error(`Unknown component pin "${expression}"`);
    }

    return {
        type: "pin",
        ...pinKey,
        pin,
    };
}

function isPinRailValue(value) {
    return Boolean(value && typeof value === "object" && value.__pinRail);
}

function isPinNetGroupValue(value) {
    return Boolean(value && typeof value === "object" && value.__pinNetGroup);
}

function connectEndpoints(leftExpression, rightExpression, componentsByName, nets, pinGroups, nameOverrides, scope = {}, modulesByName, netAliases) {
    const left = readEndpoint(leftExpression, componentsByName, nets, scope, modulesByName);
    const right = readEndpoint(rightExpression, componentsByName, nets, scope, modulesByName);

    const leftRail = left.type === "net" ? isRailValue(left.value) : isPinRailValue(left.pin);
    const rightRail = right.type === "net" ? isRailValue(right.value) : isPinRailValue(right.pin);
    if (leftRail || rightRail) {
        if (!leftRail || !rightRail) {
            throw new Error(`Connection joins rail and net "${leftExpression} ~ ${rightExpression}"`);
        }
        for (const side of ["h", "l"]) {
            connectEndpoints(`${leftExpression}.${side}`, `${rightExpression}.${side}`, componentsByName, nets, pinGroups, nameOverrides, scope, modulesByName, netAliases);
        }
        return;
    }

    const leftNetGroup = left.type === "net" ? isNetGroup(left.value) : isPinNetGroupValue(left.pin);
    const rightNetGroup = right.type === "net" ? isNetGroup(right.value) : isPinNetGroupValue(right.pin);
    if (leftNetGroup || rightNetGroup) {
        if (!leftNetGroup || !rightNetGroup) {
            throw new Error(`Connection joins net group and net "${leftExpression} ~ ${rightExpression}"`);
        }
        const leftType = left.type === "net" ? left.value.type : left.pin.type;
        const rightType = right.type === "net" ? right.value.type : right.pin.type;
        if (leftType !== rightType) {
            throw new Error(`Connection joins net groups of different types "${leftType}" and "${rightType}"`);
        }
        for (const signalName of netTypeSignals(leftType)) {
            connectEndpoints(`${leftExpression}.${signalName}`, `${rightExpression}.${signalName}`, componentsByName, nets, pinGroups, nameOverrides, scope, modulesByName, netAliases);
        }
        return;
    }

    if (left.type === "pin" && right.type === "pin") {
        pinGroups.union(left, right, netAliases);
        return;
    }

    if (left.type === "pin" && right.type === "net") {
        if (isNetGroup(right.value)) {
            throw new Error(`Net group "${rightExpression}" must be connected via one of its signals`);
        }
        pinGroups.connectExplicit(left, right.value, netAliases);
        return;
    }

    if (left.type === "net" && right.type === "pin") {
        if (isNetGroup(left.value)) {
            throw new Error(`Net group "${leftExpression}" must be connected via one of its signals`);
        }
        pinGroups.connectExplicit(right, left.value, netAliases);
        return;
    }

    resolveNetConnection(leftExpression, rightExpression, nets, nameOverrides, modulesByName, netAliases);
}

function validateBridgeComponent(name, componentsByName, scope = {}) {
    const componentRef = parseComponentReference(name, scope);
    if (!componentRef) {
        throw new Error(`Bridge middle "${name}" must be a component`);
    }

    const component = getComponentValue(componentsByName, componentRef);
    if (!component) {
        throw new Error(`Unknown component "${name}"`);
    }

    const pinPaths = collectLeafPinPaths(component.pins);
    if (pinPaths.length !== 2) {
        throw new Error(`Bridge middle "${name}" must be a component with 2 pins`);
    }

    return pinPaths;
}

function connectBridge(statement, componentsByName, nets, pinGroups, nameOverrides, scope = {}, modulesByName, netAliases) {
    const parts = statement.split("~>").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) {
        throw new Error(`Invalid bridge connection "${statement}"`);
    }

    const middleComponents = parts.slice(1, -1);
    const middlePins = middleComponents.map((componentName) => validateBridgeComponent(componentName, componentsByName, scope));

    connectEndpoints(`${parts[0]}`, `${middleComponents[0]}${renderBridgePathSuffix(middlePins[0][0])}`, componentsByName, nets, pinGroups, nameOverrides, scope, modulesByName, netAliases);

    for (let i = 0; i < middleComponents.length - 1; i++) {
        connectEndpoints(
            `${middleComponents[i]}${renderBridgePathSuffix(middlePins[i][1])}`,
            `${middleComponents[i + 1]}${renderBridgePathSuffix(middlePins[i + 1][0])}`,
            componentsByName,
            nets,
            pinGroups,
            nameOverrides,
            scope,
            modulesByName,
            netAliases
        );
    }

    connectEndpoints(
        `${middleComponents[middleComponents.length - 1]}${renderBridgePathSuffix(middlePins[middlePins.length - 1][1])}`,
        `${parts[parts.length - 1]}`,
        componentsByName,
        nets,
        pinGroups,
        nameOverrides,
        scope,
        modulesByName,
        netAliases
    );
}

function renderBridgePathSuffix(path) {
    if (path === undefined) {
        return "";
    }

    if (Array.isArray(path)) {
        return path.map((part) => /^\d+$/.test(String(part)) ? `[${part}]` : `.${part}`).join("");
    }

    return `[${path}]`;
}

function executeBlock(body, context, scope = {}) {
    for (const statement of splitStatements(body)) {
        executeStatement(statement, context, scope);
    }
}

function parseIfStatement(statement) {
    const conditionStart = statement.indexOf("(");
    const conditionEnd = findMatching(statement, conditionStart, "(", ")");
    const condition = statement.slice(conditionStart + 1, conditionEnd);
    const trueOpen = statement.indexOf("{", conditionEnd);
    const trueClose = findMatching(statement, trueOpen, "{", "}");
    const trueBody = statement.slice(trueOpen + 1, trueClose);
    const rest = statement.slice(trueClose + 1).trim();

    if (!rest) {
        return { condition, trueBody, falseBody: "" };
    }

    const elseMatch = rest.match(/^else\s*\{/);
    if (!elseMatch) {
        throw new Error(`Invalid if statement "${statement}"`);
    }

    const falseOpen = statement.indexOf("{", trueClose + 1);
    const falseClose = findMatching(statement, falseOpen, "{", "}");
    return {
        condition,
        trueBody,
        falseBody: statement.slice(falseOpen + 1, falseClose),
    };
}

function executeForStatement(statement, context, scope) {
    const headerOpen = statement.indexOf("(");
    const headerClose = findMatching(statement, headerOpen, "(", ")");
    const header = statement.slice(headerOpen + 1, headerClose);
    const bodyOpen = statement.indexOf("{", headerClose);
    const bodyClose = findMatching(statement, bodyOpen, "{", "}");
    const body = statement.slice(bodyOpen + 1, bodyClose);
    const parts = header.split(";").map((part) => part.trim());
    if (parts.length !== 3) {
        throw new Error(`Invalid for statement "${statement}"`);
    }

    const initMatch = parts[0].match(/^(?:let|num)\s+([A-Za-z_]\w*)\s*=\s*(.+)$/);
    if (!initMatch) {
        throw new Error(`Invalid for initializer "${parts[0]}"`);
    }

    const loopScope = {
        ...scope,
        [initMatch[1]]: evaluateExpression(initMatch[2], scope, context.componentsByName),
    };

    while (evaluateExpression(parts[1], loopScope, context.componentsByName)) {
        executeBlock(body, context, loopScope);

        const incrementMatch = parts[2].match(/^([A-Za-z_]\w*)(\+\+|--)$/);
        if (!incrementMatch) {
            throw new Error(`Invalid for increment "${parts[2]}"`);
        }

        loopScope[incrementMatch[1]] += incrementMatch[2] === "++" ? 1 : -1;
    }
}

function executeStatement(statement, context, scope = {}) {
    const {
        templates,
        moduleTemplates,
        components,
        componentsByName,
        modulesByName,
        nets,
        pinGroups,
        nameOverrides,
        netAliases,
    } = context;

    const valMatch = statement.match(/^val\s+([A-Za-z_]\w*)\s*=\s*(.+)$/);
    if (valMatch) {
        scope[valMatch[1]] = evaluateValueExpression(valMatch[2], scope, componentsByName);
        return;
    }

    const arrayPartMatch = statement.match(/^part\[(\d+)\]\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (arrayPartMatch) {
        const count = Number(arrayPartMatch[1]);
        const instanceName = arrayPartMatch[2];
        const templateName = arrayPartMatch[3];
        const params = evaluateArgumentList(arrayPartMatch[4], scope, componentsByName);
        const template = templates.get(templateName);
        if (!template) {
            throw new Error(`Unknown part "${templateName}"`);
        }
        if (componentsByName.has(instanceName)) {
            throw new Error(`Duplicate component "${instanceName}"`);
        }

        const instances = createComponentInstances(template, params, count)
            .map((component, index) => annotateComponent(component, instanceName, index, scope.__modulePath));
        componentsByName.set(instanceName, instances);
        components.push(...instances);
        return;
    }

    const partMatch = statement.match(/^(?:part\s+)?([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)(?:\s*\(([\s\S]*)\))?$/);
    if (partMatch) {
        const instanceName = partMatch[1];
        const templateName = partMatch[2];
        const params = evaluateArgumentList(partMatch[3] || "", scope, componentsByName);
        const template = templates.get(templateName);
        if (!template) {
            throw new Error(`Unknown part "${templateName}"`);
        }
        if (componentsByName.has(instanceName)) {
            throw new Error(`Duplicate component "${instanceName}"`);
        }

        const component = annotateComponent(createComponent(template, params), instanceName, undefined, scope.__modulePath);
        componentsByName.set(instanceName, component);
        components.push(component);
        return;
    }

    const moduleMatch = statement.match(/^mod\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (moduleMatch) {
        const instanceName = moduleMatch[1];
        const moduleName = moduleMatch[2];
        const moduleTemplate = moduleTemplates.get(moduleName);
        if (!moduleTemplate) {
            throw new Error(`Unknown module "${moduleName}"`);
        }
        if (modulesByName.has(instanceName) || componentsByName.has(instanceName)) {
            throw new Error(`Duplicate module "${instanceName}"`);
        }

        const argExpressions = splitTopLevelEntries(moduleMatch[3]);
        if (argExpressions.length > moduleTemplate.parameters.length) {
            throw new Error(`Too many arguments for module "${moduleName}"`);
        }
        const moduleScope = {};
        moduleTemplate.parameters.forEach((parameter, index) => {
            if (index < argExpressions.length) {
                moduleScope[parameter] = evaluateValueExpression(argExpressions[index], scope, componentsByName);
            }
        });
        const pathPrefix = `${scope.__pathPrefix || ""}${instanceName}_`;
        const moduleInstance = compileModule(moduleTemplate, context, {
            instanceName,
            pathPrefix,
            scope: {
                ...moduleScope,
                __modulePath: [...(scope.__modulePath || []), instanceName],
            },
        });
        modulesByName.set(instanceName, moduleInstance);
        return;
    }

    const voltageMatch = statement.match(/^([A-Za-z_]\w*)\.voltage\s*=\s*(.+)$/);
    if (voltageMatch) {
        const rail = nets[voltageMatch[1]];
        if (!rail || typeof rail !== "object") {
            throw new Error(`Unknown rail "${voltageMatch[1]}"`);
        }
        rail.voltage = parseValue(voltageMatch[2]);
        return;
    }

    const placeMatch = statement.match(/^([A-Za-z_]\w*)\.place\s*=\s*(true|false)$/);
    if (placeMatch) {
        const component = componentsByName.get(placeMatch[1]);
        if (!component) {
            throw new Error(`Unknown component "${placeMatch[1]}"`);
        }
        component.place = placeMatch[2] === "true";
        return;
    }

    const nameMatch = statement.match(/^(.+?)\.name\s*=\s*(.+)$/);
    if (nameMatch) {
        const endpoint = readEndpoint(nameMatch[1].trim(), componentsByName, nets, scope, modulesByName);
        if (endpoint && endpoint.type === "pin") {
            nameOverrides.set(endpoint.key, parseValue(nameMatch[2]));
        }
        return;
    }

    if (/^for\s*\(/.test(statement)) {
        executeForStatement(statement, context, scope);
        return;
    }

    if (/^if\s*\(/.test(statement)) {
        const parsed = parseIfStatement(statement);
        executeBlock(
            evaluateExpression(parsed.condition, scope, componentsByName)
                ? parsed.trueBody
                : parsed.falseBody,
            context,
            scope
        );
        return;
    }

    const bridgeMatch = statement.match(/^.+?\s*~>\s*.+$/);
    if (bridgeMatch) {
        connectBridge(statement, componentsByName, nets, pinGroups, nameOverrides, scope, modulesByName, netAliases);
        return;
    }

    const inlineNet = parseInlineNetDeclaration(statement);
    const connectionParts = splitConnectionChain(inlineNet ? `${inlineNet.name} ~ ${inlineNet.rest}` : statement);
    if (connectionParts) {
        const anchor = connectionParts[0];
        for (const endpoint of connectionParts.slice(1)) {
            connectEndpoints(
                anchor,
                endpoint,
                componentsByName,
                nets,
                pinGroups,
                nameOverrides,
                scope,
                modulesByName,
                netAliases
            );
        }
    }
}

class PinNetGroups {
    constructor() {
        this.parents = new Map();
        this.defaults = new Map();
        this.explicitNets = new Map();
        this.pins = new Map();
    }

    add(pin) {
        if (!this.parents.has(pin.key)) {
            this.parents.set(pin.key, pin.key);
            this.defaults.set(pin.key, pin.defaultNetName);
            this.pins.set(pin.key, pin.pin);
        }
    }

    find(key) {
        const parent = this.parents.get(key);
        if (parent === key) {
            return key;
        }

        const root = this.find(parent);
        this.parents.set(key, root);
        return root;
    }

    union(left, right, netAliases = new Map()) {
        function resolveAlias(name) {
            while (netAliases.has(name)) {
                name = netAliases.get(name);
            }
            return name;
        }

        this.add(left);
        this.add(right);
        const leftRoot = this.find(left.key);
        const rightRoot = this.find(right.key);

        if (leftRoot === rightRoot) {
            return;
        }

        const leftNet = this.explicitNets.get(leftRoot);
        const rightNet = this.explicitNets.get(rightRoot);
        const leftResolved = leftNet && resolveAlias(leftNet);
        const rightResolved = rightNet && resolveAlias(rightNet);
        if (leftResolved && rightResolved && leftResolved !== rightResolved) {
            throw new Error(`Connection joins nets "${leftResolved}" and "${rightResolved}"`);
        }

        this.parents.set(rightRoot, leftRoot);
        if (!this.defaults.has(leftRoot)) {
            this.defaults.set(leftRoot, left.defaultNetName);
        }
        if (!leftResolved && rightResolved) {
            this.explicitNets.set(leftRoot, rightResolved);
        }
    }

    connectExplicit(pin, netName, netAliases = new Map()) {
        function resolveAlias(name) {
            while (netAliases.has(name)) {
                name = netAliases.get(name);
            }
            return name;
        }

        this.add(pin);
        const root = this.find(pin.key);
        const resolvedNet = resolveAlias(isNetRef(netName) ? netName.value : netName);
        const existing = this.explicitNets.get(root);
        const resolvedExisting = existing && resolveAlias(existing);
        if (resolvedExisting && resolvedExisting !== resolvedNet) {
            throw new Error(`Pin "${pin.key}" connects to both "${resolvedExisting}" and "${resolvedNet}"`);
        }

        this.explicitNets.set(root, resolvedNet);
        setPinNet(pin.pin, resolvedNet);
    }

    groups() {
        const groups = new Map();
        for (const key of this.parents.keys()) {
            const root = this.find(key);
            if (!groups.has(root)) {
                groups.set(root, []);
            }
            groups.get(root).push(key);
        }
        return groups;
    }

    pinFor(key) {
        return this.pins.get(key);
    }
}

function setPinNet(pin, net) {
    if (!pin || typeof pin !== "object") {
        return;
    }

    pin.net = net;
    if (pin.pad !== undefined && pin.name !== undefined) {
        return;
    }

    for (const entry of Object.values(pin)) {
        setPinNet(entry, net);
    }
}

const NET_TYPE_SIGNALS = {
    i2c: ["SDA", "SCL"],
    uart: ["RX", "TX"],
    spi: ["MOSI", "MISO", "CLK"],
};

function normalizeNetType(type) {
    const normalized = String(type || "").trim().toLowerCase();
    if (!NET_TYPE_SIGNALS[normalized]) {
        throw new Error(`Unknown net type "${type}"`);
    }
    return normalized;
}

function netTypeSignals(type) {
    return NET_TYPE_SIGNALS[normalizeNetType(type)];
}

function createNetRef(value, isOverride = false, name = value) {
    return {
        __netRef: true,
        name,
        value,
        isOverride,
        aliasOf: undefined,
    };
}

function createNetGroup(name, type, signalNames, pathPrefix = "", nameOverrides = new Map()) {
    const group = {
        __netGroup: true,
        type,
    };
    const groupOverride = nameOverrides.get(name);

    for (const signalName of signalNames) {
        const key = `${name}.${signalName}`;
        const overrideName = nameOverrides.get(key);
        const baseName = groupOverride ? `${groupOverride}.${signalName}` : `${name}.${signalName}`;
        const finalName = overrideName ? `${pathPrefix}${overrideName}` : `${pathPrefix}${baseName}`;
        const ref = createNetRef(finalName, false, pathPrefix ? key : finalName);
        ref.group = name;
        ref.signal = signalName;
        group[signalName] = ref;
    }

    return group;
}

function isNetRef(value) {
    return Boolean(value && typeof value === "object" && value.__netRef);
}

function isNetGroup(value) {
    return Boolean(value && typeof value === "object" && value.__netGroup);
}

function isRailValue(value) {
    return Boolean(value
        && typeof value === "object"
        && !isNetRef(value)
        && !isNetGroup(value)
        && Object.prototype.hasOwnProperty.call(value, "h")
        && Object.prototype.hasOwnProperty.call(value, "l"));
}

function netRefName(value) {
    return isNetRef(value) ? value.value : value;
}

function rootNetRef(value) {
    while (isNetRef(value) && value.aliasOf) {
        value = value.aliasOf;
    }
    return value;
}

function isScopedNetRef(value) {
    const root = rootNetRef(value);
    return isNetRef(root) && root.name !== root.value;
}

function collectNetRefs(value, refs = [], seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
        return refs;
    }

    if (isNetRef(value)) {
        refs.push(value);
        return refs;
    }

    seen.add(value);
    for (const entry of Object.values(value)) {
        collectNetRefs(entry, refs, seen);
    }
    return refs;
}

function collectNetNames(nets) {
    return new Set(collectNetRefs(nets).map((net) => net.value));
}

function reserveNetName(preferred, usedNames, isOverride) {
    if (isOverride) {
        if (usedNames.has(preferred)) {
            throw new Error(`Duplicate net name "${preferred}"`);
        }
        usedNames.add(preferred);
        return preferred;
    }

    return uniqueNetName(preferred, usedNames);
}

function applyNetNames(declarations, nameOverrides, pathPrefix = "") {
    const usedNames = new Set();
    const nets = {};

    for (const declaration of declarations) {
        if (declaration.kind === "net" && !declaration.type) {
            const overrideName = nameOverrides.get(declaration.name);
            const finalName = overrideName ? `${pathPrefix}${overrideName}` : declaration.defaultName;
            if (usedNames.has(finalName)) {
                throw new Error(`Duplicate net name "${finalName}"`);
            }
            usedNames.add(finalName);
            nets[declaration.name] = createNetRef(
                finalName,
                !pathPrefix && (Boolean(overrideName) || Boolean(declaration.inlineAnchor)),
                pathPrefix ? declaration.name : finalName
            );
            continue;
        }

        if (declaration.kind === "rail") {
            const highKey = `${declaration.name}.h`;
            const lowKey = `${declaration.name}.l`;
            const highOverride = nameOverrides.get(highKey);
            const lowOverride = nameOverrides.get(lowKey);
            const highName = highOverride ? `${pathPrefix}${highOverride}` : declaration.defaultHigh;
            const lowName = lowOverride ? `${pathPrefix}${lowOverride}` : declaration.defaultLow;

            if (usedNames.has(highName)) {
                throw new Error(`Duplicate net name "${highName}"`);
            }
            usedNames.add(highName);

            if (usedNames.has(lowName)) {
                throw new Error(`Duplicate net name "${lowName}"`);
            }
            usedNames.add(lowName);

            nets[declaration.name] = {
                h: createNetRef(highName, !pathPrefix && Boolean(highOverride), pathPrefix ? highKey : highName),
                l: createNetRef(lowName, !pathPrefix && Boolean(lowOverride), pathPrefix ? lowKey : lowName),
                voltage: undefined,
            };
            continue;
        }

        if (declaration.kind !== "net" || !declaration.type) {
            throw new Error(`Unsupported declaration "${declaration.kind}"`);
        }

        const signalNames = netTypeSignals(declaration.type);
        const group = createNetGroup(declaration.name, declaration.type, signalNames, pathPrefix, nameOverrides);
        for (const signalName of signalNames) {
            const ref = group[signalName];
            if (usedNames.has(ref.value)) {
                throw new Error(`Duplicate net name "${ref.value}"`);
            }
            usedNames.add(ref.value);
        }
        nets[declaration.name] = group;
    }

    return nets;
}

function collectModuleDeclarations(statements, pathPrefix = "") {
    const declarations = [];
    const declarationNames = new Set();
    const provisionalNames = new Set();
    const nameOverrides = new Map();

    function addDeclaration(kind, type, name, inlineAnchor = false) {
        if (declarationNames.has(name)) {
            throw new Error(`Duplicate declaration "${name}"`);
        }
        declarationNames.add(name);

        if (kind === "net") {
            if (type) {
                declarations.push({
                    kind,
                    type: normalizeNetType(type),
                    name,
                    inlineAnchor,
                });
            } else {
                declarations.push({
                    kind,
                    name,
                    defaultName: uniqueNetName(`${pathPrefix}${name}`, provisionalNames),
                    inlineAnchor,
                });
            }
        } else {
            declarations.push({
                kind,
                name,
                defaultHigh: uniqueNetName(`${pathPrefix}${name}_h`, provisionalNames),
                defaultLow: uniqueNetName(`${pathPrefix}${name}_l`, provisionalNames),
            });
        }
    }

    for (const statement of statements) {
        const inlineNet = parseInlineNetDeclaration(statement);
        if (inlineNet) {
            addDeclaration("net", inlineNet.type, inlineNet.name, inlineNet.inlineAnchor);
            continue;
        }

        const declarationMatch = statement.match(/^(net(?:<([A-Za-z_]\w*)>)?|rail)\s+([A-Za-z_]\w*)$/);
        if (declarationMatch) {
            const kind = declarationMatch[1] === "rail" ? "rail" : "net";
            const type = declarationMatch[2];
            const name = declarationMatch[3];
            addDeclaration(kind, type, name);
            continue;
        }

        const nameMatch = statement.match(/^(.+?)\.name\s*=\s*(.+)$/);
        if (nameMatch) {
            nameOverrides.set(nameMatch[1].trim(), parseValue(nameMatch[2]));
        }
    }

    return { declarations, nameOverrides };
}

function compileModule(moduleTemplate, context, options = {}) {
    const statements = splitStatements(moduleTemplate.body);
    const pathPrefix = options.pathPrefix || "";
    let declarations;
    let nameOverrides;
    try {
        ({ declarations, nameOverrides } = collectModuleDeclarations(statements, pathPrefix));
    } catch (error) {
        throw attachSourceLocation(
            error,
            moduleTemplate.filePath,
            moduleTemplate.source || moduleTemplate.body,
            moduleTemplate.startIndex || 0
        );
    }
    for (const [key, value] of nameOverrides) {
        context.nameOverrides.set(key, value);
        context.nameOverrides.set(`${pathPrefix}${key}`, value);
    }
    let localNets;
    try {
        localNets = applyNetNames(declarations, nameOverrides, pathPrefix);
    } catch (error) {
        throw attachSourceLocation(
            error,
            moduleTemplate.filePath,
            moduleTemplate.source || moduleTemplate.body,
            moduleTemplate.startIndex || 0
        );
    }
    context.netScopes.push(localNets);
    const localContext = {
        ...context,
        componentsByName: new Map(),
        modulesByName: new Map(),
        nets: localNets,
        nameOverrides,
    };
    const scope = {
        ...(options.scope || {}),
        __pathPrefix: pathPrefix,
    };

    for (const statement of statements) {
        try {
            executeStatement(statement, localContext, scope);
        } catch (error) {
            const statementIndex = moduleTemplate.body.indexOf(statement);
            const locationIndex = statementIndex >= 0
                ? moduleTemplate.bodyStart + statementIndex
                : moduleTemplate.startIndex || 0;
            throw attachSourceLocation(
                error,
                moduleTemplate.filePath,
                moduleTemplate.source || moduleTemplate.body,
                locationIndex,
                statement
            );
        }
    }

    return {
        __module: true,
        name: moduleTemplate.name,
        instanceName: options.instanceName,
        pathPrefix,
        nets: localContext.nets,
    };
}

function snapshotNetValue(value) {
    if (isNetRef(value)) {
        return value.value;
    }

    if (isNetGroup(value)) {
        const snapshot = { type: value.type };
        for (const signalName of netTypeSignals(value.type)) {
            snapshot[signalName] = snapshotNetValue(value[signalName]);
        }
        return snapshot;
    }

    if (isRailValue(value)) {
        return {
            h: snapshotNetValue(value.h),
            l: snapshotNetValue(value.l),
            voltage: value.voltage,
        };
    }

    return value;
}

function finalizeCompilation(context, topModule) {
    const { pinGroups, nameOverrides, components } = context;
    const usedNames = new Set();
    const compiledNets = {};
    for (const nets of context.netScopes) {
        for (const name of collectNetNames(nets)) {
            usedNames.add(name);
        }
        for (const [name, value] of Object.entries(nets)) {
            compiledNets[name] = snapshotNetValue(value);
        }
    }
    const implicitNets = {};
    function resolveAlias(netName) {
        while (context.netAliases.has(netName)) {
            netName = context.netAliases.get(netName);
        }
        return netName;
    }
    for (const [root, pinKeys] of pinGroups.groups()) {
        const explicitNet = pinGroups.explicitNets.get(root);
        if (explicitNet) {
            const finalExplicitNet = resolveAlias(explicitNet);
            for (const pinKey of pinKeys) {
                setPinNet(pinGroups.pinFor(pinKey), finalExplicitNet);
            }
            continue;
        }

        const overrideNames = pinKeys
            .map((pinKey) => nameOverrides.get(pinKey))
            .filter((name) => name !== undefined);
        const uniqueOverrides = [...new Set(overrideNames)];
        if (uniqueOverrides.length > 1) {
            throw new Error(`Implicit net has multiple names: ${uniqueOverrides.join(", ")}`);
        }

        const netName = reserveNetName(
            uniqueOverrides[0] || pinGroups.defaults.get(root),
            usedNames,
            uniqueOverrides.length === 1
        );

        implicitNets[netName] = netName;
        for (const pinKey of pinKeys) {
            setPinNet(pinGroups.pinFor(pinKey), netName);
        }
    }

    function rewritePinNets(value) {
        if (!value || typeof value !== "object") {
            return;
        }

        if (Object.prototype.hasOwnProperty.call(value, "net")) {
            value.net = resolveAlias(value.net && value.net.value ? value.net.value : value.net);
            return;
        }

        for (const entry of Object.values(value)) {
            rewritePinNets(entry);
        }
    }

    for (const component of components) {
        rewritePinNets(component.pins);
    }

    return {
        netList: usedNames,
        components,
        modules: topModule ? [topModule] : [],
        nets: {
            ...compiledNets,
            ...implicitNets,
        },
    };
}

function step1(filePath) {
    return executeStep1JavaScript(filePath);
}

function jsString(value) {
    return JSON.stringify(value);
}

function renderValue(value, indent = 0) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return renderObjectLiteral(value, indent);
    }

    return jsString(value);
}

function renderObjectLiteral(object, indent = 0) {
    const padding = " ".repeat(indent);
    const innerPadding = " ".repeat(indent + 4);
    const entries = Object.entries(object)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => {
            const renderedValue = renderValue(value, indent + 4);
            return `${innerPadding}${JSON.stringify(key)}: ${renderedValue}`;
        });

    if (entries.length === 0) {
        return "{}";
    }

    return `{\n${entries.join(",\n")}\n${padding}}`;
}

function pinProperty(name) {
    return /^\d+$/.test(String(name)) ? `[${name}]` : `.${name}`;
}

function renderPinTemplateAssignments(pins, target, indent = "        ", indexed = false) {
    const lines = [];
    for (const pin of pins) {
        if (pin.group) {
            const property = pinProperty(pin.name);
            lines.push(`${indent}${target}${property} = ${pin.objectGroup ? "{}" : "[]"};`);
            if (pin.rail) {
                lines.push(`${indent}${target}${property}.__pinRail = true;`);
            }
            if (pin.netGroupType) {
                lines.push(`${indent}${target}${property}.__pinNetGroup = true;`);
                lines.push(`${indent}${target}${property}.type = ${jsString(pin.netGroupType)};`);
            }
            lines.push(...renderPinTemplateAssignments(pin.group, `${target}${property}`, indent, !pin.objectGroup));
            continue;
        }

        const property = pinProperty(pin.name);
        const pinValue = renderObjectLiteral({
            name: pin.name,
            pad: pin.pad,
            net: "",
        }, indent.length);

        if (indexed) {
            lines.push(`${indent}${target}.push(${pinValue});`);
            if (!/^\d+$/.test(pin.name)) {
                lines.push(`${indent}${target}${property} = ${target}[${target}.length - 1];`);
            }
        } else {
            lines.push(`${indent}${target}${property} = ${pinValue};`);
        }
    }
    return lines;
}

function renderPartJavaScript(template) {
    return `class ${template.name} {\n` +
        `    constructor() {\n` +
        `        this.info = ${renderObjectLiteral(template.info, 8)};\n` +
        `        this.pins = [];\n` +
        `${renderPinTemplateAssignments(template.pins, "this.pins").join("\n")}\n` +
        `    }\n` +
        `}\n\n` +
        `module.exports = ${template.name};\n`;
}

function collectTopDeclarations(statements) {
    const declarations = [];
    const declarationNames = new Set();
    const provisionalNames = new Set();
    const nameOverrides = new Map();

    function addDeclaration(declaration) {
        const { kind, type, name } = declaration;
        if (declarationNames.has(name)) {
            throw new Error(`Duplicate declaration "${name}"`);
        }
        declarationNames.add(name);

        if (kind === "net") {
            if (type) {
                declarations.push({
                    kind,
                    type,
                    name,
                    inlineAnchor: declaration.inlineAnchor,
                });
                return;
            }

            declarations.push({
                kind,
                name,
                defaultName: uniqueNetName(name, provisionalNames),
                inlineAnchor: declaration.inlineAnchor,
            });
        } else {
            declarations.push({
                kind,
                name,
                defaultHigh: uniqueNetName(`${name}_h`, provisionalNames),
                defaultLow: uniqueNetName(`${name}_l`, provisionalNames),
            });
        }
    }

    for (const statement of statements) {
        const inlineNet = parseInlineNetDeclaration(statement);
        if (inlineNet) {
            addDeclaration(inlineNet);
            continue;
        }

        const declaration = parseNetDeclaration(statement);
        if (declaration) {
            addDeclaration(declaration);
            continue;
        }

        const nameMatch = statement.match(/^(.+?)\.name\s*=\s*(.+)$/);
        if (nameMatch) {
            nameOverrides.set(nameMatch[1].trim(), parseValue(nameMatch[2]));
        }
    }

    return { declarations, nameOverrides };
}

function parseNetDeclaration(statement) {
    const match = statement.match(/^(net(?:<([A-Za-z_]\w*)>)?|rail)\s+([A-Za-z_]\w*)$/);
    if (!match) {
        return undefined;
    }

    return {
        kind: match[1] === "rail" ? "rail" : "net",
        type: match[2] ? normalizeNetType(match[2]) : undefined,
        name: match[3],
    };
}

function primitiveIncludeFileName(name) {
    return `${name.toLowerCase()}.js`;
}

function primitiveNamesInSource(source, includeNames = new Set()) {
    return [...source.matchAll(/\bnew\s+([A-Za-z_]\w*)\s*\(/g)]
        .map((match) => match[1])
        .filter((name) => createPrimitiveTemplates().has(name) && !includeNames.has(name));
}

function primitiveNamesInModules(modules, includeNames = new Set()) {
    const names = new Set();
    for (const module of modules) {
        for (const name of primitiveNamesInSource(module.body, includeNames)) {
            names.add(name);
        }
    }
    return [...names];
}

function renderConstructorArgs(args) {
    const params = parseConstructorArgExpressions(args || "");
    const entries = Object.entries(params);
    if (!entries.length) {
        return "";
    }

    return `{\n${entries.map(([key, value]) => `        ${JSON.stringify(key)}: ${renderValueExpression(value)}`).join(",\n")}\n    }`;
}

function renderComponentConstructor(templateName, args) {
    const params = renderConstructorArgs(args);
    return params ? `new ${templateName}(${params})` : `new ${templateName}()`;
}

function renderValueExpression(expression) {
    const trimmed = expression.trim();
    const quoted = trimmed.match(/^["'](.*)["']$/);
    if (quoted || trimmed.includes("+/-")) {
        return jsString(parseValue(trimmed));
    }

    return normalizeValueExpression(trimmed);
}

function componentReferenceParts(expression) {
    const value = expression.trim();
    const arrayMatch = value.match(/^([A-Za-z_]\w*)\[(.+)\]$/);
    if (arrayMatch) {
        return {
            componentExpression: `${arrayMatch[1]}[${arrayMatch[2]}]`,
            componentNameExpression: `${jsString(`${arrayMatch[1]}_`)} + (${arrayMatch[2]})`,
        };
    }

    return {
        componentExpression: value,
        componentNameExpression: jsString(value),
    };
}

function renderPinPathParts(pathExpression) {
    const parts = [];
    let rest = pathExpression;

    while (rest) {
        if (rest[0] === ".") {
            const match = rest.match(/^\.([A-Za-z_]\w*|\d+)/);
            if (!match) {
                return undefined;
            }
            parts.push(jsString(match[1]));
            rest = rest.slice(match[0].length);
            continue;
        }

        if (rest[0] === "[") {
            const closeIndex = findMatching(rest, 0, "[", "]");
            parts.push(rest.slice(1, closeIndex));
            rest = rest.slice(closeIndex + 1);
            continue;
        }

        return undefined;
    }

    return parts;
}

function renderPinEndpoint(expression) {
    const value = expression.trim();
    const nameMatch = value.match(/^([A-Za-z_]\w*)/);
    if (!nameMatch) {
        return undefined;
    }

    const name = nameMatch[1];
    let rest = value.slice(name.length);
    let componentExpression = name;
    let componentNameExpression = jsString(name);

    if (rest.startsWith("[")) {
        const closeIndex = findMatching(rest, 0, "[", "]");
        const indexExpression = rest.slice(1, closeIndex);
        const afterIndex = rest.slice(closeIndex + 1);
        if (!afterIndex) {
            return `__pin(${name}, [${indexExpression}], ${jsString(`${name}_`)} + (${indexExpression}))`;
        }

        componentExpression = `${name}[${indexExpression}]`;
        componentNameExpression = `${jsString(`${name}_`)} + (${indexExpression})`;
        rest = afterIndex;
    }

    if (!rest) {
        return undefined;
    }

    const pathParts = renderPinPathParts(rest);
    if (!pathParts || !pathParts.length) {
        return undefined;
    }

    const defaultNameExpression = pathParts.reduce(
        (expression, part) => `${expression} + ${jsString("_")} + (${part})`,
        componentNameExpression
    );
    return `__pin(${componentExpression}, [${pathParts.join(", ")}], ${defaultNameExpression})`;
}

function renderEndpoint(expression, context) {
    const value = expression.trim();
    const railMatch = value.match(/^([A-Za-z_]\w*)\.(h|l)$/);
    const groupMatch = value.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
    const moduleEndpointMatch = value.match(/^([A-Za-z_]\w*)\./);
    if (groupMatch && context.netGroups && context.netGroups.has(groupMatch[1])) {
        return `__net(${value})`;
    }
    if (moduleEndpointMatch && context.moduleNames && context.moduleNames.has(moduleEndpointMatch[1])) {
        return `__net(${value})`;
    }
    if (context.netNames.has(value) || context.netNames.has(expression.trim()) || /^[A-Za-z_]\w*$/.test(value) && context.netNames.has(value)) {
        return `__net(${value})`;
    }
    if (railMatch && context.railNames.has(railMatch[1])) {
        return `__net(${value})`;
    }

    return renderPinEndpoint(expression) || `__net(${expression.trim()})`;
}

function renderBridgeEndpoint(expression, pinIndex) {
    const component = componentReferenceParts(expression);
    return `__bridgePin(${component.componentExpression}, ${pinIndex}, ${component.componentNameExpression})`;
}

function indentLines(source, spaces) {
    const padding = " ".repeat(spaces);
    return source.split("\n").map((line) => line ? `${padding}${line}` : line).join("\n");
}

function renderStatements(statements, indent = 4, context = { netNames: new Set(), railNames: new Set() }) {
    const lines = [];
    const nextContext = {
        ...context,
        moduleNames: context.moduleNames || new Set(),
    };
    for (const statement of statements) {
        lines.push(...renderStatement(statement, indent, nextContext));
    }
    return lines;
}

function renderStatement(statement, indent = 4, context = { netNames: new Set(), railNames: new Set() }) {
    const padding = " ".repeat(indent);

    if (parseNetDeclaration(statement)) {
        return [];
    }

    const nameMatch = statement.match(/^(.+?)\.name\s*=\s*(.+)$/);
    if (nameMatch) {
        const target = nameMatch[1].trim();
        const railMatch = target.match(/^([A-Za-z_]\w*)\.(h|l)$/);
        if (context.netNames.has(target) || (railMatch && context.railNames.has(railMatch[1]))) {
            return [];
        }

        return [`${padding}__setNameOverride(${renderEndpoint(target, context)}, ${renderValueExpression(nameMatch[2])});`];
    }

    const valMatch = statement.match(/^val\s+([A-Za-z_]\w*)\s*=\s*(.+)$/);
    if (valMatch) {
        return [`${padding}const ${valMatch[1]} = ${renderValueExpression(valMatch[2])};`];
    }

    const arrayPartMatch = statement.match(/^part\[(\d+)\]\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (arrayPartMatch) {
        return [`${padding}const ${arrayPartMatch[2]} = __componentArray(${jsString(arrayPartMatch[2])}, ${arrayPartMatch[1]}, () => ${renderComponentConstructor(arrayPartMatch[3], arrayPartMatch[4])});`];
    }

    const partMatch = statement.match(/^(?:part\s+)?([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)(?:\s*\(([\s\S]*)\))?$/);
    if (partMatch) {
        return [`${padding}const ${partMatch[1]} = __component(${jsString(partMatch[1])}, () => ${renderComponentConstructor(partMatch[2], partMatch[3] || "")});`];
    }

    const moduleMatch = statement.match(/^mod\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (moduleMatch) {
        const args = splitTopLevelEntries(moduleMatch[3]).map(renderValueExpression).join(", ");
        context.moduleNames.add(moduleMatch[1]);
        return [`${padding}const ${moduleMatch[1]} = __module(${jsString(moduleMatch[1])}, () => ${moduleMatch[2]}(${args}));`];
    }

    const voltageMatch = statement.match(/^([A-Za-z_]\w*)\.voltage\s*=\s*(.+)$/);
    if (voltageMatch) {
        return [`${padding}${voltageMatch[1]}.voltage = ${jsString(parseValue(voltageMatch[2]))};`];
    }

    const placeMatch = statement.match(/^([A-Za-z_]\w*)\.place\s*=\s*(true|false)$/);
    if (placeMatch) {
        return [`${padding}${placeMatch[1]}.place = ${placeMatch[2]};`];
    }

    if (/^for\s*\(/.test(statement)) {
        const headerOpen = statement.indexOf("(");
        const headerClose = findMatching(statement, headerOpen, "(", ")");
        const header = statement.slice(headerOpen + 1, headerClose).replace(/^\s*num\b/, "let");
        const bodyOpen = statement.indexOf("{", headerClose);
        const bodyClose = findMatching(statement, bodyOpen, "{", "}");
        const bodyStatements = splitStatements(statement.slice(bodyOpen + 1, bodyClose));
        return [
            `${padding}for (${header}) {`,
            ...renderStatements(bodyStatements, indent + 4, context),
            `${padding}}`,
        ];
    }

    if (/^if\s*\(/.test(statement)) {
        const parsed = parseIfStatement(statement);
        const lines = [
            `${padding}if (${parsed.condition}) {`,
            ...renderStatements(splitStatements(parsed.trueBody), indent + 4, context),
            `${padding}}`,
        ];
        if (parsed.falseBody) {
            lines[lines.length - 1] = `${padding}} else {`;
            lines.push(...renderStatements(splitStatements(parsed.falseBody), indent + 4, context));
            lines.push(`${padding}}`);
        }
        return lines;
    }

    if (/^.+?\s*~>\s*.+$/.test(statement)) {
        const parts = statement.split("~>").map((part) => part.trim()).filter(Boolean);
        const middleComponents = parts.slice(1, -1);
        const lines = [
            `${padding}__connect(${renderEndpoint(parts[0], context)}, ${renderBridgeEndpoint(middleComponents[0], 0)});`,
        ];
        for (let i = 0; i < middleComponents.length - 1; i++) {
            lines.push(`${padding}__connect(${renderBridgeEndpoint(middleComponents[i], 1)}, ${renderBridgeEndpoint(middleComponents[i + 1], 0)});`);
        }
        lines.push(`${padding}__connect(${renderBridgeEndpoint(middleComponents[middleComponents.length - 1], 1)}, ${renderEndpoint(parts[parts.length - 1], context)});`);
        return lines;
    }

    const inlineNet = parseInlineNetDeclaration(statement);
    const connectionParts = splitConnectionChain(inlineNet ? `${inlineNet.name} ~ ${inlineNet.rest}` : statement);
    if (connectionParts) {
        const anchor = connectionParts[0];
        return connectionParts.slice(1).map((endpoint) => (
            `${padding}__connect(${renderEndpoint(anchor, context)}, ${renderEndpoint(endpoint, context)});`
        ));
    }

    return [`${padding}${statement};`];
}

function renderRuntimeHelpers() {
    return `    const components = [];\n` +
        `    const nets = {};\n` +
        `    const nameOverrides = new Map();\n` +
        `    const pinGroups = new Map();\n` +
        `    const explicitNets = new Map();\n` +
        `    const netAliases = new Map();\n` +
        `    const pinsByKey = new Map();\n` +
        `    const scopeStack = [];\n` +
        `    const modulePathStack = [];\n` +
        `    const netTypeSignals = ${jsString(NET_TYPE_SIGNALS)};\n` +
        `\n` +
        `    function __val(number, unit = "") {\n` +
        `        return {\n` +
        `            number,\n` +
        `            unit,\n` +
        `            valueOf() { return this.number; },\n` +
        `            toString() { return String(this.number) + this.unit; },\n` +
        `        };\n` +
        `    }\n` +
        `\n` +
        `    function __scopeName(name) {\n` +
        `        return scopeStack.join("") + name;\n` +
        `    }\n` +
        `\n` +
        `    function __module(instanceName, factory) {\n` +
        `        scopeStack.push(instanceName + "_");\n` +
        `        modulePathStack.push(instanceName);\n` +
        `        try {\n` +
        `            return factory();\n` +
        `        } finally {\n` +
        `            modulePathStack.pop();\n` +
        `            scopeStack.pop();\n` +
        `        }\n` +
        `    }\n` +
        `\n` +
        `    function __netRef(name, value, isOverride = false) {\n` +
        `        return { __netRef: true, name, value, isOverride };\n` +
        `    }\n` +
        `\n` +
        `    function __declareNet(name, value, isOverride = false, refName = name) {\n` +
        `        const ref = __netRef(refName, value, isOverride);\n` +
        `        nets[__scopeName(name)] = ref;\n` +
        `        return ref;\n` +
        `    }\n` +
        `\n` +
        `    function __declareNetGroup(name, type, baseName = name) {\n` +
        `        const scopedName = __scopeName(name);\n` +
        `        const group = {\n` +
        `            __netGroup: true,\n` +
        `            type,\n` +
        `        };\n` +
        `        for (const signalName of netTypeSignals[type]) {\n` +
        `            const scopedSignalName = __scopeName(baseName + "." + signalName);\n` +
        `            group[signalName] = __netRef(scopedSignalName, scopedSignalName, false);\n` +
        `            group[signalName].group = scopedName;\n` +
        `            group[signalName].signal = signalName;\n` +
        `        }\n` +
        `        nets[scopedName] = group;\n` +
        `        return group;\n` +
        `    }\n` +
        `\n` +
        `    function __declareRail(name, high, low, highOverride = false, lowOverride = false, isTopLevel = false) {\n` +
        `        const rail = {\n` +
        `            h: __netRef(isTopLevel ? high : name + ".h", high, highOverride),\n` +
        `            l: __netRef(isTopLevel ? low : name + ".l", low, lowOverride),\n` +
        `            voltage: undefined,\n` +
        `        };\n` +
        `        nets[__scopeName(name)] = rail;\n` +
        `        return rail;\n` +
        `    }\n` +
        `\n` +
        `    function __annotateComponent(component, name, index) {\n` +
        `        component.__schrune = {\n` +
        `            ...(component.__schrune || {}),\n` +
        `            name,\n` +
        `            arrayIndex: index,\n` +
        `            modulePath: [...modulePathStack],\n` +
        `            moduleName: modulePathStack.join(\".\"),\n` +
        `        };\n` +
        `        return component;\n` +
        `    }\n` +
        `\n` +
        `    function __component(name, factory) {\n` +
        `        const component = factory();\n` +
        `        __annotateComponent(component, name);\n` +
        `        components.push(component);\n` +
        `        return component;\n` +
        `    }\n` +
        `\n` +
        `    function __componentArray(name, count, factory) {\n` +
        `        const values = Array.from({ length: count }, (_value, index) => __annotateComponent(factory(), name, index));\n` +
        `        components.push(...values);\n` +
        `        return values;\n` +
        `    }\n` +
        `\n` +
        `    function __setNameOverride(endpoint, value) {\n` +
        `        if (!endpoint || endpoint.type !== "pin") {\n` +
        `            return;\n` +
        `        }\n` +
        `        nameOverrides.set(endpoint.key, value);\n` +
        `    }\n` +
        `\n` +
        `    function __net(ref) {\n` +
        `        return { type: "net", ref };\n` +
        `    }\n` +
        `\n` +
        `    function __rootNetRef(ref) {\n` +
        `        while (ref.aliasOf) {\n` +
        `            ref = ref.aliasOf;\n` +
        `        }\n` +
        `        return ref;\n` +
        `    }\n` +
        `\n` +
        `    function __isScopedNetRef(ref) {\n` +
        `        const root = __rootNetRef(ref);\n` +
        `        return Boolean(root && root.name !== root.value);\n` +
        `    }\n` +
        `\n` +
        `    function __isNamedNetRef(ref) {\n` +
        `        const root = __rootNetRef(ref);\n` +
        `        return Boolean(root && root.isOverride && !__isScopedNetRef(root));\n` +
        `    }\n` +
        `\n` +
        `    function __pin(component, path, defaultNetName) {\n` +
        `        let pin = component.pins;\n` +
        `        for (const part of path) {\n` +
        `            pin = pin[part];\n` +
        `        }\n` +
        `        const scopedDefaultNetName = __scopeName(defaultNetName);\n` +
        `        return { type: "pin", pin, key: scopedDefaultNetName, defaultNetName: scopedDefaultNetName };\n` +
        `    }\n` +
        `\n` +
        `    function __leafPinPaths(value, path = [], paths = []) {\n` +
        `        if (!value || typeof value !== "object") {\n` +
        `            return paths;\n` +
        `        }\n` +
        `        if (value.pad !== undefined && value.name !== undefined) {\n` +
        `            paths.push(path);\n` +
        `            return paths;\n` +
        `        }\n` +
        `        for (const [key, entry] of Object.entries(value)) {\n` +
        `            if (key.startsWith("__")) {\n` +
        `                continue;\n` +
        `            }\n` +
        `            __leafPinPaths(entry, [...path, /^\\d+$/.test(key) ? Number(key) : key], paths);\n` +
        `        }\n` +
        `        return paths;\n` +
        `    }\n` +
        `\n` +
        `    function __bridgePin(component, index, componentNameExpression) {\n` +
        `        const paths = __leafPinPaths(component.pins);\n` +
        `        if (paths.length !== 2) {\n` +
        `            throw new Error(\`Bridge middle "\${componentNameExpression}" must be a component with 2 pins\`);\n` +
        `        }\n` +
        `        const path = paths[index];\n` +
        `        if (!path) {\n` +
        `            throw new Error(\`Bridge middle "\${componentNameExpression}" must be a component with 2 pins\`);\n` +
        `        }\n` +
        `        return __pin(component, path, componentNameExpression + "_" + path.map((part) => String(part)).join("_"));\n` +
        `    }\n` +
        `\n` +
        `    function __setPinNet(pin, net) {\n` +
        `        if (!pin || typeof pin !== "object") {\n` +
        `            return;\n` +
        `        }\n` +
        `        pin.net = net;\n` +
        `        if (pin.pad !== undefined && pin.name !== undefined) {\n` +
        `            return;\n` +
        `        }\n` +
        `        for (const entry of Object.values(pin)) {\n` +
        `            __setPinNet(entry, net);\n` +
        `        }\n` +
        `    }\n` +
        `\n` +
        `    function __find(key) {\n` +
        `        const parent = pinGroups.get(key);\n` +
        `        if (parent === key) {\n` +
        `            return key;\n` +
        `        }\n` +
        `        const root = __find(parent);\n` +
        `        pinGroups.set(key, root);\n` +
        `        return root;\n` +
        `    }\n` +
        `\n` +
        `    function __addPin(endpoint) {\n` +
        `        if (!pinGroups.has(endpoint.key)) {\n` +
        `            pinGroups.set(endpoint.key, endpoint.key);\n` +
        `            pinsByKey.set(endpoint.key, endpoint);\n` +
        `        }\n` +
        `    }\n` +
        `\n` +
        `    function __connect(left, right) {\n` +
        `        const resolveAlias = (name) => {\n` +
        `            while (netAliases.has(name)) {\n` +
        `                name = netAliases.get(name);\n` +
        `            }\n` +
        `            return name;\n` +
        `        };\n` +
        `\n` +
        `        const leftRail = left.type === "net" ? (!left.ref.__netRef && !left.ref.__netGroup && left.ref.h && left.ref.l) : Boolean(left.pin && left.pin.__pinRail);\n` +
        `        const rightRail = right.type === "net" ? (!right.ref.__netRef && !right.ref.__netGroup && right.ref.h && right.ref.l) : Boolean(right.pin && right.pin.__pinRail);\n` +
        `        if (leftRail || rightRail) {\n` +
        `            if (!leftRail || !rightRail) {\n` +
        `                throw new Error("Connection joins rail and net");\n` +
        `            }\n` +
        `            __connect(left.type === "net" ? __net(left.ref.h) : { ...left, pin: left.pin.h, key: left.defaultNetName + "_h", defaultNetName: left.defaultNetName + "_h" }, right.type === "net" ? __net(right.ref.h) : { ...right, pin: right.pin.h, key: right.defaultNetName + "_h", defaultNetName: right.defaultNetName + "_h" });\n` +
        `            __connect(left.type === "net" ? __net(left.ref.l) : { ...left, pin: left.pin.l, key: left.defaultNetName + "_l", defaultNetName: left.defaultNetName + "_l" }, right.type === "net" ? __net(right.ref.l) : { ...right, pin: right.pin.l, key: right.defaultNetName + "_l", defaultNetName: right.defaultNetName + "_l" });\n` +
        `            return;\n` +
        `        }\n` +
        `        const leftNetGroup = left.type === "net" ? Boolean(left.ref.__netGroup) : Boolean(left.pin && left.pin.__pinNetGroup);\n` +
        `        const rightNetGroup = right.type === "net" ? Boolean(right.ref.__netGroup) : Boolean(right.pin && right.pin.__pinNetGroup);\n` +
        `        if (leftNetGroup || rightNetGroup) {\n` +
        `            if (!leftNetGroup || !rightNetGroup) {\n` +
        `                throw new Error("Connection joins net group and net");\n` +
        `            }\n` +
        `            const leftType = left.type === "net" ? left.ref.type : left.pin.type;\n` +
        `            const rightType = right.type === "net" ? right.ref.type : right.pin.type;\n` +
        `            if (leftType !== rightType) {\n` +
        `                throw new Error(\`Connection joins net groups of different types "\${leftType}" and "\${rightType}"\`);\n` +
        `            }\n` +
        `            for (const signalName of netTypeSignals[leftType]) {\n` +
        `                __connect(left.type === "net" ? __net(left.ref[signalName]) : { ...left, pin: left.pin[signalName], key: left.defaultNetName + "_" + signalName, defaultNetName: left.defaultNetName + "_" + signalName }, right.type === "net" ? __net(right.ref[signalName]) : { ...right, pin: right.pin[signalName], key: right.defaultNetName + "_" + signalName, defaultNetName: right.defaultNetName + "_" + signalName });\n` +
        `            }\n` +
        `            return;\n` +
        `        }\n` +
        `        if (left.type === "net" && right.type === "net") {\n` +
        `            if (left.ref.__netGroup || right.ref.__netGroup) {\n` +
        `                if (!left.ref.__netGroup || !right.ref.__netGroup) {\n` +
        `                    throw new Error("Connection joins net group and net");\n` +
        `                }\n` +
        `                if (left.ref.type !== right.ref.type) {\n` +
        `                    throw new Error(\`Connection joins net groups of different types "\${left.ref.type}" and "\${right.ref.type}"\`);\n` +
        `                }\n` +
        `                for (const signalName of netTypeSignals[left.ref.type]) {\n` +
        `                    __connect(__net(left.ref[signalName]), __net(right.ref[signalName]));\n` +
        `                }\n` +
        `                return;\n` +
        `            }\n` +
        `            if (!left.ref.__netRef || !right.ref.__netRef) {\n` +
        `                if (left.ref.__netRef || right.ref.__netRef) {\n` +
        `                    throw new Error("Connection joins rail and net");\n` +
        `                }\n` +
        `                __connect(__net(left.ref.h), __net(right.ref.h));\n` +
        `                __connect(__net(left.ref.l), __net(right.ref.l));\n` +
        `                return;\n` +
        `            }\n` +
        `            const leftRoot = __rootNetRef(left.ref);\n` +
        `            const rightRoot = __rootNetRef(right.ref);\n` +
        `            if (leftRoot.value === rightRoot.value) {\n` +
        `                return;\n` +
        `            }\n` +
        `            if (__isNamedNetRef(left.ref) && __isNamedNetRef(right.ref)) {\n` +
        `                throw new Error(\`Connection joins nets "\${leftRoot.value}" and "\${rightRoot.value}"\`);\n` +
        `            }\n` +
        `            if (__isNamedNetRef(left.ref)) {\n` +
        `                netAliases.set(rightRoot.value, leftRoot.value);\n` +
        `                right.ref.value = leftRoot.value;\n` +
        `                right.ref.aliasOf = leftRoot;\n` +
        `            } else {\n` +
        `                netAliases.set(leftRoot.value, rightRoot.value);\n` +
        `                left.ref.value = rightRoot.value;\n` +
        `                left.ref.aliasOf = rightRoot;\n` +
        `            }\n` +
        `            return;\n` +
        `        }\n` +
        `        if (left.type === "pin" && right.type === "pin") {\n` +
        `            __addPin(left);\n` +
        `            __addPin(right);\n` +
        `            const leftRoot = __find(left.key);\n` +
        `            const rightRoot = __find(right.key);\n` +
        `            if (leftRoot !== rightRoot) {\n` +
        `                const leftNet = explicitNets.get(leftRoot);\n` +
        `                const rightNet = explicitNets.get(rightRoot);\n` +
        `                const leftResolved = leftNet && resolveAlias(leftNet);\n` +
        `                const rightResolved = rightNet && resolveAlias(rightNet);\n` +
        `                if (leftResolved && rightResolved && leftResolved !== rightResolved) {\n` +
        `                    throw new Error(\`Connection joins nets "\${leftResolved}" and "\${rightResolved}"\`);\n` +
        `                }\n` +
        `                pinGroups.set(rightRoot, leftRoot);\n` +
        `                if (!leftResolved && rightResolved) {\n` +
        `                    explicitNets.set(leftRoot, rightResolved);\n` +
        `                }\n` +
        `            }\n` +
        `            return;\n` +
        `        }\n` +
        `        const pin = left.type === "pin" ? left : right;\n` +
        `        const net = left.type === "net" ? left.ref.value : right.ref.value;\n` +
        `        __addPin(pin);\n` +
        `        const root = __find(pin.key);\n` +
        `        const existing = explicitNets.get(root);\n` +
        `        const resolvedNet = resolveAlias(net);\n` +
        `        const resolvedExisting = existing && resolveAlias(existing);\n` +
        `        if (resolvedExisting && resolvedExisting !== resolvedNet) {\n` +
        `            throw new Error(\`Pin "\${pin.key}" connects to both "\${resolvedExisting}" and "\${resolvedNet}"\`);\n` +
        `        }\n` +
        `        explicitNets.set(root, resolvedNet);\n` +
        `        __setPinNet(pin.pin, resolvedNet);\n` +
        `    }\n` +
        `\n` +
        `    function __reserveNetName(preferred, usedNames, isOverride) {\n` +
        `        if (isOverride) {\n` +
        `            if (usedNames.has(preferred)) {\n` +
        `                throw new Error(\`Duplicate net name "\${preferred}"\`);\n` +
        `            }\n` +
        `            usedNames.add(preferred);\n` +
        `            return preferred;\n` +
        `        }\n` +
        `        let name = preferred;\n` +
        `        let index = 1;\n` +
        `        while (usedNames.has(name)) {\n` +
        `            name = preferred + "_" + index;\n` +
        `            index++;\n` +
        `        }\n` +
        `        usedNames.add(name);\n` +
        `        return name;\n` +
        `    }\n` +
        `\n` +
        `    function __finalize() {\n` +
        `        const netList = new Set();\n` +
        `        const usedNames = new Set();\n` +
        `        const usedNetRoots = new Map();\n` +
        `        const compiledNets = {};\n` +
        `        function resolveAlias(name) {\n` +
        `            while (netAliases.has(name)) {\n` +
        `                name = netAliases.get(name);\n` +
        `            }\n` +
        `            return name;\n` +
        `        }\n` +
        `        function addNetName(ref) {\n` +
        `            const root = __rootNetRef(ref);\n` +
        `            if (usedNames.has(ref.value) && usedNetRoots.get(ref.value) !== root) {\n` +
        `                throw new Error(\`Duplicate net name "\${ref.value}"\`);\n` +
        `            }\n` +
        `            usedNames.add(ref.value);\n` +
        `            usedNetRoots.set(ref.value, root);\n` +
        `            netList.add(ref.value);\n` +
        `        }\n` +
        `        for (const [name, value] of Object.entries(nets)) {\n` +
        `            if (value.__netRef) {\n` +
        `                addNetName(value);\n` +
        `                compiledNets[name] = value.value;\n` +
        `            } else if (value.__netGroup) {\n` +
        `                const snapshot = { type: value.type };\n` +
        `                for (const signalName of netTypeSignals[value.type]) {\n` +
        `                    addNetName(value[signalName]);\n` +
        `                    snapshot[signalName] = value[signalName].value;\n` +
        `                }\n` +
        `                compiledNets[name] = snapshot;\n` +
        `            } else {\n` +
        `                for (const side of ["h", "l"]) {\n` +
        `                    addNetName(value[side]);\n` +
        `                }\n` +
        `                compiledNets[name] = { h: value.h.value, l: value.l.value, voltage: value.voltage };\n` +
        `            }\n` +
        `        }\n` +
        `        const groups = new Map();\n` +
        `        for (const key of pinGroups.keys()) {\n` +
        `            const root = __find(key);\n` +
        `            if (!groups.has(root)) {\n` +
        `                groups.set(root, []);\n` +
        `            }\n` +
        `            groups.get(root).push(key);\n` +
        `        }\n` +
        `        for (const [root, keys] of groups) {\n` +
        `            const explicit = explicitNets.get(root);\n` +
        `            if (explicit) {\n` +
        `                const finalExplicit = resolveAlias(explicit);\n` +
        `                for (const key of keys) {\n` +
        `                    __setPinNet(pinsByKey.get(key).pin, finalExplicit);\n` +
        `                }\n` +
        `                continue;\n` +
        `            }\n` +
        `            const overrideNames = keys\n` +
        `                .map((pinKey) => nameOverrides.get(pinKey))\n` +
        `                .filter((name) => name !== undefined);\n` +
        `            const uniqueOverrides = [...new Set(overrideNames)];\n` +
        `            if (uniqueOverrides.length > 1) {\n` +
        `                throw new Error(\`Implicit net has multiple names: \${uniqueOverrides.join(\", \")}\`);\n` +
        `            }\n` +
        `            const netName = __reserveNetName(uniqueOverrides[0] || pinsByKey.get(root).defaultNetName, usedNames, uniqueOverrides.length === 1);\n` +
        `            netList.add(netName);\n` +
        `            compiledNets[netName] = netName;\n` +
        `            for (const key of keys) {\n` +
        `                __setPinNet(pinsByKey.get(key).pin, netName);\n` +
        `            }\n` +
        `        }\n` +
        `        return { netList, components, nets: compiledNets };\n` +
        `    }\n`;
}

function renderModuleJavaScript(moduleTemplate, context, functionName = moduleTemplate.name) {
    const statements = splitStatements(moduleTemplate.body);
    const { declarations, nameOverrides } = collectTopDeclarations(statements);
    const isTopLevel = functionName === "__module_top" || moduleTemplate.name === "top";
    const moduleContext = {
        ...context,
        netNames: new Set(declarations.filter((declaration) => declaration.kind === "net").map((declaration) => declaration.name)),
        netGroups: new Map(declarations.filter((declaration) => declaration.kind === "net" && declaration.type).map((declaration) => [declaration.name, declaration.type])),
        railNames: new Set(declarations.filter((declaration) => declaration.kind === "rail").map((declaration) => declaration.name)),
    };
    const parameters = moduleTemplate.parameters.join(", ");
    const declarationLines = declarations.map((declaration) => {
        if (declaration.kind === "net") {
            if (declaration.type) {
                const baseName = nameOverrides.get(declaration.name) || declaration.name;
                return `    const ${declaration.name} = __declareNetGroup(${jsString(declaration.name)}, ${jsString(declaration.type)}, ${jsString(baseName)});`;
            }
            const finalName = nameOverrides.get(declaration.name) || declaration.defaultName;
            return `    const ${declaration.name} = __declareNet(${jsString(declaration.name)}, __scopeName(${jsString(finalName)}), ${isTopLevel && (nameOverrides.has(declaration.name) || Boolean(declaration.inlineAnchor))}, ${jsString(isTopLevel ? finalName : declaration.name)});`;
        }

        const highKey = `${declaration.name}.h`;
        const lowKey = `${declaration.name}.l`;
        const highName = nameOverrides.get(highKey) || declaration.defaultHigh;
        const lowName = nameOverrides.get(lowKey) || declaration.defaultLow;
        return `    const ${declaration.name} = __declareRail(${jsString(declaration.name)}, __scopeName(${jsString(highName)}), __scopeName(${jsString(lowName)}), ${isTopLevel && nameOverrides.has(highKey)}, ${isTopLevel && nameOverrides.has(lowKey)}, ${isTopLevel});`;
    });
    const statementLines = renderStatements(statements, 4, moduleContext);

    return [
        `function ${functionName}(${parameters}) {`,
        ...declarationLines,
        "",
        ...statementLines,
        "",
        `    return {`,
        ...declarations.map((declaration) => `        ${declaration.name},`),
        `    };`,
        `}`,
    ].join("\n");
}

function renderTopJavaScript(filePath) {
    const { source, modules } = loadFile(filePath);
    const topModule = modules.get("top");
    if (!topModule) {
        throw new Error("No top module found");
    }

    const inputDir = path.dirname(filePath);
    const includes = includedFiles(filePath);
    const requireLines = includes.map((includePath) => {
        const templateName = path.basename(includePath, ".schrune");
        const jsPath = path.join(path.dirname(includePath), `${templateName}.js`);
        const relativePath = `./${path.relative(inputDir, jsPath).replace(/\\/g, "/").replace(/\.js$/, "")}`;
        return `const ${templateName} = require(${jsString(relativePath)});`;
    });
    const includeNames = new Set(includes.map((includePath) => path.basename(includePath, ".schrune")));
    const primitiveNames = primitiveNamesInModules([...modules.values()], includeNames);
    const primitiveRequireLines = [...new Set(primitiveNames)].map((name) => {
        const includePath = path.join(__dirname, "include", primitiveIncludeFileName(name));
        return `const ${name} = require(${jsString(includePath)});`;
    });
    const moduleDefinitions = [...modules.values()]
        .filter((module) => module.name !== "top")
        .map((module) => renderModuleJavaScript(module, {}));

    return [
        ...requireLines,
        requireLines.length && primitiveRequireLines.length ? "" : undefined,
        ...primitiveRequireLines,
        requireLines.length || primitiveRequireLines.length ? "" : undefined,
        "function top() {",
        renderRuntimeHelpers().trimEnd(),
        "",
        ...moduleDefinitions.map((module) => indentLines(module, 4)),
        moduleDefinitions.length ? "" : undefined,
        indentLines(renderModuleJavaScript(topModule, {}, "__module_top"), 4),
        "",
        "    __module_top();",
        "    return __finalize();",
        "}",
        "",
        "module.exports = top;",
        "",
        "if (require.main === module) {",
        "    top();",
        "    console.log(\"Step 1 successful.\");",
        "}",
        "",
    ].filter((line) => line !== undefined).join("\n");
}

function renderModuleFileJavaScript(filePath) {
    const { source, modules } = loadFile(filePath);
    const inputDir = path.dirname(filePath);
    const includes = includedFiles(filePath);
    const requireLines = includes.map((includePath) => {
        const templateName = path.basename(includePath, ".schrune");
        const jsPath = path.join(path.dirname(includePath), `${templateName}.js`);
        const relativePath = `./${path.relative(inputDir, jsPath).replace(/\\/g, "/").replace(/\.js$/, "")}`;
        return `const ${templateName} = require(${jsString(relativePath)});`;
    });
    const includeNames = new Set(includes.map((includePath) => path.basename(includePath, ".schrune")));
    const primitiveNames = primitiveNamesInModules([...modules.values()], includeNames);
    const primitiveRequireLines = [...new Set(primitiveNames)].map((name) => {
        const includePath = path.join(__dirname, "include", primitiveIncludeFileName(name));
        return `const ${name} = require(${jsString(includePath)});`;
    });
    const moduleEntries = [...modules.values()];
    if (!moduleEntries.length) {
        throw new Error("No module found");
    }

    const exportModule = modules.get(path.basename(filePath, ".schrune")) || moduleEntries[0];
    const helperDefinitions = moduleEntries
        .filter((module) => module.name !== exportModule.name)
        .map((module) => renderModuleJavaScript(module, {}));
    const exportDefinition = renderModuleJavaScript(exportModule, {});

    return [
        ...requireLines,
        requireLines.length && primitiveRequireLines.length ? "" : undefined,
        ...primitiveRequireLines,
        requireLines.length || primitiveRequireLines.length ? "" : undefined,
        renderRuntimeHelpers().trimEnd(),
        "",
        ...helperDefinitions,
        helperDefinitions.length ? "" : undefined,
        exportDefinition,
        "",
        `module.exports = ${exportModule.name};`,
        "",
    ].filter((line) => line !== undefined).join("\n");
}

function step1OutputPath(sourceRoot, outputRoot, schrunePath) {
    const relativePath = path.relative(sourceRoot, schrunePath).replace(/\.schrune$/, ".js");
    return path.join(outputRoot, relativePath);
}

function materializeStep1JavaScript(filePath, outputRoot) {
    const resolvedPath = path.resolve(filePath);
    const sourceRoot = path.dirname(resolvedPath);
    const files = [resolvedPath, ...includedFiles(resolvedPath)];

    for (const schrunePath of files) {
        const { source, templates } = loadFile(schrunePath);
        const partName = path.basename(schrunePath, ".schrune");
        const partTemplate = templates.get(partName);
        const outputPath = step1OutputPath(sourceRoot, outputRoot, schrunePath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        if (partTemplate && !extractBlocks(source, "module", { allowParameters: true }).some((module) => module.name === "top")) {
            fs.writeFileSync(outputPath, renderPartJavaScript(partTemplate));
            continue;
        }

        if (extractBlocks(source, "module", { allowParameters: true }).some((module) => module.name === "top")) {
            fs.writeFileSync(outputPath, renderTopJavaScript(schrunePath));
            continue;
        }

        fs.writeFileSync(outputPath, renderModuleFileJavaScript(schrunePath));
    }
}

function writeStep1JavaScript(filePath, outputRoot = path.dirname(path.resolve(filePath))) {
    materializeStep1JavaScript(filePath, outputRoot);
}

function executeStep1JavaScript(filePath) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-step1-"));
    try {
        materializeStep1JavaScript(filePath, tempRoot);
        const entryPoint = step1OutputPath(path.dirname(path.resolve(filePath)), tempRoot, path.resolve(filePath));
        delete require.cache[require.resolve(entryPoint)];
        const top = require(entryPoint);
        if (typeof top !== "function") {
            throw new Error("Step 1 entrypoint did not export a function");
        }
        return top();
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function usage() {
    return [
        "Usage:",
        "  shrune create",
        "  shrune build [--keep-js] [--no-parts-lock] [file.schrune]",
        "  shrune open-kicad",
        "  shrune parts add <CXXXX>",
        "  shrune parts install [-u|--update] [-a|--include-autogenerated]",
        "",
        "Compatibility:",
        "  shrune [--keep-js] <file.schrune>",
    ].join("\n");
}

class UsageError extends Error {
    constructor() {
        super(usage());
        this.name = "UsageError";
    }
}

async function promptForProjectConfig() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        const projectName = (await rl.question("Project name: ")).trim();
        const entryFile = (await rl.question("Entry file: ")).trim();

        if (!projectName || !entryFile) {
            throw new Error("Project name and entry file are required");
        }

        return { projectName, entryFile };
    } finally {
        rl.close();
    }
}

function openPathWithDefaultApplication(filePath) {
    const resolvedPath = path.resolve(filePath);
    let command;
    let args;

    if (process.platform === "win32") {
        command = "cmd";
        args = ["/c", "start", "", resolvedPath];
    } else if (process.platform === "darwin") {
        command = "open";
        args = [resolvedPath];
    } else {
        command = "xdg-open";
        args = [resolvedPath];
    }

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
        });
        child.on("error", reject);
        child.unref();
        resolve();
    });
}

function normalizeLcscPartReference(part) {
    if (!part || typeof part !== "object") {
        return undefined;
    }

    const lcsc = String(part.LCSC || part.lcsc || "").toUpperCase();
    if (!lcsc) {
        return undefined;
    }

    return {
        ...part,
        LCSC: lcsc,
    };
}

function installedImportedPartExists(partsRoot, partName) {
    if (!partName) {
        return false;
    }

    const directory = path.join(partsRoot, partName);
    return fs.existsSync(path.join(directory, `${partName}.schrune`))
        && fs.existsSync(path.join(directory, `${partName}.kicad_sym`))
        && fs.existsSync(path.join(directory, `${partName}.kicad_mod`));
}

function includeStatementForPart(baseDir, schrunePath) {
    const relativePath = path.relative(path.resolve(baseDir), path.resolve(schrunePath)).replace(/\\/g, "/");
    return `#include "${relativePath}"`;
}

async function installProjectParts(project, options = {}) {
    const target = resolveBuildTarget({ cwd: project.dir });
    const projectPartsRoot = path.join(path.dirname(target.entryFilePath), "parts");
    const autogeneratedPartsRoot = path.join(projectPartsRoot, "autogenerated");
    const importer = options.addLcscPart || addLcscPart;
    const manifestParts = Array.isArray(project.config.parts)
        ? project.config.parts.map(normalizeLcscPartReference).filter(Boolean).map((part) => ({ ...part, __autogenerated: false }))
        : [];
    const queue = [...manifestParts];

    if (options.includeAutogenerated) {
        const lock = readPartsLock(target.entryFilePath);
        for (const part of lock.parts || []) {
            const normalized = normalizeLcscPartReference(part);
            if (normalized) {
                queue.push({ ...normalized, __autogenerated: true });
            }
        }
    }

    const uniqueQueue = [];
    const seen = new Set();
    for (const part of queue) {
        if (seen.has(part.LCSC)) {
            continue;
        }
        seen.add(part.LCSC);
        uniqueQueue.push(part);
    }

    const installed = [];
    options.onProgress && options.onProgress({ current: 0, total: uniqueQueue.length });
    for (let index = 0; index < uniqueQueue.length; index++) {
        const part = uniqueQueue[index];

        const partsRoot = part.__autogenerated ? autogeneratedPartsRoot : projectPartsRoot;

        if (!options.update && installedImportedPartExists(partsRoot, part.MPN || part.partName)) {
            options.onProgress && options.onProgress({ current: index + 1, total: uniqueQueue.length, part, skipped: true });
            continue;
        }

        const result = await importer(part.LCSC, {
            cwd: path.dirname(target.entryFilePath),
            partsDir: partsRoot,
            updateExistingSchrune: options.update,
            part,
        });
        installed.push(result);

        if ((project.config.parts || []).some((entry) => normalizeLcscPartReference(entry)?.LCSC === result.lcsc)) {
            project = findProjectConfigInDirectory(project.dir);
            addPartToProjectConfig(project, {
                MPN: result.partName,
                LCSC: result.lcsc,
            });
        }
        options.onProgress && options.onProgress({ current: index + 1, total: uniqueQueue.length, part, result });
    }

    return installed;
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] && !args[0].startsWith("--") && path.extname(args[0]) !== ".schrune"
        ? args.shift()
        : "build";

    if (command === "create") {
        const { projectName, entryFile } = await promptForProjectConfig();
        const entryPath = path.resolve(process.cwd(), entryFile);
        const projectPath = path.join(path.dirname(entryPath), PROJECT_FILE);

        if (!fs.existsSync(entryPath)) {
            throw new Error(`Entry file not found: ${entryFile}`);
        }

        writeProjectConfig(projectPath, {
            name: projectName,
            entry: relativeManifestPath(path.dirname(projectPath), entryPath),
            parts: [],
        });
        console.log(colorize(`Created ${projectPath}`, "green", process.stdout));
        return;
    }

    if (command === "parts") {
        const subcommand = args.shift();
        if (subcommand === "add") {
            const partNumber = args[0];
            if (!partNumber) {
                throw new UsageError();
            }

            const project = findProjectConfig(process.cwd());
            const baseDir = project ? project.dir : process.cwd();
            const result = await addLcscPart(partNumber, { cwd: baseDir });
            if (project) {
                addPartToProjectConfig(project, {
                    MPN: result.partName,
                    LCSC: partNumber.toUpperCase(),
                });
            }
            console.log(`Added ${result.partName}`);
            console.log(`Pins: ${result.pins.length}`);
            console.log(includeStatementForPart(baseDir, result.schrunePath));
            if (!result.modelDownloaded) {
                console.log("3D STEP model payload was not directly downloadable.");
            }
            return;
        }

        if (subcommand === "install") {
            const project = findProjectConfigInDirectory(process.cwd());
            if (!project) {
                throw new Error(`No ${PROJECT_FILE} found in ${process.cwd()}`);
            }

            const update = args.includes("-u") || args.includes("--update");
            const includeAutogenerated = args.includes("-a") || args.includes("--include-autogenerated");
            const progress = createProgress();
            progress.start("Installing parts");
            let installed;
            try {
                installed = await installProjectParts(project, {
                    update,
                    includeAutogenerated,
                    onProgress({ current, total }) {
                        progress.update(`Installing parts (${current}/${total})`);
                    },
                });
                progress.succeed("Installed parts");
            } catch (error) {
                progress.fail("Parts install failed");
                throw error;
            }
            console.log(`Installed ${installed.length} part${installed.length === 1 ? "" : "s"}`);
            return;
        }

        throw new UsageError();
    }

    if (command === "open-kicad") {
        const target = resolveBuildTarget({ cwd: process.cwd() });
        if (!target.project || !target.project.config.build || !target.project.config.build.kicadProject) {
            throw new Error(`No KiCad project recorded in ${PROJECT_FILE}. Run a build first.`);
        }

        const projectPath = path.resolve(target.project.dir, target.project.config.build.kicadProject);
        if (!fs.existsSync(projectPath)) {
            throw new Error(`KiCad project not found: ${projectPath}`);
        }

        await openPathWithDefaultApplication(projectPath);
        return;
    }

    if (command !== "build") {
        throw new UsageError();
    }

    const keepJs = args.includes("--keep-js");
    const noPartsLock = args.includes("--no-parts-lock");
    const inputFile = args.find((arg) => arg !== "--keep-js" && arg !== "--no-parts-lock");
    if (inputFile && path.extname(inputFile) !== ".schrune") {
        throw new UsageError();
    }

    const target = resolveBuildTarget({ cwd: process.cwd(), inputFile });
    const inputPath = target.entryFilePath;
    if (!fs.existsSync(inputPath)) {
        throw new Error(`File not found: ${inputFile || inputPath}`);
    }

    const designatorState = readDesignatorState(inputPath);
    const progress = createProgress();

    try {
        if (keepJs) {
            progress.start("Writing intermediate JavaScript");
            materializeStep1JavaScript(inputPath, path.dirname(inputPath));
            progress.succeed("Wrote intermediate JavaScript");
        }

        progress.start("Parsing source");
        const parsed = step1(inputPath);
        progress.succeed("Parsed source");

        progress.start("Compiling nets");
        const compiled = assignDesignators(parsed, designatorState);
        progress.succeed("Compiled nets");

        progress.start("Fetching components");
        const bom = await step3(inputPath, compiled, {
            noPartsLock,
            projectName: target.projectName,
            onProgress({ current, total }) {
                progress.update(`Fetching components (${current}/${total})`);
            },
        });
        progress.succeed("Fetched components");

        progress.start("Sending to KiCad");
        const result = writeKiCadFiles(inputPath, bom, { projectName: target.projectName });
        progress.succeed("Sent to KiCad");

        writeDesignatorState(inputPath, buildDesignatorState(result));
        if (target.project) {
            const nextConfig = {
                ...target.project.config,
                build: manifestBuildRecord(target.project.path, result),
            };
            writeProjectConfig(target.project.path, nextConfig);
        }

        console.log(colorize(`Build successful: ${result.components.length} components, ${result.netList.size} nets.`, "green", process.stdout));
    } catch (error) {
        progress.fail("Build failed");
        throw error;
    }
}

if (require.main === module) {
    main().catch((error) => {
        if (error instanceof UsageError) {
            console.error(colorize(error.message, "red"));
            process.exitCode = 1;
            return;
        }

        console.error(formatError(error));
        process.exitCode = 1;
    });
}

module.exports = {
    assignDesignators,
    buildDesignatorState,
    readDesignatorState,
    step1,
    step3,
    writeStep1JavaScript,
    writeKiCadFiles,
    writeDesignatorState,
    materializeStep1JavaScript,
    createProgress,
    includeStatementForPart,
    installProjectParts,
    openPathWithDefaultApplication,
    UsageError,
    main,
};
