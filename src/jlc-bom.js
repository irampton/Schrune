const fs = require("fs");
const path = require("path");
const { searchJlcParts, selectBestJlcPart } = require("./jlc");
const { buildPathsForEntry, findProjectConfigInDirectory } = require("./project");

const ANSI = {
    reset: "\x1b[0m",
    gray: "\x1b[90m",
};

const SECTION_ORDER = [
    { key: "basic", title: "Basic" },
    { key: "promoted", title: "Promoted Extended" },
    { key: "extended", title: "Extended" },
];

function supportsColor(stream = process.stdout) {
    return process.env.FORCE_COLOR || (stream && stream.isTTY && !process.env.NO_COLOR);
}

function colorize(value, color, stream = process.stdout) {
    if (!supportsColor(stream)) {
        return value;
    }
    return `${ANSI[color]}${value}${ANSI.reset}`;
}

function parseCsvLine(line) {
    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const next = line[index + 1];

        if (char === "\"") {
            if (inQuotes && next === "\"") {
                current += "\"";
                index++;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }

        if (char === "," && !inQuotes) {
            cells.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    cells.push(current);
    return cells;
}

function parseBomCsv(source) {
    const lines = String(source || "").trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
        return [];
    }

    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const cells = parseCsvLine(line);
        const row = {};
        for (let index = 0; index < headers.length; index++) {
            row[headers[index]] = cells[index] || "";
        }
        return {
            designators: String(row.Designator || "").trim().split(/\s+/).filter(Boolean),
            footprint: String(row.Footprint || "").trim(),
            comment: String(row.Comment || "").trim(),
            mpn: String(row["Manufacturer Part Number"] || "").trim(),
            manufacturer: String(row.Manufacturer || "").trim(),
            quantity: Number(row.Quantity || 0),
            lcsc: String(row.LCSC || "").trim().toUpperCase(),
        };
    });
}

function selectPriceForQuantity(prices, quantity, fallback) {
    const target = Math.max(1, Number(quantity) || 1);
    for (const price of prices || []) {
        const from = Number(price.qFrom || 0);
        const to = price.qTo === undefined || price.qTo === null ? Number.POSITIVE_INFINITY : Number(price.qTo);
        if (target >= from && target <= to) {
            return Number(price.price);
        }
    }

    return Number.isFinite(fallback) ? fallback : undefined;
}

async function fetchJlcPartByLcsc(lcsc, options = {}) {
    const parts = await (options.searchJlcParts || searchJlcParts)(lcsc, {
        limit: 20,
        fetch: options.fetch,
    });
    const exact = parts.find((part) => String(part.lcsc || "").toUpperCase() === String(lcsc || "").toUpperCase());
    return exact || selectBestJlcPart(parts) || undefined;
}

function sectionKeyForPart(part) {
    if (!part) {
        return "extended";
    }
    if (part.isBasic) {
        return "basic";
    }
    if (part.isPreferred) {
        return "promoted";
    }
    return "extended";
}

