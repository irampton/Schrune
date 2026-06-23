const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assignDesignators, step1, writeKiCadFiles } = require("../../src/app");

const partFile = `part TestPart {
    info: {
        partNumber: "TestPart",
        manufacture: "TestCo",
        footprint: "./TestPart.kicad_mod",
        symbol: "./TestPart.kicad_sym",
        designatorPrefix: "U",
    }

    pins: [
        IN:1,
        GND:2,
    ]
}
`;

const symbolFile = `(kicad_symbol_lib (version 20211014) (generator Schrune)
  (symbol "TestPart" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
    (property "Reference" "U?" (at 0 5.08 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" "TestPart" (at 0 -5.08 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Footprint" "./TestPart.kicad_mod" (at 0 -7.62 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "" (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (symbol "TestPart_0_1"
      (rectangle (start -5.08 2.54) (end 5.08 -2.54)
        (stroke (width 0.254) (type default))
        (fill (type background))
      )
      (pin passive line (at -7.62 1.27 0) (length 2.54)
        (name "IN" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))
      )
      (pin passive line (at 7.62 -1.27 180) (length 2.54)
        (name "GND" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27))))
      )
    )
  )
)
`;

const compactSymbolFile = `(kicad_symbol_lib (version 20251024) (generator "Schrune") (generator_version "10.0") (symbol "TestPart" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
  (property "Reference" "U?" (at 0 5.08 0)
    (effects (font (size 1.27 1.27)))
  )
  (property "Value" "TestPart" (at 0 -5.08 0)
    (effects (font (size 1.27 1.27)))
  )
  (property "Footprint" "./TestPart.kicad_mod" (at 0 -7.62 0)
    (effects (font (size 1.27 1.27)) hide)
  )
  (property "Datasheet" "" (at 0 0 0)
    (effects (font (size 1.27 1.27)) hide)
  )
  (symbol "TestPart_0_1"
    (rectangle (start -5.08 2.54) (end 5.08 -2.54)
      (stroke (width 0.254) (type default))
      (fill (type background))
    )
    (pin passive line (at -7.62 1.27 0) (length 2.54)
      (name "IN" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27))))
    )
    (pin passive line (at 7.62 -1.27 180) (length 2.54)
      (name "GND" (effects (font (size 1.27 1.27))))
      (number "2" (effects (font (size 1.27 1.27))))
    )
  )
))
`;

const footprintFile = `(footprint "TestPart" (version 20221018) (generator Schrune)
  (attr smd)
  (fp_text reference "REF**" (at 0 -2 0) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text value "TestPart" (at 0 2 0) (layer "F.Fab")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (pad "1" smd rect (at -1 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd rect (at 1 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
)
`;

function makeFixture(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-kicad-"));
    const partsDir = path.join(dir, "parts", "TestPart");
    fs.mkdirSync(partsDir, { recursive: true });
    fs.writeFileSync(path.join(partsDir, "TestPart.schrune"), options.partFile || partFile);
    if (options.writeAssets !== false) {
        fs.writeFileSync(path.join(partsDir, "TestPart.kicad_sym"), symbolFile);
        fs.writeFileSync(path.join(partsDir, "TestPart.kicad_mod"), footprintFile);
    }
    const filePath = path.join(dir, "fixture.schrune");
    fs.writeFileSync(filePath, options.source || `#include "TestPart.schrune"

module top () {
    rail power;
    net signal;
    power.l.name = "GND";
    part u = new TestPart();
    u.IN ~ signal;
    u.GND ~ power.l;
}
`);
    return { dir, filePath };
}

