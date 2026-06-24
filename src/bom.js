const fs = require("fs");
const path = require("path");
const { addLcscPart } = require("./lcsc");
const { searchJlcParts, selectBestJlcPart } = require("./jlc");

const GENERIC_TYPES = new Set(["Resistor", "Capacitor", "Inductor", "Diode"]);
const LOCK_VERSION = 1;

function designatorPrefix(component) {
    return component.info && component.info.designatorPrefix
        ? component.info.designatorPrefix
        : "U";
}

function pinNetList(component) {
    return component.pins
        .filter(Boolean)
        .map((pin) => pin.net || "")
        .sort();
}

function componentKind(component) {
    return component.constructor && component.constructor.name || "Component";
}

function componentSignature(component) {
    return JSON.stringify({
        type: componentKind(component),
        value: component.value,
        footprint: component.footprint || component.info && component.info.footprint,
        voltage: component.voltage,
        power: component.power,
        tolerance: component.tolerance,
        nets: pinNetList(component),
    });
}

function componentIdentity(component) {
    const schrune = component.__schrune || {};
    const modulePath = Array.isArray(schrune.modulePath) ? schrune.modulePath.join(".") : "";
    const name = schrune.name || "";
    const arrayIndex = schrune.arrayIndex === undefined || schrune.arrayIndex === null ? "" : String(schrune.arrayIndex);
    const identity = [modulePath, name, arrayIndex].join("\0");
    return identity.trim() ? identity : undefined;
}

function designatorStatePathFor(filePath) {
    return path.join(path.dirname(filePath), "KiCad", ".schrune-designators.json");
}

function normalizeDesignatorAssignments(assignments = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(assignments)) {
        if (Array.isArray(value)) {
            const cleaned = value.map((entry) => String(entry || "").trim()).filter(Boolean);
            if (cleaned.length) {
                normalized[key] = cleaned;
            }
            continue;
        }

        const text = String(value || "").trim();
        if (text) {
            normalized[key] = [text];
        }
    }
    return normalized;
}

function normalizeDesignatorState(state = {}) {
    return {
        version: LOCK_VERSION,
        assignments: normalizeDesignatorAssignments(state.assignments || state),
    };
}

function readDesignatorState(filePath) {
    const statePath = designatorStatePathFor(filePath);
    if (!fs.existsSync(statePath)) {
        return { version: LOCK_VERSION, assignments: {} };
    }

    return normalizeDesignatorState(JSON.parse(fs.readFileSync(statePath, "utf8")));
}