function truncate(value, max) {
    const text = String(value || "");
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function formatMoney(value, digits = 4) {
    const amount = Number(value || 0);
    return `$${amount.toFixed(digits)}`;
}

function formatEstimateMoney(value) {
    return `$${Number(value || 0).toFixed(2)}`;
}

function pad(value, width, align = "left") {
    const text = String(value ?? "");
    if (text.length >= width) {
        return text;
    }
    return align === "right"
        ? `${" ".repeat(width - text.length)}${text}`
        : `${text}${" ".repeat(width - text.length)}`;
}

function renderTable(rows) {
    const headers = ["Designators", "Comment", "Footprint", "MPN", "LCSC #", "JLC Stock", "Per Board"];
    const body = rows.map((row) => [
        truncate(row.designators.join(", "), 26),
        truncate(row.comment, 28),
        truncate(row.footprint, 16),
        truncate(row.mpn, 26),
        row.lcsc,
        row.stockDisplay,
        formatMoney(row.perBoardCost),
    ]);

    const widths = headers.map((header, column) => Math.max(
        header.length,
        ...body.map((cells) => String(cells[column]).length)
    ));

    const renderRow = (cells) => cells.map((cell, column) => {
        const align = column >= 5 ? "right" : "left";
        return pad(cell, widths[column], align);
    }).join("  ");

    return [
        renderRow(headers),
        renderRow(headers.map((header, index) => "-".repeat(Math.max(header.length, widths[index])))),
        ...body.map(renderRow),
    ].join("\n");
}

function findFootprintCandidates(partsDir, row) {
    const candidates = [];
    const names = [
        row.mpn,
        row.footprint,
    ].filter(Boolean);

    for (const name of names) {
        candidates.push(path.join(partsDir, name, `${name}.kicad_mod`));
        candidates.push(path.join(partsDir, "autogenerated", name, `${name}.kicad_mod`));
    }

    return candidates;
}

function countFootprintJoints(partsDir, row) {
    for (const candidate of findFootprintCandidates(partsDir, row)) {
        if (!fs.existsSync(candidate)) {
            continue;
        }
        const source = fs.readFileSync(candidate, "utf8");
        const matches = source.match(/\(pad\b/g);
        return matches ? matches.length : 0;
    }
    return 0;
}

function rateForStandardJoints(totalJoints) {
    if (totalJoints > 100000) {
        return 0.0011;
    }
    if (totalJoints > 50000) {
        return 0.0013;
    }
    return 0.0016;
}

function sum(values) {
    return values.reduce((total, value) => total + Number(value || 0), 0);
}

function calculateEconomicEstimate(rows, boards) {
    const componentCost = sum(rows.map((row) => row.totalPurchaseCostForBoards(boards)));
    const totalJoints = sum(rows.map((row) => row.jointsPerBoard * boards));
    const extendedFeeCount = rows.filter((row) => row.section === "extended").length;
    return {
        setup: 8,
        stencil: 1.5,
        joints: totalJoints * 0.0016,
        components: componentCost,
        extendedFees: extendedFeeCount * 3,
        total: 8 + 1.5 + (totalJoints * 0.0016) + componentCost + (extendedFeeCount * 3),
    };
}

function calculateStandardEstimate(rows, boards) {
    const componentCost = sum(rows.map((row) => row.totalPurchaseCostForBoards(boards)));
    const totalJoints = sum(rows.map((row) => row.jointsPerBoard * boards));
    const rate = rateForStandardJoints(totalJoints);
    const loaderFeeCount = rows.filter((row) => row.section === "basic" || row.section === "extended").length;
    return {
        setup: 25,
        stencil: 7.68,
        joints: totalJoints * rate,
        jointRate: rate,
        components: componentCost,
        loaderFees: loaderFeeCount * 1.5,
        total: 25 + 7.68 + (totalJoints * rate) + componentCost + (loaderFeeCount * 1.5),
    };
}

function renderEstimateBreakdown(title, estimate, kind) {
    const lines = [title];
    lines.push(`  Setup: ${formatEstimateMoney(estimate.setup)}`);
    lines.push(`  Stencil: ${formatEstimateMoney(estimate.stencil)}`);
    if (kind === "standard") {
        lines.push(`  Joints @ ${formatMoney(estimate.jointRate, 4)}: ${formatEstimateMoney(estimate.joints)}`);
        lines.push(`  Feed loaders: ${formatEstimateMoney(estimate.loaderFees)}`);
    } else {
        lines.push(`  Joints: ${formatEstimateMoney(estimate.joints)}`);
        lines.push(`  Extended parts fees: ${formatEstimateMoney(estimate.extendedFees)}`);
    }
    lines.push(`  Components: ${formatEstimateMoney(estimate.components)}`);
    lines.push(`  Total estimate: ${formatEstimateMoney(estimate.total)}`);
    return lines.join("\n");
}

function renderEstimateSeries(title, counts, calculator) {
    const labels = counts.map((count) => `${count} boards`);
    const values = counts.map((count) => formatEstimateMoney(calculator(count).total));
    const width = Math.max(...labels.map((label) => label.length));
    return [
        title,
        ...labels.map((label, index) => `${pad(label, width)}  ${values[index]}`),
    ].join("\n");
}

async function buildJlcBom(options = {}) {
    const cwd = path.resolve(options.cwd || process.cwd());
    const project = findProjectConfigInDirectory(cwd);
    if (!project) {
        throw new Error("No schrune.json found in the current directory");
    }

    const entryField = project.config.entry || project.config.topFile;
    if (!entryField || typeof entryField !== "string") {
        throw new Error("schrune.json is missing an \"entry\" path");
    }

    const entryPath = path.resolve(project.dir, entryField);
    const projectName = project.config.name || path.basename(entryPath, ".schrune");
    const bomPath = buildPathsForEntry(entryPath, projectName).bomPath;
    if (!fs.existsSync(bomPath)) {
        throw new Error(`BOM not found: ${bomPath}. Run "schrune build" first.`);
    }

    const boardCount = options.boardCount || 5;
    const bomRows = parseBomCsv(fs.readFileSync(bomPath, "utf8")).filter((row) => row.lcsc);
    const partsDir = path.join(path.dirname(entryPath), "parts");
    const stockWarnings = [];
    const enrichedRows = [];

    for (const row of bomRows) {
        const jlcPart = await fetchJlcPartByLcsc(row.lcsc, options);
        const pricePerUnit = selectPriceForQuantity(jlcPart && jlcPart.prices, row.quantity * boardCount, jlcPart && jlcPart.unitCost) || 0;
        const section = sectionKeyForPart(jlcPart);
        const perBoardCost = pricePerUnit * row.quantity;
        const jointsPerBoard = countFootprintJoints(partsDir, row) * row.quantity;
        const stock = jlcPart ? Number(jlcPart.stock || 0) : undefined;
        const requiredQuantity = row.quantity * boardCount;

        if (options.boardCount && (!Number.isFinite(stock) || stock < requiredQuantity)) {
            stockWarnings.push({
                row,
                available: Number.isFinite(stock) ? stock : undefined,
                required: requiredQuantity,
            });
        }

        enrichedRows.push({
            ...row,
            jlcPart,
            section,
            stock,
            stockDisplay: Number.isFinite(stock) ? String(stock) : "?",
            perBoardCost,
            jointsPerBoard,
            totalPurchaseCostForBoards(count) {
                const unitPrice = selectPriceForQuantity(jlcPart && jlcPart.prices, row.quantity * count, jlcPart && jlcPart.unitCost) || 0;
                return unitPrice * row.quantity * count;
            },
        });
    }

    const sections = Object.fromEntries(SECTION_ORDER.map(({ key }) => [key, []]));
    for (const row of enrichedRows) {
        sections[row.section].push(row);
    }

    return {
        boardCount,
        sections,
        rows: enrichedRows,
        stockWarnings,
    };
}

function renderJlcBomReport(report, options = {}) {
    const lines = [];
    lines.push(`JLC BOM estimate for ${report.boardCount} board${report.boardCount === 1 ? "" : "s"}`);
    lines.push("");

    for (const section of SECTION_ORDER) {
        const rows = report.sections[section.key];
        if (!rows.length) {
            continue;
        }
        lines.push(section.title);
        lines.push(renderTable(rows));
        lines.push("");
    }

    lines.push("Cost estimate only. These figures ignore board size, layer count, and SMD vs manual assembly.");
    lines.push("");

    if (options.showBreakdown) {
        lines.push(renderEstimateBreakdown(
            `Economic estimate for ${report.boardCount} board${report.boardCount === 1 ? "" : "s"}`,
            calculateEconomicEstimate(report.rows, report.boardCount),
            "economic"
        ));
        lines.push("");
        lines.push(renderEstimateBreakdown(
            `Standard estimate for ${report.boardCount} board${report.boardCount === 1 ? "" : "s"}`,
            calculateStandardEstimate(report.rows, report.boardCount),
            "standard"
        ));
        lines.push("");
    }

    lines.push(renderEstimateSeries("Economic totals", [2, 5, 15, 30], (count) => calculateEconomicEstimate(report.rows, count)));
    lines.push("");
    lines.push(renderEstimateSeries("Standard totals", [5, 30, 100, 1000], (count) => calculateStandardEstimate(report.rows, count)));
    lines.push("");
    lines.push(colorize("Additional fees may apply: $3.50 hand-soldering, $59.23 large-sized boards, plus x-ray inspection and panel fees.", "gray", options.stream || process.stdout));
    lines.push(colorize("Double-sided boards require standard assembly, can add $25 setup, and add $7.86 stencil cost.", "gray", options.stream || process.stdout));

    if (report.stockWarnings.length) {
        lines.push("");
        lines.push("Potential stock issues");
        for (const warning of report.stockWarnings) {
            const available = warning.available === undefined ? "unknown stock" : `${warning.available} in stock`;
            lines.push(`- ${warning.row.lcsc} (${warning.row.comment}): need ${warning.required}, ${available}`);
        }
    }

    return `${lines.join("\n")}\n`;
}

module.exports = {
    buildJlcBom,
    calculateEconomicEstimate,
    calculateStandardEstimate,
    parseBomCsv,
    renderJlcBomReport,
    selectPriceForQuantity,
};
