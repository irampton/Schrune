const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeJlcPart, searchJlcParts, selectBestJlcPart } = require("../../src/jlc");

test("normalizes JLC product payloads", () => {
    const part = normalizeJlcPart({
        componentCode: "C25804",
        componentBrandEn: "YAGEO",
        componentModelEn: "RC0603FR-0710KL",
        componentSpecificationEn: "0603",
        describe: "10k resistor",
        stockCount: "1200",
        componentLibraryType: "preferential",
        componentPrices: [
            { startNumber: 1, endNumber: 9, productPrice: "0.001" },
            { startNumber: 10, endNumber: 99, productPrice: "0.0008" },
        ],
        attributes: [
            { attribute_name_en: "Resistance", attribute_value_name: "10k" },
            { attribute_name_en: "Tolerance", attribute_value_name: "1%" },
        ],
    });

    assert.deepEqual(part, {
        lcsc: "C25804",
        manufacturer: "YAGEO",
        mpn: "RC0603FR-0710KL",
        package: "0603",
        description: "10k resistor",
        datasheetUrl: "",
        stock: 1200,
        unitCost: 0.001,
        isBasic: false,
        isPreferred: true,
        prices: [
            { qFrom: 1, qTo: 9, price: 0.001 },
            { qFrom: 10, qTo: 99, price: 0.0008 },
        ],
        attributes: {
            Resistance: "10k",
            Tolerance: "1%",
        },
    });
});

test("selects stocked preferred parts before cheaper unavailable parts", () => {
    const selected = selectBestJlcPart([
        { lcsc: "C1", stock: 0, isPreferred: true, isBasic: true, unitCost: 0.001 },
        { lcsc: "C2", stock: 100, isPreferred: false, isBasic: true, unitCost: 0.002 },
        { lcsc: "C3", stock: 100, isPreferred: true, isBasic: false, unitCost: 0.003 },
    ]);

    assert.equal(selected.lcsc, "C3");
});

test("searchJlcParts posts a bounded search payload and normalizes results", async () => {
    let request;
    const fetch = async (url, options) => {
        request = { url, options };
        return {
            ok: true,
            async json() {
                return {
                    code: 200,
                    data: {
                        componentPageInfo: {
                            list: [
                                { componentCode: "C1", stockCount: 5 },
                                { componentCode: "", stockCount: 5 },
                                { componentCode: "C2", stockCount: 10 },
                            ],
                        },
                    },
                };
            },
        };
    };

    const parts = await searchJlcParts("10k 0603 resistor", { fetch, limit: 1 });

    assert.match(request.url, /jlcpcb\.com\/api\/overseas-pcb-order/);
    assert.equal(request.options.method, "POST");
    assert.equal(JSON.parse(request.options.body).pageSize, 1);
    assert.deepEqual(parts.map((part) => part.lcsc), ["C1"]);
});

test("searchJlcParts reports API failures", async () => {
    await assert.rejects(
        () => searchJlcParts("missing", {
            fetch: async () => ({
                ok: true,
                async json() {
                    return { code: 500, message: "bad query" };
                },
            }),
        }),
        /JLC search failed: bad query/
    );
});
