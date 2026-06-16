const fs = require("fs");
const path = require("path");
const { addLcscPart } = require("./src/lcsc");

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
    const parameters = options.allowParameters ? "\\s*(?:\\([^)]*\\))?" : "";
    const pattern = new RegExp(`\\b${keyword}\\s+([A-Za-z_]\\w*)${parameters}\\s*\\{`, "g");
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const openIndex = source.indexOf("{", match.index);
        const closeIndex = findMatching(source, openIndex, "{", "}");
        blocks.push({
            name: match[1],
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
        /^.+?\.name\s*=\s*.+$/,
        /^[A-Za-z_]\w*\.voltage\s*=\s*.+$/,
        /^(?:part\s+)?[A-Za-z_]\w*\s*=\s*new\s+[A-Za-z_]\w*\s*\([\s\S]*\)$/,
        /^part\[\d+\]\s+[A-Za-z_]\w*\s*=\s*new\s+[A-Za-z_]\w*\s*\([\s\S]*\)$/,
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
        const nestedMatch = entry.match(/^([A-Za-z_]\w*)\s*:\s*\[([\s\S]*)\]$/);
        if (nestedMatch) {
            pins.push({
                name: nestedMatch[1],
                group: parsePinEntries(nestedMatch[2]),
            });
            continue;
        }

        const match = entry.match(/^([A-Za-z_]\w*|\d+)\s*:\s*(\d+)$/);
        if (!match) {
            throw new Error(`Invalid pin entry "${entry}"`);
        }
        pins.push({
            name: match[1],
            pad: Number(match[2]),
        });
    }

    return pins;
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

function parsePart(source) {
    const parts = extractBlocks(source, "part");
    const templates = new Map();

    for (const part of parts) {
        templates.set(part.name, {
            name: part.name,
            info: parseInfo(part.body),
            pins: parsePins(part.body),
        });
    }

    return templates;
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
            designatorPrefix: name[0],
        },
        pins: [
            { name: "0", pad: 0 },
            { name: "1", pad: 1 },
        ],
    }]));
}

