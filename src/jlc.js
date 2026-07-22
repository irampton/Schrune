const JLC_SEARCH_URL = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2";

const JLC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://jlcpcb.com",
    Referer: "https://jlcpcb.com/parts",
    "Content-Type": "application/json",
};

function searchPayload(query, limit) {
    return {
        keyword: query,
        currentPage: 1,
        pageSize: Math.min(Math.max(limit, 1), 100),
        presaleType: "stock",
        searchType: 2,
        componentLibraryType: null,
        componentAttributeList: [],
        componentBrandList: [],
        componentSpecificationList: [],
        paramList: [],
        firstSortName: null,
        secondSortName: null,
        searchSource: "search",
        stockFlag: false,
    };
}

function parsePriceList(prices) {
    const normalized = [];
    let unitCost;

    for (const price of prices || []) {
        const qFrom = price.startNumber ?? price.qFrom;
        const qTo = price.endNumber ?? price.qTo;
        const rawPrice = price.productPrice ?? price.price;
        const parsedPrice = rawPrice === undefined || rawPrice === null ? undefined : Number(rawPrice);
        const value = Number.isFinite(parsedPrice) ? parsedPrice : undefined;
        normalized.push({ qFrom, qTo, price: value });
        if (unitCost === undefined && (qFrom === undefined || qFrom === null || Number(qFrom) <= 1)) {
            unitCost = value;
        }
    }

    if (unitCost === undefined && normalized.length) {
        unitCost = normalized[0].price;
    }

    return { unitCost, prices: normalized };
}

function boolish(value) {
    return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function normalizeJlcPart(product) {
    const { unitCost, prices } = parsePriceList(product.componentPrices || product.price);
    const attributes = {};
    for (const attr of product.attributes || []) {
        const name = attr.attribute_name_en || attr.name;
        const value = attr.attribute_value_name || attr.value;
        if (name) {
            attributes[name] = value;
        }
    }

    return {
        lcsc: product.componentCode || product.lcsc,
        manufacturer: product.componentBrandEn || product.manufacturer || "",
        mpn: product.componentModelEn || product.mpn || "",
        package: product.componentSpecificationEn || product.package || "",
        description: product.describe || product.description || "",
        datasheetUrl: product.dataManualUrl || product.datasheet_url || product.datasheetUrl || "",
        stock: Number(product.stockCount || product.stock || 0),
        unitCost,
        isBasic: boolish(product.is_basic ?? product.isBasic ?? product.componentLibraryType === "base"),
        isPreferred: boolish(
            product.is_preferred
            ?? product.isPreferred
            ?? product.preferredComponentFlag
            ?? product.preferredPart
            ?? product.componentLibraryType === "preferential"
        ),
        prices,
        attributes,
    };
}

async function searchJlcParts(query, options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    if (!fetchImpl) {
        throw new Error("This Node.js runtime does not provide fetch");
    }

    const limit = options.limit || 50;
    const response = await fetchImpl(JLC_SEARCH_URL, {
        method: "POST",
        headers: JLC_HEADERS,
        body: JSON.stringify(searchPayload(query, limit)),
    });
    if (!response.ok) {
        throw new Error(`JLC search failed ${response.status}`);
    }

    const payload = await response.json();
    if (payload.code && payload.code !== 200) {
        throw new Error(`JLC search failed: ${payload.message || "unknown error"}`);
    }

    const products = payload.data && payload.data.componentPageInfo
        ? payload.data.componentPageInfo.list || []
        : payload.list || [];

    return products
        .map(normalizeJlcPart)
        .filter((part) => part.lcsc)
        .slice(0, limit);
}

function partSortKey(part) {
    return [
        part.stock > 0 ? 0 : 1,
        part.isPreferred ? 0 : 1,
        part.isBasic ? 0 : 1,
        -part.stock,
        part.unitCost === undefined ? Number.POSITIVE_INFINITY : part.unitCost,
        String(part.lcsc),
    ];
}

function compareSortKeys(left, right) {
    for (let i = 0; i < left.length; i++) {
        if (left[i] < right[i]) {
            return -1;
        }
        if (left[i] > right[i]) {
            return 1;
        }
    }
    return 0;
}

function selectBestJlcPart(parts) {
    return [...parts].sort((left, right) => compareSortKeys(partSortKey(left), partSortKey(right)))[0];
}

module.exports = {
    normalizeJlcPart,
    searchJlcParts,
    selectBestJlcPart,
};