function writeDesignatorState(filePath, state) {
    const statePath = designatorStatePathFor(filePath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(normalizeDesignatorState(state), null, 2)}\n`);
}

function designatorStateKey(component) {
    const identity = componentIdentity(component);
    return identity ? `${designatorPrefix(component)}\0id:${identity}` : `${designatorPrefix(component)}\0sig:${componentSignature(component)}`;
}

function designatorStateLookupKeys(component) {
    const prefix = designatorPrefix(component);
    const keys = [];
    const identity = componentIdentity(component);
    if (identity) {
        keys.push(`${prefix}\0id:${identity}`);
    }
    keys.push(`${prefix}\0sig:${componentSignature(component)}`);
    return keys;
}

function parseDesignator(designator) {
    const match = String(designator || "").match(/^([A-Za-z_]+)(\d+)$/);
    if (!match) {
        return undefined;
    }

    return {
        prefix: match[1],
        number: Number(match[2]),
    };
}

function buildDesignatorState(stepResult) {
    const assignments = {};
    for (const component of stepResult.components) {
        if (!component.designator) {
            continue;
        }
        const key = designatorStateKey(component);
        if (!assignments[key]) {
            assignments[key] = [];
        }
        assignments[key].push(component.designator);
    }
    return {
        version: LOCK_VERSION,
        assignments,
    };
}

function assignDesignators(stepResult, state = {}) {
    const normalizedState = normalizeDesignatorState(state);
    const usedByPrefix = new Map();

    const components = stepResult.components.map((component, index) => {
        const signature = componentSignature(component);
        component.__schrune = {
            ...(component.__schrune || {}),
            index,
            signature,
        };
        return component;
    });

    components.sort((left, right) => {
        const leftKey = `${designatorPrefix(left)}\0${left.__schrune.signature}\0${left.__schrune.index}`;
        const rightKey = `${designatorPrefix(right)}\0${right.__schrune.signature}\0${right.__schrune.index}`;
        return leftKey.localeCompare(rightKey);
    });

    const grouped = new Map();
    for (const component of components) {
        const key = designatorStateKey(component);
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(component);
    }

    for (const [key, group] of grouped.entries()) {
        const prefix = designatorPrefix(group[0]);
        if (!usedByPrefix.has(prefix)) {
            usedByPrefix.set(prefix, new Set());
        }

        const used = usedByPrefix.get(prefix);
        const previous = designatorStateLookupKeys(group[0])
            .flatMap((lookupKey) => normalizedState.assignments[lookupKey] || [])
            .filter((designator, index, list) => list.indexOf(designator) === index);
        for (const designator of previous) {
            const parsed = parseDesignator(designator);
            if (parsed && parsed.prefix === prefix) {
                used.add(parsed.number);
            }
        }
    }

    for (const [key, group] of grouped.entries()) {
        const prefix = designatorPrefix(group[0]);
        const used = usedByPrefix.get(prefix);
        const previous = designatorStateLookupKeys(group[0])
            .flatMap((lookupKey) => normalizedState.assignments[lookupKey] || [])
            .filter((designator, index, list) => list.indexOf(designator) === index);

        for (let index = 0; index < group.length; index++) {
            const component = group[index];
            const previousDesignator = previous[index];
            const parsed = parseDesignator(previousDesignator);

            if (parsed && parsed.prefix === prefix) {
                component.designator = previousDesignator;
                used.add(parsed.number);
                continue;
            }

            let number = 1;
            while (used.has(number)) {
                number++;
            }

            used.add(number);
            component.designator = `${prefix}${number}`;
        }
    }

    const nextState = buildDesignatorState({ components });

    for (const component of components) {
        if (!component.designator) {
            throw new Error("Failed to assign designator");
        }
    }

    return {
        ...stepResult,
        components: components.sort((left, right) => left.__schrune.index - right.__schrune.index),
        designatorState: nextState,
    };
}

function lockPathFor(filePath) {
    return path.join(path.dirname(filePath), "parts", "autogenerated", "parts-lock.json");
}

function readPartsLock(filePath) {
    const lockPath = lockPathFor(filePath);
    if (!fs.existsSync(lockPath)) {
        return { version: LOCK_VERSION, parts: [], selectors: {}, selectionCache: {} };
    }
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
}

function writePartsLock(filePath, lock) {
    const lockPath = lockPathFor(filePath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function isGenericComponent(component) {
    return GENERIC_TYPES.has(componentKind(component));
}

function componentFilters(component) {
    return {
        type: componentKind(component),
        value: component.value ?? null,
        footprint: component.footprint ?? null,
        voltage: component.voltage ?? component.maxVoltage ?? null,
        power: component.power ?? component.maxPower ?? null,
        tolerance: component.tolerance ?? null,
    };
}

function selectionKeyFromFilters(filters) {
    return JSON.stringify({
        type: filters.type ?? null,
        value: filters.value ?? null,
        footprint: filters.footprint ?? null,
        voltage: filters.voltage ?? null,
        power: filters.power ?? null,
        tolerance: filters.tolerance ?? null,
    });
}

function componentSelectionKey(component) {
    return selectionKeyFromFilters(componentFilters(component));
}

function normalizeSelectionCacheValue(value) {
    if (typeof value === "string") {
        return {
            lcsc: String(value).toUpperCase(),
        };
    }

    if (!value || typeof value !== "object") {
        return undefined;
    }

    const lcsc = String(value.lcsc || value.LCSC || "").toUpperCase();
    if (!lcsc) {
        return undefined;
    }

    return {
        lcsc,
        partName: value.partName || value.part_name,
    };
}

function normalizeSelectionCache(selectionCache = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(selectionCache)) {
        const normalizedValue = normalizeSelectionCacheValue(value);
        if (!normalizedValue) {
            continue;
        }

        let normalizedKey = key;
        try {
            const parsed = JSON.parse(key);
            if (parsed && typeof parsed === "object") {
                normalizedKey = selectionKeyFromFilters(parsed);
            }
        } catch {
            // Keep non-JSON keys as-is.
        }

        normalized[normalizedKey] = normalizedValue;
    }
    return normalized;
}

function normalizeLock(lock) {
    const parts = [];
    const selectors = { ...(lock.selectors || {}) };
    const selectionCache = normalizeSelectionCache(lock.selectionCache || lock.selections || {});

    if (Array.isArray(lock.parts)) {
        for (const part of lock.parts) {
            const normalized = normalizeSelectedPart(part);
            if (normalized && normalized.lcsc) {
                parts.push(normalized);
            }
        }
    }

    // Backward compatibility for the previous verbose lock shape.
    for (const entry of Array.isArray(lock.parts) ? lock.parts : []) {
        if (entry && entry.part) {
            const normalized = normalizeSelectedPart(entry.part);
            if (normalized && normalized.lcsc) {
                parts.push(normalized);
                for (const designator of entry.designators || [entry.designator]) {
                    if (designator && !selectors[designator]) {
                        selectors[designator] = normalized.lcsc;
                    }
                }
            }
        }
    }

    return {
        version: LOCK_VERSION,
        parts: uniqueParts(parts),
        selectors,
        selectionCache,
    };
}

function valueSearchTerm(component) {
    const type = componentKind(component).toLowerCase();
    return [component.value, component.footprint, type]
        .filter(Boolean)
        .join(" ");
}

function normalizeSelectedPart(part) {
    if (!part) {
        return undefined;
    }
    return {
        lcsc: String(part.lcsc || part.LCSC || "").toUpperCase(),
        partName: part.partName || part.part_name,
        manufacturer: part.manufacturer || part.manufacture,
        mpn: part.mpn || part.partNumber,
        package: part.package || part.footprint,
        description: part.description,
        datasheetUrl: part.datasheetUrl || part.datasheet_url,
        stock: part.stock,
        unitCost: part.unitCost ?? part.unit_cost,
        isBasic: part.isBasic ?? part.is_basic,
        isPreferred: part.isPreferred ?? part.is_preferred,
    };
}

function uniqueParts(parts) {
    const byLcsc = new Map();
    for (const part of parts) {
        const normalized = normalizeSelectedPart(part);
        if (normalized && normalized.lcsc) {
            byLcsc.set(normalized.lcsc, {
                ...(byLcsc.get(normalized.lcsc) || {}),
                ...normalized,
            });
        }
    }
    return [...byLcsc.values()].sort((left, right) => left.lcsc.localeCompare(right.lcsc, undefined, { numeric: true }));
}

function findLockedPart(lock, component) {
    const normalizedLock = normalizeLock(lock);
    const lcsc = normalizedLock.selectors[component.designator];
    if (!lcsc) {
        return undefined;
    }
    return normalizedLock.parts.find((part) => part.lcsc === String(lcsc).toUpperCase()) || { lcsc };
}

function findPartByLcsc(lock, lcsc) {
    const normalizedLock = normalizeLock(lock);
    const upper = String(lcsc || "").toUpperCase();
    if (!upper) {
        return undefined;
    }

    return normalizedLock.parts.find((part) => part.lcsc === upper) || { lcsc: upper };
}

function findCachedSelection(lock, component) {
    const normalizedLock = normalizeLock(lock);
    const cached = normalizedLock.selectionCache[componentSelectionKey(component)];
    if (!cached) {
        return undefined;
    }

    if (typeof cached === "string") {
        return normalizedLock.parts.find((part) => part.lcsc === cached.toUpperCase()) || { lcsc: cached };
    }

    const lcsc = String(cached.lcsc || cached.LCSC || "").toUpperCase();
    if (!lcsc) {
        return undefined;
    }

    return normalizedLock.parts.find((part) => part.lcsc === lcsc) || {
        lcsc,
        partName: cached.partName || cached.part_name,
    };
}

function rankedParts(parts) {
    const remaining = [...parts].map(normalizeSelectedPart).filter((part) => part && part.lcsc);
    const ranked = [];

    while (remaining.length) {
        const selected = selectBestJlcPart(remaining);
        ranked.push(selected);
        remaining.splice(remaining.findIndex((part) => part.lcsc === selected.lcsc), 1);
    }

    return ranked;
}

function importedAssetsExist(importResult) {
    if (!importResult || !importResult.directory || !importResult.partName) {
        return false;
    }

    return fs.existsSync(path.join(importResult.directory, `${importResult.partName}.kicad_sym`))
        && fs.existsSync(path.join(importResult.directory, `${importResult.partName}.kicad_mod`));
}

function installedAssetsExist(partsDir, part) {
    if (!part || !part.lcsc || !part.partName) {
        return false;
    }

    const directory = path.join(partsDir, part.partName);
    return fs.existsSync(path.join(directory, `${part.partName}.kicad_sym`))
        && fs.existsSync(path.join(directory, `${part.partName}.kicad_mod`));
}

async function importSelectedPart(part, filePath, partsDir, options) {
    if (options.downloadParts === false) {
        return { ok: true };
    }

    const importer = options.addLcscPart || addLcscPart;
    const result = await importer(part.lcsc, {
        cwd: path.dirname(filePath),
        partsDir,
        fetch: options.fetch,
    });

    return {
        ok: importedAssetsExist(result),
        result,
    };
}

async function autoSelectionCandidates(component, options) {
    if (options.selectParts) {
        return (await options.selectParts(component, componentFilters(component))).map(normalizeSelectedPart);
    }

    if (options.selectPart) {
        const selected = await options.selectPart(component, componentFilters(component));
        return Array.isArray(selected) ? selected.map(normalizeSelectedPart) : [normalizeSelectedPart(selected)];
    }

    const parts = await searchJlcParts(valueSearchTerm(component), {
        fetch: options.fetch,
        limit: 50,
    });
    return rankedParts(parts);
}

function initialSelectionCandidates(component, lock, noPartsLock) {
    if (component.info && component.info.LCSC) {
        return {
            explicit: true,
            parts: [normalizeSelectedPart(findPartByLcsc(lock, component.info.LCSC) || {
                lcsc: component.info.LCSC,
                manufacturer: component.info.manufacture,
                mpn: component.info.partNumber,
                package: component.info.footprint || component.footprint,
            })],
        };
    }

    const lockedPart = noPartsLock ? undefined : findLockedPart(lock, component);
    const cachedPart = noPartsLock || lockedPart ? undefined : findCachedSelection(lock, component);
    return {
        explicit: false,
        parts: lockedPart ? [normalizeSelectedPart(lockedPart)] : cachedPart ? [normalizeSelectedPart(cachedPart)] : [],
    };
}

function applyPartToComponent(component, part) {
    if (!part) {
        return;
    }
    component.selectedPart = part;
    component.info = {
        ...component.info,
        partNumber: part.mpn || component.info.partNumber,
        manufacture: part.manufacturer || component.info.manufacture,
        footprint: part.package || component.info.footprint,
        LCSC: part.lcsc || component.info.LCSC,
    };
}

async function resolveGenericParts(filePath, compiled, options = {}) {
    const noPartsLock = Boolean(options.noPartsLock);
    const lock = noPartsLock ? { version: LOCK_VERSION, parts: [], selectors: {} } : normalizeLock(readPartsLock(filePath));
    const selectedParts = [...lock.parts];
    const selectors = {};
    const selectionCache = { ...(lock.selectionCache || {}) };
    const partsDir = path.join(path.dirname(filePath), "parts", "autogenerated");
    const genericComponents = compiled.components.filter(isGenericComponent);
    options.onProgress && options.onProgress({ current: 0, total: genericComponents.length });

    function persistLock() {
        if (noPartsLock) {
            return;
        }

        lock.parts = uniqueParts(selectedParts);
        lock.selectors = Object.fromEntries(
            Object.entries(selectors).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        );
        lock.selectionCache = Object.fromEntries(
            Object.entries(selectionCache).sort(([left], [right]) => left.localeCompare(right))
        );
        writePartsLock(filePath, {
            version: LOCK_VERSION,
            parts: lock.parts,
            selectors: lock.selectors,
            selectionCache: lock.selectionCache,
        });
    }

    for (let index = 0; index < genericComponents.length; index++) {
        const component = genericComponents[index];
        options.onProgress && options.onProgress({ current: index, total: genericComponents.length, component });
        const selectionKey = componentSelectionKey(component);

        const candidates = initialSelectionCandidates(component, lock, noPartsLock);
        let selectedPart;
        const importErrors = [];
        async function tryCandidates(parts) {
            for (const candidate of parts) {
                if (!candidate || !candidate.lcsc) {
                    continue;
                }

                if (installedAssetsExist(partsDir, candidate)) {
                    return candidate;
                }

                const imported = await importSelectedPart(candidate, filePath, partsDir, options);
                if (imported.ok) {
                    if (imported.result) {
                        candidate.partName = imported.result.partName;
                        candidate.directory = imported.result.directory;
                    }
                    return candidate;
                }

                importErrors.push(`${candidate.lcsc} did not provide KiCad symbol and footprint assets`);
                if (candidates.explicit) {
                    break;
                }
            }
            return undefined;
        }

        selectedPart = await tryCandidates(candidates.parts);
        if (!selectedPart && !candidates.explicit) {
            const fallbackParts = await autoSelectionCandidates(component, options);
            const tried = new Set(candidates.parts.map((part) => part && part.lcsc).filter(Boolean));
            selectedPart = await tryCandidates(uniqueParts(fallbackParts).filter((part) => !tried.has(part.lcsc)));
        }

        if (!selectedPart) {
            const detail = importErrors.length ? ` (${importErrors.join("; ")})` : "";
            throw new Error(`Could not select a JLC/LCSC part for ${component.designator}${detail}`);
        }

        applyPartToComponent(component, selectedPart);
        selectedParts.push(selectedPart);
        selectors[component.designator] = selectedPart.lcsc;
        selectionCache[selectionKey] = {
            lcsc: selectedPart.lcsc,
            partName: selectedPart.partName,
        };
        persistLock();
        options.onProgress && options.onProgress({ current: index + 1, total: genericComponents.length, component });
    }

    const nextLock = {
        version: LOCK_VERSION,
        parts: uniqueParts(selectedParts),
        selectors: Object.fromEntries(
            Object.entries(selectors).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        ),
        selectionCache: Object.fromEntries(
            Object.entries(selectionCache).sort(([left], [right]) => left.localeCompare(right))
        ),
    };
    if (!noPartsLock) {
        writePartsLock(filePath, nextLock);
    }

    return {
        ...compiled,
        partsLock: nextLock,
    };
}

function bomIdentity(component) {
    const selected = component.selectedPart || {};
    return [
        selected.lcsc || component.info && component.info.LCSC || "",
        selected.mpn || component.info && component.info.partNumber || componentKind(component),
        component.value || "",
        component.footprint || component.info && component.info.footprint || "",
    ].join("\0");
}

function makeBomRows(compiled) {
    const groups = new Map();

    for (const component of compiled.components) {
        const key = bomIdentity(component);
        if (!groups.has(key)) {
            const selected = component.selectedPart || {};
            groups.set(key, {
                designators: [],
                quantity: 0,
                manufacturer: selected.manufacturer || component.info && component.info.manufacture || "",
                mpn: selected.mpn || component.info && component.info.partNumber || "",
                lcsc: selected.lcsc || component.info && component.info.LCSC || "",
                value: component.value || "",
                footprint: selected.package || component.footprint || component.info && component.info.footprint || "",
                type: componentKind(component),
                description: selected.description || "",
                stock: selected.stock ?? "",
                unitCost: selected.unitCost ?? "",
                isBasic: selected.isBasic ?? "",
                isPreferred: selected.isPreferred ?? "",
            });
        }

        const row = groups.get(key);
        row.quantity++;
        row.designators.push(component.designator);
    }

    return [...groups.values()].sort((left, right) => left.designators[0].localeCompare(right.designators[0], undefined, { numeric: true }));
}

function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function bomCsv(rows) {
    const headers = [
        "Designator",
        "Quantity",
        "Manufacturer",
        "Manufacturer Part Number",
        "LCSC",
        "Value",
        "Footprint",
        "Type",
        "Description",
        "Stock",
        "Unit Cost",
        "Basic",
        "Preferred",
    ];
    const lines = [headers.join(",")];
    for (const row of rows) {
        lines.push([
            row.designators.join(" "),
            row.quantity,
            row.manufacturer,
            row.mpn,
            row.lcsc,
            row.value,
            row.footprint,
            row.type,
            row.description,
            row.stock,
            row.unitCost,
            row.isBasic,
            row.isPreferred,
        ].map(csvEscape).join(","));
    }
    return `${lines.join("\n")}\n`;
}

function writeBomCsv(filePath, rows) {
    const parsed = path.parse(filePath);
    const outputPath = path.join(parsed.dir, `${parsed.name}.BOM.csv`);
    fs.writeFileSync(outputPath, bomCsv(rows));
    return outputPath;
}

async function step3(filePath, compiled, options = {}) {
    const resolved = await resolveGenericParts(filePath, compiled, options);
    const bomRows = makeBomRows(resolved);
    const bomPath = writeBomCsv(filePath, bomRows);
    return {
        ...resolved,
        bomRows,
        bomPath,
    };
}

module.exports = {
    assignDesignators,
    bomCsv,
    buildDesignatorState,
    componentFilters,
    componentSignature,
    designatorStatePathFor,
    lockPathFor,
    makeBomRows,
    normalizeDesignatorState,
    readPartsLock,
    readDesignatorState,
    resolveGenericParts,
    step3,
    writeDesignatorState,
    writeBomCsv,
};