function createComponent(template, params = {}) {
    if (template.primitive && !("value" in params)) {
        throw new Error(`${template.name} requires a value`);
    }
    const footprint = params.footprint;

    const Component = {
        [template.name]: class {
            constructor() {
                this.info = {
                    ...template.info,
                    footprint: footprint || template.info.footprint,
                };
                this.pins = [];
                if (template.primitive) {
                    this.value = params.value;
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

function addPins(target, pins) {
    for (const pin of pins) {
        if (pin.group) {
            const group = [];
            addPins(group, pin.group);
            target[pin.name] = group;
            continue;
        }

        const pinValue = {
            name: pin.name,
            pad: pin.pad,
            net: "",
        };

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

    const matches = [];

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(entryPath);
            } else if (entry.isFile() && entry.name === includeName) {
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
        return { source: "", templates: new Map() };
    }

    loaded.add(resolvedPath);
    const baseDir = path.dirname(resolvedPath);
    const rawSource = fs.readFileSync(resolvedPath, "utf8");
    const source = stripComments(rawSource);
    const templates = createPrimitiveTemplates();
    if (/^\s*#import\b/m.test(source)) {
        throw new Error("Use #include to add files");
    }

    const includePattern = /^\s*#include\s+["']([^"']+)["']/gm;
    let match;

    while ((match = includePattern.exec(source)) !== null) {
        const includePath = findInclude(baseDir, match[1]);
        const includeFile = loadFile(includePath, loaded);
        for (const [name, template] of includeFile.templates) {
            templates.set(name, template);
        }
    }

    for (const [name, template] of parsePart(source)) {
        templates.set(name, template);
    }

    return { source, templates };
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

function readNetReference(expression, nets) {
    const value = expression.trim();
    const railMatch = value.match(/^([A-Za-z_]\w*)\.(h|l)$/);
    if (railMatch) {
        const rail = nets[railMatch[1]];
        if (!rail || typeof rail !== "object") {
            throw new Error(`Unknown rail "${railMatch[1]}"`);
        }
        return rail[railMatch[2]];
    }

    if (!(value in nets)) {
        throw new Error(`Unknown net "${value}"`);
    }

    return nets[value];
}

function getNetValue(expression, nets) {
    const value = expression.trim();
    const railMatch = value.match(/^([A-Za-z_]\w*)\.(h|l)$/);
    if (railMatch) {
        const rail = nets[railMatch[1]];
        if (rail && typeof rail === "object") {
            return rail[railMatch[2]];
        }
        return undefined;
    }

    if (value in nets) {
        return nets[value];
    }

    return undefined;
}

function setNetValue(expression, nets, value) {
    const trimmed = expression.trim();
    const railMatch = trimmed.match(/^([A-Za-z_]\w*)\.(h|l)$/);
    if (railMatch) {
        const rail = nets[railMatch[1]];
        if (!rail || typeof rail !== "object") {
            throw new Error(`Unknown rail "${railMatch[1]}"`);
        }
        rail[railMatch[2]] = value;
        return;
    }

    if (!(trimmed in nets)) {
        throw new Error(`Unknown net "${trimmed}"`);
    }

    nets[trimmed] = value;
}

function resolveNetConnection(leftExpression, rightExpression, nets, nameOverrides) {
    const leftName = getNetValue(leftExpression, nets);
    const rightName = getNetValue(rightExpression, nets);
    if (leftName === rightName) {
        return;
    }

    const leftNamed = nameOverrides.has(leftExpression.trim());
    const rightNamed = nameOverrides.has(rightExpression.trim());

    if (leftNamed && rightNamed) {
        throw new Error(`Connection joins nets "${leftName}" and "${rightName}"`);
    }

    if (leftNamed) {
        setNetValue(rightExpression, nets, leftName);
        return;
    }

    setNetValue(leftExpression, nets, rightName);
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

function componentRefName(componentRef) {
    return componentRef.index === undefined ? componentRef.name : `${componentRef.name}_${componentRef.index}`;
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

function getPinKey(expression, scope = {}) {
    const value = expression.trim();
    const nestedMatch = value.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?)\.([A-Za-z_]\w*)\[(.+)\]$/);
    if (nestedMatch) {
        const componentRef = parseComponentReference(nestedMatch[1], scope);
        const index = evaluateIndex(nestedMatch[3], scope);
        const componentName = componentRefName(componentRef);
        return {
            componentRef,
            path: [nestedMatch[2], index],
            key: `${componentName}.${nestedMatch[2]}[${index}]`,
            defaultNetName: `${componentName}_${nestedMatch[2]}_${index}`,
        };
    }

    const bracketMatch = value.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?)\[(.+)\]$/);
    if (bracketMatch) {
        const componentRef = parseComponentReference(bracketMatch[1], scope);
        const pin = evaluateIndex(bracketMatch[2], scope);
        const componentName = componentRefName(componentRef);
        return {
            componentRef,
            path: [pin],
            key: `${componentName}[${pin}]`,
            defaultNetName: `${componentName}_${pin}`,
        };
    }

    const dotMatch = value.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?)\.([A-Za-z_]\w*|\d+)$/);
    if (dotMatch) {
        const componentRef = parseComponentReference(dotMatch[1], scope);
        const componentName = componentRefName(componentRef);
        return {
            componentRef,
            path: [dotMatch[2]],
            key: `${componentName}.${dotMatch[2]}`,
            defaultNetName: `${componentName}_${dotMatch[2]}`,
        };
    }

    return undefined;
}

function getComponentPin(componentsByName, expression, scope = {}) {
    const pinKey = getPinKey(expression, scope);
    if (!pinKey) {
        return undefined;
    }

    const component = getComponentValue(componentsByName, pinKey.componentRef);
    return getPinFromPath(component, pinKey.path);
}

function readEndpoint(expression, componentsByName, nets, scope = {}) {
    const net = getNetValue(expression, nets);
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

function connectEndpoints(leftExpression, rightExpression, componentsByName, nets, pinGroups, nameOverrides, scope = {}) {
    const left = readEndpoint(leftExpression, componentsByName, nets, scope);
    const right = readEndpoint(rightExpression, componentsByName, nets, scope);

    if (left.type === "pin" && right.type === "pin") {
        pinGroups.union(left, right);
        return;
    }

    if (left.type === "pin" && right.type === "net") {
        pinGroups.connectExplicit(left, right.value);
        return;
    }

    if (left.type === "net" && right.type === "pin") {
        pinGroups.connectExplicit(right, left.value);
        return;
    }

    resolveNetConnection(leftExpression, rightExpression, nets, nameOverrides);
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

    if (!component.pins[0] || !component.pins[1] || component.pins.filter(Boolean).length !== 2) {
        throw new Error(`Bridge middle "${name}" must be a component with 2 pins`);
    }
}

function connectBridge(statement, componentsByName, nets, pinGroups, nameOverrides, scope = {}) {
    const parts = statement.split("~>").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) {
        throw new Error(`Invalid bridge connection "${statement}"`);
    }

    const middleComponents = parts.slice(1, -1);
    for (const componentName of middleComponents) {
        validateBridgeComponent(componentName, componentsByName, scope);
    }

    connectEndpoints(`${parts[0]}`, `${middleComponents[0]}[0]`, componentsByName, nets, pinGroups, nameOverrides, scope);

    for (let i = 0; i < middleComponents.length - 1; i++) {
        connectEndpoints(
            `${middleComponents[i]}[1]`,
            `${middleComponents[i + 1]}[0]`,
            componentsByName,
            nets,
            pinGroups,
            nameOverrides,
            scope
        );
    }

    connectEndpoints(
        `${middleComponents[middleComponents.length - 1]}[1]`,
        `${parts[parts.length - 1]}`,
        componentsByName,
        nets,
        pinGroups,
        nameOverrides,
        scope
    );
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
        components,
        componentsByName,
        nets,
        pinGroups,
        nameOverrides,
    } = context;

    const arrayPartMatch = statement.match(/^part\[(\d+)\]\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (arrayPartMatch) {
        const count = Number(arrayPartMatch[1]);
        const instanceName = arrayPartMatch[2];
        const templateName = arrayPartMatch[3];
        const params = parseConstructorArgs(arrayPartMatch[4]);
        const template = templates.get(templateName);
        if (!template) {
            throw new Error(`Unknown part "${templateName}"`);
        }
        if (componentsByName.has(instanceName)) {
            throw new Error(`Duplicate component "${instanceName}"`);
        }

        const instances = createComponentInstances(template, params, count);
        componentsByName.set(instanceName, instances);
        components.push(...instances);
        return;
    }

    const partMatch = statement.match(/^(?:part\s+)?([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (partMatch) {
        const instanceName = partMatch[1];
        const templateName = partMatch[2];
        const params = parseConstructorArgs(partMatch[3]);
        const template = templates.get(templateName);
        if (!template) {
            throw new Error(`Unknown part "${templateName}"`);
        }
        if (componentsByName.has(instanceName)) {
            throw new Error(`Duplicate component "${instanceName}"`);
        }

        const component = createComponent(template, params);
        componentsByName.set(instanceName, component);
        components.push(component);
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
        connectBridge(statement, componentsByName, nets, pinGroups, nameOverrides, scope);
        return;
    }

    const connectionMatch = statement.match(/^(.+?)\s*~\s*(.+)$/);
    if (connectionMatch) {
        connectEndpoints(
            connectionMatch[1].trim(),
            connectionMatch[2].trim(),
            componentsByName,
            nets,
            pinGroups,
            nameOverrides,
            scope
        );
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

    union(left, right) {
        this.add(left);
        this.add(right);
        const leftRoot = this.find(left.key);
        const rightRoot = this.find(right.key);

        if (leftRoot === rightRoot) {
            return;
        }

        const leftNet = this.explicitNets.get(leftRoot);
        const rightNet = this.explicitNets.get(rightRoot);
        if (leftNet && rightNet && leftNet !== rightNet) {
            throw new Error(`Connection joins nets "${leftNet}" and "${rightNet}"`);
        }

        this.parents.set(rightRoot, leftRoot);
        if (!this.defaults.has(leftRoot)) {
            this.defaults.set(leftRoot, left.defaultNetName);
        }
        if (!leftNet && rightNet) {
            this.explicitNets.set(leftRoot, rightNet);
        }
    }

    connectExplicit(pin, netName) {
        this.add(pin);
        const root = this.find(pin.key);
        const existing = this.explicitNets.get(root);
        if (existing && existing !== netName) {
            throw new Error(`Pin "${pin.key}" connects to both "${existing}" and "${netName}"`);
        }

        this.explicitNets.set(root, netName);
        pin.pin.net = netName;
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

function collectNetNames(nets) {
    return new Set(Object.values(nets).flatMap((net) => (
        typeof net === "object" ? [net.h, net.l] : [net]
    )));
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

function applyNetNames(declarations, nameOverrides) {
    const usedNames = new Set();
    const nets = {};

    for (const declaration of declarations) {
        if (declaration.kind === "net") {
            const finalName = nameOverrides.get(declaration.name) || declaration.defaultName;
            if (usedNames.has(finalName)) {
                throw new Error(`Duplicate net name "${finalName}"`);
            }
            usedNames.add(finalName);
            nets[declaration.name] = finalName;
            continue;
        }

        const highKey = `${declaration.name}.h`;
        const lowKey = `${declaration.name}.l`;
        const highName = nameOverrides.get(highKey) || declaration.defaultHigh;
        const lowName = nameOverrides.get(lowKey) || declaration.defaultLow;

        if (usedNames.has(highName)) {
            throw new Error(`Duplicate net name "${highName}"`);
        }
        usedNames.add(highName);

        if (usedNames.has(lowName)) {
            throw new Error(`Duplicate net name "${lowName}"`);
        }
        usedNames.add(lowName);

        nets[declaration.name] = {
            h: highName,
            l: lowName,
            voltage: undefined,
        };
    }

    return nets;
}

function step1(filePath) {
    const { source, templates } = loadFile(filePath);
    const topModule = extractBlocks(source, "module", { allowParameters: true })
        .find((module) => module.name === "top");
    if (!topModule) {
        throw new Error("No top module found");
    }

    const statements = splitStatements(topModule.body);
    const declarations = [];
    const declarationNames = new Set();
    const provisionalNames = new Set();
    const nameOverrides = new Map();

    for (const statement of statements) {
        const declarationMatch = statement.match(/^(net|rail)\s+([A-Za-z_]\w*)$/);
        if (declarationMatch) {
            const kind = declarationMatch[1];
            const name = declarationMatch[2];
            if (declarationNames.has(name)) {
                throw new Error(`Duplicate declaration "${name}"`);
            }
            declarationNames.add(name);

            if (kind === "net") {
                declarations.push({
                    kind,
                    name,
                    defaultName: uniqueNetName(name, provisionalNames),
                });
            } else {
                declarations.push({
                    kind,
                    name,
                    defaultHigh: uniqueNetName(`${name}_h`, provisionalNames),
                    defaultLow: uniqueNetName(`${name}_l`, provisionalNames),
                });
            }
            continue;
        }

        const nameMatch = statement.match(/^(.+?)\.name\s*=\s*(.+)$/);
        if (nameMatch) {
            nameOverrides.set(nameMatch[1].trim(), parseValue(nameMatch[2]));
        }
    }

    const nets = applyNetNames(declarations, nameOverrides);
    const components = [];
    const componentsByName = new Map();
    const pinGroups = new PinNetGroups();
    const context = {
        templates,
        components,
        componentsByName,
        nets,
        pinGroups,
        nameOverrides,
    };

    for (const statement of statements) {
        executeStatement(statement, context);
    }

    const usedNames = collectNetNames(nets);
    const implicitNets = {};
    for (const [root, pinKeys] of pinGroups.groups()) {
        const explicitNet = pinGroups.explicitNets.get(root);
        if (explicitNet) {
            for (const pinKey of pinKeys) {
                pinGroups.pinFor(pinKey).net = explicitNet;
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
            pinGroups.pinFor(pinKey).net = netName;
        }
    }

    return {
        netList: usedNames,
        components,
        nets: {
            ...nets,
            ...implicitNets,
        },
    };
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

function renderPinTemplateAssignments(pins, target, indent = "        ") {
    const lines = [];
    for (const pin of pins) {
        if (pin.group) {
            const property = pinProperty(pin.name);
            lines.push(`${indent}${target}${property} = [];`);
            lines.push(...renderPinTemplateAssignments(pin.group, `${target}${property}`, indent));
            continue;
        }

        const property = pinProperty(pin.name);
        lines.push(`${indent}${target}${property} = ${renderObjectLiteral({
            name: pin.name,
            pad: pin.pad,
            net: "",
        }, indent.length)};`);
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

    for (const statement of statements) {
        const declarationMatch = statement.match(/^(net|rail)\s+([A-Za-z_]\w*)$/);
        if (declarationMatch) {
            const kind = declarationMatch[1];
            const name = declarationMatch[2];
            if (declarationNames.has(name)) {
                throw new Error(`Duplicate declaration "${name}"`);
            }
            declarationNames.add(name);

            if (kind === "net") {
                declarations.push({
                    kind,
                    name,
                    defaultName: uniqueNetName(name, provisionalNames),
                });
            } else {
                declarations.push({
                    kind,
                    name,
                    defaultHigh: uniqueNetName(`${name}_h`, provisionalNames),
                    defaultLow: uniqueNetName(`${name}_l`, provisionalNames),
                });
            }
            continue;
        }

        const nameMatch = statement.match(/^(.+?)\.name\s*=\s*(.+)$/);
        if (nameMatch) {
            nameOverrides.set(nameMatch[1].trim(), parseValue(nameMatch[2]));
        }
    }

    return { declarations, nameOverrides };
}

function renderPrimitiveClass(name) {
    const template = createPrimitiveTemplates().get(name);
    return `class ${name} {\n` +
        `    constructor(params = {}) {\n` +
        `        if (!("value" in params)) {\n` +
        `            throw new Error(${jsString(`${name} requires a value`)});\n` +
        `        }\n` +
        `        this.info = ${renderObjectLiteral(template.info, 8)};\n` +
        `        this.info.footprint = params.footprint || this.info.footprint;\n` +
        `        this.value = params.value;\n` +
        `        this.footprint = params.footprint;\n` +
        `        this.pins = [];\n` +
        `${renderPinTemplateAssignments(template.pins, "this.pins").join("\n")}\n` +
        `    }\n` +
        `}\n`;
}

function renderConstructorArgs(args) {
    const params = parseConstructorArgs(args);
    return Object.keys(params).length ? renderObjectLiteral(params, 4) : "";
}

function renderComponentConstructor(templateName, args) {
    const params = renderConstructorArgs(args);
    return params ? `new ${templateName}(${params})` : `new ${templateName}()`;
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

function renderPinEndpoint(expression) {
    const value = expression.trim();
    const nestedMatch = value.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?)\.([A-Za-z_]\w*)\[(.+)\]$/);
    if (nestedMatch) {
        const component = componentReferenceParts(nestedMatch[1]);
        return `__pin(${component.componentExpression}, [${jsString(nestedMatch[2])}, ${nestedMatch[3]}], ${component.componentNameExpression} + ${jsString(`_${nestedMatch[2]}_`)} + (${nestedMatch[3]}))`;
    }

    const bracketMatch = value.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?)\[(.+)\]$/);
    if (bracketMatch) {
        const component = componentReferenceParts(bracketMatch[1]);
        return `__pin(${component.componentExpression}, [${bracketMatch[2]}], ${component.componentNameExpression} + ${jsString("_")} + (${bracketMatch[2]}))`;
    }

    const dotMatch = value.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?)\.([A-Za-z_]\w*|\d+)$/);
    if (dotMatch) {
        const component = componentReferenceParts(dotMatch[1]);
        return `__pin(${component.componentExpression}, [${jsString(dotMatch[2])}], ${component.componentNameExpression} + ${jsString(`_${dotMatch[2]}`)})`;
    }

    return undefined;
}

function renderEndpoint(expression, context) {
    const value = expression.trim();
    const railMatch = value.match(/^([A-Za-z_]\w*)\.(h|l)$/);
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
    return `__pin(${component.componentExpression}, [${pinIndex}], ${component.componentNameExpression} + ${jsString(`_${pinIndex}`)})`;
}

function indentLines(source, spaces) {
    const padding = " ".repeat(spaces);
    return source.split("\n").map((line) => line ? `${padding}${line}` : line).join("\n");
}

function renderStatements(statements, indent = 4, context = { netNames: new Set(), railNames: new Set() }) {
    const lines = [];
    for (const statement of statements) {
        lines.push(...renderStatement(statement, indent, context));
    }
    return lines;
}

function renderStatement(statement, indent = 4, context = { netNames: new Set(), railNames: new Set() }) {
    const padding = " ".repeat(indent);

    if (/^(net|rail)\s+/.test(statement) || /^.+?\.name\s*=/.test(statement)) {
        return [];
    }

    const arrayPartMatch = statement.match(/^part\[(\d+)\]\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (arrayPartMatch) {
        return [`${padding}const ${arrayPartMatch[2]} = __componentArray(${arrayPartMatch[1]}, () => ${renderComponentConstructor(arrayPartMatch[3], arrayPartMatch[4])});`];
    }

    const partMatch = statement.match(/^(?:part\s+)?([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (partMatch) {
        return [`${padding}const ${partMatch[1]} = __component(() => ${renderComponentConstructor(partMatch[2], partMatch[3])});`];
    }

    const voltageMatch = statement.match(/^([A-Za-z_]\w*)\.voltage\s*=\s*(.+)$/);
    if (voltageMatch) {
        return [`${padding}${voltageMatch[1]}.voltage = ${jsString(parseValue(voltageMatch[2]))};`];
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

    const connectionMatch = statement.match(/^(.+?)\s*~\s*(.+)$/);
    if (connectionMatch) {
        return [`${padding}__connect(${renderEndpoint(connectionMatch[1], context)}, ${renderEndpoint(connectionMatch[2], context)});`];
    }

    throw new Error(`Cannot render statement "${statement}"`);
}

function renderRuntimeHelpers() {
    return `    const components = [];\n` +
        `    const nets = {};\n` +
        `    const pinGroups = new Map();\n` +
        `    const explicitNets = new Map();\n` +
        `    const pinsByKey = new Map();\n` +
        `\n` +
        `    function __netRef(name, value, isOverride = false) {\n` +
        `        return { __netRef: true, name, value, isOverride };\n` +
        `    }\n` +
        `\n` +
        `    function __declareNet(name, value, isOverride = false) {\n` +
        `        const ref = __netRef(name, value, isOverride);\n` +
        `        nets[name] = ref;\n` +
        `        return ref;\n` +
        `    }\n` +
        `\n` +
        `    function __declareRail(name, high, low, highOverride = false, lowOverride = false) {\n` +
        `        const rail = {\n` +
        `            h: __netRef(name + ".h", high, highOverride),\n` +
        `            l: __netRef(name + ".l", low, lowOverride),\n` +
        `            voltage: undefined,\n` +
        `        };\n` +
        `        nets[name] = rail;\n` +
        `        return rail;\n` +
        `    }\n` +
        `\n` +
        `    function __component(factory) {\n` +
        `        const component = factory();\n` +
        `        components.push(component);\n` +
        `        return component;\n` +
        `    }\n` +
        `\n` +
        `    function __componentArray(count, factory) {\n` +
        `        const values = Array.from({ length: count }, () => factory());\n` +
        `        components.push(...values);\n` +
        `        return values;\n` +
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
        `    function __pin(component, path, defaultNetName) {\n` +
        `        let pin = component.pins;\n` +
        `        for (const part of path) {\n` +
        `            pin = pin[part];\n` +
        `        }\n` +
        `        return { type: "pin", pin, key: defaultNetName, defaultNetName };\n` +
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
        `        if (left.type === "net" && right.type === "net") {\n` +
        `            if (left.ref.value === right.ref.value) {\n` +
        `                return;\n` +
        `            }\n` +
        `            if (left.ref.isOverride && right.ref.isOverride) {\n` +
        `                throw new Error(\`Connection joins nets "\${left.ref.value}" and "\${right.ref.value}"\`);\n` +
        `            }\n` +
        `            if (left.ref.isOverride) {\n` +
        `                right.ref.value = left.ref.value;\n` +
        `                right.ref.aliasOf = __rootNetRef(left.ref);\n` +
        `            } else {\n` +
        `                left.ref.value = right.ref.value;\n` +
        `                left.ref.aliasOf = __rootNetRef(right.ref);\n` +
        `            }\n` +
        `            return;\n` +
        `        }\n` +
        `        if (left.type === "pin" && right.type === "pin") {\n` +
        `            __addPin(left);\n` +
        `            __addPin(right);\n` +
        `            const leftRoot = __find(left.key);\n` +
        `            const rightRoot = __find(right.key);\n` +
        `            if (leftRoot !== rightRoot) {\n` +
        `                pinGroups.set(rightRoot, leftRoot);\n` +
        `                const rightNet = explicitNets.get(rightRoot);\n` +
        `                if (rightNet && !explicitNets.has(leftRoot)) {\n` +
        `                    explicitNets.set(leftRoot, rightNet);\n` +
        `                }\n` +
        `            }\n` +
        `            return;\n` +
        `        }\n` +
        `        const pin = left.type === "pin" ? left : right;\n` +
        `        const net = left.type === "net" ? left.ref.value : right.ref.value;\n` +
        `        __addPin(pin);\n` +
        `        const root = __find(pin.key);\n` +
        `        const existing = explicitNets.get(root);\n` +
        `        if (existing && existing !== net) {\n` +
        `            throw new Error(\`Pin "\${pin.key}" connects to both "\${existing}" and "\${net}"\`);\n` +
        `        }\n` +
        `        explicitNets.set(root, net);\n` +
        `        pin.pin.net = net;\n` +
        `    }\n` +
        `\n` +
        `    function __reserveNetName(preferred, usedNames) {\n` +
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
        `                for (const key of keys) {\n` +
        `                    pinsByKey.get(key).pin.net = explicit;\n` +
        `                }\n` +
        `                continue;\n` +
        `            }\n` +
        `            const netName = __reserveNetName(pinsByKey.get(root).defaultNetName, usedNames);\n` +
        `            netList.add(netName);\n` +
        `            compiledNets[netName] = netName;\n` +
        `            for (const key of keys) {\n` +
        `                pinsByKey.get(key).pin.net = netName;\n` +
        `            }\n` +
        `        }\n` +
        `        return { netList, components, nets: compiledNets };\n` +
        `    }\n`;
}

function renderTopJavaScript(filePath) {
    const { source } = loadFile(filePath);
    const topModule = extractBlocks(source, "module", { allowParameters: true })
        .find((module) => module.name === "top");
    if (!topModule) {
        throw new Error("No top module found");
    }

    const statements = splitStatements(topModule.body);
    const { declarations, nameOverrides } = collectTopDeclarations(statements);
    const inputDir = path.dirname(filePath);
    const includes = includedFiles(filePath);
    const requireLines = includes.map((includePath) => {
        const templateName = path.basename(includePath, ".schrune");
        const jsPath = path.join(path.dirname(includePath), `${templateName}.js`);
        const relativePath = `./${path.relative(inputDir, jsPath).replace(/\\/g, "/").replace(/\.js$/, "")}`;
        return `const ${templateName} = require(${jsString(relativePath)});`;
    });
    const includeNames = new Set(includes.map((includePath) => path.basename(includePath, ".schrune")));
    const primitiveNames = [...source.matchAll(/\bnew\s+([A-Za-z_]\w*)\s*\(/g)]
        .map((match) => match[1])
        .filter((name) => createPrimitiveTemplates().has(name) && !includeNames.has(name));
    const primitiveClasses = [...new Set(primitiveNames)].map(renderPrimitiveClass);
    const declarationLines = declarations.map((declaration) => {
        if (declaration.kind === "net") {
            const finalName = nameOverrides.get(declaration.name) || declaration.defaultName;
            return `    const ${declaration.name} = __declareNet(${jsString(declaration.name)}, ${jsString(finalName)}, ${nameOverrides.has(declaration.name)});`;
        }

        const highKey = `${declaration.name}.h`;
        const lowKey = `${declaration.name}.l`;
        return `    const ${declaration.name} = __declareRail(${jsString(declaration.name)}, ${jsString(nameOverrides.get(highKey) || declaration.defaultHigh)}, ${jsString(nameOverrides.get(lowKey) || declaration.defaultLow)}, ${nameOverrides.has(highKey)}, ${nameOverrides.has(lowKey)});`;
    });
    const renderContext = {
        netNames: new Set(declarations.filter((declaration) => declaration.kind === "net").map((declaration) => declaration.name)),
        railNames: new Set(declarations.filter((declaration) => declaration.kind === "rail").map((declaration) => declaration.name)),
    };
    const statementLines = renderStatements(statements, 4, renderContext);

    return [
        ...requireLines,
        requireLines.length && primitiveClasses.length ? "" : undefined,
        ...primitiveClasses,
        "function top() {",
        renderRuntimeHelpers().trimEnd(),
        "",
        ...declarationLines,
        "",
        ...statementLines,
        "",
        "    return __finalize();",
        "}",
        "",
        "module.exports = top;",
        "",
        "if (require.main === module) {",
        "    console.dir(top(), { depth: null });",
        "}",
        "",
    ].filter((line) => line !== undefined).join("\n");
}

function writeStep1JavaScript(filePath) {
    const resolvedPath = path.resolve(filePath);
    const files = [resolvedPath, ...includedFiles(resolvedPath)];

    for (const schrunePath of files) {
        const { source, templates } = loadFile(schrunePath);
        const partName = path.basename(schrunePath, ".schrune");
        const partTemplate = templates.get(partName);
        const outputPath = path.join(path.dirname(schrunePath), `${partName}.js`);

        if (partTemplate && !extractBlocks(source, "module", { allowParameters: true }).some((module) => module.name === "top")) {
            fs.writeFileSync(outputPath, renderPartJavaScript(partTemplate));
            continue;
        }

        fs.writeFileSync(outputPath, renderTopJavaScript(schrunePath));
    }
}

function usage() {
    return [
        "Usage:",
        "  node app.js build [--keep-js] <file.schrune>",
        "  node app.js add <CXXXX>",
        "",
        "Compatibility:",
        "  node app.js [--keep-js] <file.schrune>",
    ].join("\n");
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] && !args[0].startsWith("--") && path.extname(args[0]) !== ".schrune"
        ? args.shift()
        : "build";

    if (command === "add") {
        const partNumber = args[0];
        if (!partNumber) {
            throw new Error(usage());
        }

        const result = await addLcscPart(partNumber);
        console.log(`Added ${result.partName}`);
        console.log(`Part file: ${result.schrunePath}`);
        console.log(`Pins: ${result.pins.length}`);
        if (!result.modelDownloaded) {
            console.log("3D STEP model payload was not directly downloadable.");
        }
        return;
    }

    if (command !== "build") {
        throw new Error(usage());
    }

    const keepJs = args.includes("--keep-js");
    const inputFile = args.find((arg) => arg !== "--keep-js");
    if (!inputFile || path.extname(inputFile) !== ".schrune") {
        throw new Error(usage());
    }

    const inputPath = path.resolve(process.cwd(), inputFile);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`File not found: ${inputFile}`);
    }

    if (keepJs) {
        writeStep1JavaScript(inputPath);
    }

    console.dir(step1(inputPath), { depth: null });
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    step1,
    writeStep1JavaScript,
    main,
};