test("writes KiCad project, schematic, and PCB files", () => {
    const fixture = makeFixture();
    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);

        assert.equal(fs.existsSync(result.kicadProjectPath), true);
        assert.equal(fs.existsSync(result.schematicPath), true);
        assert.equal(fs.existsSync(result.pcbPath), true);

        const schematic = fs.readFileSync(result.schematicPath, "utf8");
        assert.match(schematic, /\(kicad_sch \(version 20260306\) \(generator "Schrune"\) \(generator_version "10\.0"\)/);
        assert.match(schematic, /\(symbol "TestPart"/);
        assert.match(schematic, /\(property "Reference" "U1" \(at /);
        assert.match(schematic, /\(property "Value" "TestPart" \(at /);
        assert.match(schematic, /\(property "Footprint" "Schrune:TestPart" \(at [^)]*\) \(hide yes\)/);
        assert.match(schematic, /\(property "Reference" "U\?"[\s\S]*?\(hide yes\)[\s\S]*?\(effects/);
        assert.match(schematic, /\(property "Value" "TestPart"[\s\S]*?\(hide yes\)[\s\S]*?\(effects/);
        const referenceProperty = schematic.match(/    \(property "Reference" "U1"[\s\S]*?\n    \)/)[0];
        assert.doesNotMatch(referenceProperty, /\(id /);
        assert.doesNotMatch(referenceProperty, /\(uuid /);
        assert.doesNotMatch(referenceProperty, /hide/);
        assert.match(schematic, /\(instances/);
        assert.match(schematic, /\(reference "U1"\)/);
        assert.match(schematic, /\(sheet_instances/);
        assert.match(schematic, /\(label "signal"/);
        assert.match(schematic, /\(label "GND"/);
        assert.doesNotMatch(schematic, /power:/);

        const pcb = fs.readFileSync(result.pcbPath, "utf8");
        assert.match(pcb, /\(kicad_pcb \(version 20260206\) \(generator "Schrune"\) \(generator_version "10\.0"\)/);
        assert.match(pcb, /\(net 1 "GND"\)|\(net 2 "GND"\)/);
        assert.match(pcb, /\(footprint "Schrune:TestPart"/);
        assert.match(pcb, /\(fp_text reference "U1"/);
        assert.doesNotMatch(pcb, /REF\*\*/);
        assert.match(pcb, /\(net \d+ "signal"\)/);
        assert.doesNotMatch(pcb, /\(at [^)]*\(net /);
        assert.doesNotMatch(pcb, /\(fill \(type none\)\)/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("handles rail pin groups without recursing forever", () => {
    const fixture = makeFixture({
        partFile: `part TestPart {
    info: {
        partNumber: "TestPart",
        manufacture: "TestCo",
        footprint: "./TestPart.kicad_mod",
        symbol: "./TestPart.kicad_sym",
        designatorPrefix: "U",
    }

    pins: [
        rail VBUS: {
            h: A1~A2,
            l: B1~B2,
        },
        IN:1,
    ]
}
`,
        source: `#include "TestPart.schrune"

module top () {
    rail power;
    part u = new TestPart();
    u.VBUS ~ power;
}
`,
    });

    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        assert.equal(fs.existsSync(result.schematicPath), true);
        assert.equal(fs.existsSync(result.pcbPath), true);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("loads compact KiCad symbol libraries across format variations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-kicad-compact-"));
    const partsDir = path.join(dir, "parts", "TestPart");
    fs.mkdirSync(partsDir, { recursive: true });
    fs.writeFileSync(path.join(partsDir, "TestPart.schrune"), partFile);
    fs.writeFileSync(path.join(partsDir, "TestPart.kicad_sym"), compactSymbolFile);
    fs.writeFileSync(path.join(partsDir, "TestPart.kicad_mod"), footprintFile);
    const filePath = path.join(dir, "fixture.schrune");
    fs.writeFileSync(filePath, `#include "TestPart.schrune"

module top () {
    part u = new TestPart();
}
`);

    try {
        const compiled = assignDesignators(step1(filePath));
        const result = writeKiCadFiles(filePath, compiled);
        assert.equal(fs.existsSync(result.schematicPath), true);
        assert.equal(fs.existsSync(result.pcbPath), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("uses net labels for rail nets instead of power symbols", () => {
    const fixture = makeFixture();
    try {
        fs.writeFileSync(fixture.filePath, `#include "TestPart.schrune"

module top () {
    rail power;
    power.h.name = "3V3";
    power.l.name = "GND";
    part u = new TestPart();
    u.IN ~ power.h;
    u.GND ~ power.l;
}
`);
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        const schematic = fs.readFileSync(result.schematicPath, "utf8");

        assert.match(schematic, /\(label "3V3"/);
        assert.match(schematic, /\(label "GND"/);
        assert.doesNotMatch(schematic, /power:/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("embeds downloaded footprint geometry without synthetic repair", () => {
    const fixture = makeFixture();
    try {
        const partsDir = path.join(fixture.dir, "parts", "HeaderPart");
        fs.mkdirSync(partsDir, { recursive: true });
        fs.writeFileSync(path.join(partsDir, "HeaderPart.schrune"), partFile
            .replace(/part TestPart/, "part HeaderPart")
            .replace(/partNumber: "TestPart"/, 'partNumber: "Pin Header"')
            .replace(/designatorPrefix: "U"/, 'designatorPrefix: "J"')
            .replace(/TestPart/g, "HeaderPart"));
        fs.writeFileSync(path.join(partsDir, "HeaderPart.kicad_sym"), symbolFile.replace(/TestPart/g, "HeaderPart").replace(/"U\?"/, '"J?"'));
        fs.writeFileSync(path.join(partsDir, "HeaderPart.kicad_mod"), footprintFile
            .replace(/TestPart/g, "HeaderPart")
            .replace(/\n\)/, "\n  (fp_arc (start -9.98 -0.00) (end -9.95 1.00) (angle -180.00) (layer F.SilkS) (width 0.25))\n)")
            .replace(/\(fp_text reference[\s\S]*?\n  \)/, "")
            .replace(/\(fp_text value[\s\S]*?\n  \)/, ""));
        fs.writeFileSync(fixture.filePath, `#include "HeaderPart.schrune"

module top () {
    net left;
    net right;
    part j = new HeaderPart();
    j.IN ~ left;
    j.GND ~ right;
}
`);
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        const pcb = fs.readFileSync(result.pcbPath, "utf8");

        assert.match(pcb, /\(attr smd\)/);
        assert.match(pcb, /\(fp_text reference "J1"/);
        assert.match(pcb, /\(pad "1" smd rect/);
        assert.match(pcb, /\(fp_arc \(start -9\.95 1\.00\) \(mid -8\.98 -0\.03\) \(end -10\.01 -1\.00\)/);
        assert.doesNotMatch(pcb, /\(angle -180\.00\)/);
        assert.doesNotMatch(pcb, /\(drill /);
        assert.doesNotMatch(pcb, /\(fp_rect /);
        assert.doesNotMatch(pcb, /\(attr through_hole\)/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("throws a build error when a KiCad asset is missing", () => {
    const fixture = makeFixture({ writeAssets: false });
    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        assert.throws(() => writeKiCadFiles(fixture.filePath, compiled), /U1 is missing a \.kicad_sym asset/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("writes module components on separate schematic sheets", () => {
    const fixture = makeFixture();
    try {
        fs.writeFileSync(fixture.filePath, `#include "TestPart.schrune"

module child () {
    rail power;
    part u = new TestPart();
    u.IN ~ power.h;
    u.GND ~ power.l;
}

module top () {
    rail board_power;
    mod c = new child();
    c.power ~ board_power;
}
`);
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);

        assert.equal(fs.existsSync(result.moduleSchematicPaths.c), true);

        const rootSchematic = fs.readFileSync(result.schematicPath, "utf8");
        assert.match(rootSchematic, /\(sheet \(at /);
        assert.match(rootSchematic, /\(property "Sheetname" "c"/);
        assert.match(rootSchematic, /\(property "Sheetfile" "fixture_c\.kicad_sch"/);
        assert.doesNotMatch(rootSchematic, /\(symbol \(lib_id "TestPart"\)/);

        const childSchematic = fs.readFileSync(result.moduleSchematicPaths.c, "utf8");
        assert.match(childSchematic, /\(symbol \(lib_id "TestPart"\)/);
        assert.match(childSchematic, /\(global_label "board_power_h"/);
        assert.match(childSchematic, /\(global_label "board_power_l"/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});
