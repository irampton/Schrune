const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assignDesignators, buildDesignatorState, step1, writeKiCadFiles } = require("../../src/app");

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

const verticalPinSymbolFile = `(kicad_symbol_lib (version 20211014) (generator Schrune)
  (symbol "VerticalPart" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
    (property "Reference" "J?" (at 0 5.08 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" "VerticalPart" (at 0 -5.08 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Footprint" "./VerticalPart.kicad_mod" (at 0 -7.62 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "" (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (symbol "VerticalPart_0_1"
      (rectangle (start -3.81 5.08) (end 3.81 0)
        (stroke (width 0.254) (type default))
        (fill (type background))
      )
      (pin passive line (at -1.27 -5.08 90) (length 5.08)
        (name "1" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))
      )
      (pin passive line (at 1.27 -5.08 90) (length 5.08)
        (name "2" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27))))
      )
    )
  )
)
`;

const verticalPinFootprintFile = `(footprint "VerticalPart" (version 20221018) (generator Schrune)
  (attr through_hole)
  (fp_text reference "REF**" (at 0 -2 0) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text value "VerticalPart" (at 0 2 0) (layer "F.Fab")
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (pad "1" thru_hole circle (at -2.5 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask"))
  (pad "2" thru_hole circle (at 2.5 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask"))
)
`;

const reversedPinOrderSymbolFile = `(kicad_symbol_lib (version 20211014) (generator Schrune)
  (symbol "ReversedPinPart" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
    (property "Reference" "U?" (at 0 5.08 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" "ReversedPinPart" (at 0 -5.08 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Footprint" "./ReversedPinPart.kicad_mod" (at 0 -7.62 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "" (at 0 0 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (symbol "ReversedPinPart_0_1"
      (pin passive line (at -7.62 0 0) (length 2.54)
        (name "RIGHT_NET" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27))))
      )
      (pin passive line (at 7.62 0 180) (length 2.54)
        (name "LEFT_NET" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))
      )
    )
  )
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
        assert.equal(path.basename(result.kicadDir), "build");
        assert.equal(fs.existsSync(path.join(result.kicadDir, "fp-lib-table")), true);
        assert.equal(fs.existsSync(result.footprintLibraryPath), true);
        assert.equal(fs.existsSync(path.join(result.footprintLibraryPath, "TestPart.kicad_mod")), true);

        const project = fs.readFileSync(result.kicadProjectPath, "utf8");
        assert.match(project, /"boards": \[\s*\{\s*"filename": "fixture\.kicad_pcb"/s);
        assert.match(project, /"top_level_sheets": \[\s*\{\s*"filename": "fixture\.kicad_sch"/s);

        const fpLibTable = fs.readFileSync(path.join(result.kicadDir, "fp-lib-table"), "utf8");
        assert.match(fpLibTable, /\(fp_lib_table/);
        assert.match(fpLibTable, /\(lib \(name "Schrune"\)/);
        assert.match(fpLibTable, /\(uri "\$\{KIPRJMOD}\/Schrune\.pretty"\)/);

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
        assert.match(schematic, /\(wire \(pts \(xy 27\.94 34\.29\) \(xy 20\.32 34\.29\)\)/);
        assert.match(schematic, /\(label "signal" \(at 20\.32 34\.29 180\)/);
        assert.match(schematic, /\(wire \(pts \(xy 43\.18 36\.83\) \(xy 50\.80 36\.83\)\)/);
        assert.match(schematic, /\(label "GND" \(at 50\.80 36\.83 0\)/);
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

test("connects imported vertical pins at their electrical endpoints and rotates labels", () => {
    const fixture = makeFixture({
        partFile: `part VerticalPart {
    info: {
        partNumber: "VerticalPart",
        manufacture: "TestCo",
        footprint: "./VerticalPart.kicad_mod",
        symbol: "./VerticalPart.kicad_sym",
        designatorPrefix: "J",
    }

    pins: [
        1:1,
        2:2,
    ]
}
`,
        source: `#include "VerticalPart.schrune"

module top () {
    net left;
    net right;
    part j = new VerticalPart();
    j[1] ~ left;
    j[2] ~ right;
}
`,
    });

    try {
        const partsDir = path.join(fixture.dir, "parts", "VerticalPart");
        fs.mkdirSync(partsDir, { recursive: true });
        fs.writeFileSync(path.join(partsDir, "VerticalPart.schrune"), `part VerticalPart {
    info: {
        partNumber: "VerticalPart",
        manufacture: "TestCo",
        footprint: "./VerticalPart.kicad_mod",
        symbol: "./VerticalPart.kicad_sym",
        designatorPrefix: "J",
    }

    pins: [
        1:1,
        2:2,
    ]
}
`);
        fs.writeFileSync(path.join(partsDir, "VerticalPart.kicad_sym"), verticalPinSymbolFile);
        fs.writeFileSync(path.join(partsDir, "VerticalPart.kicad_mod"), verticalPinFootprintFile);

        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        const schematic = fs.readFileSync(result.schematicPath, "utf8");

        assert.match(schematic, /\(wire \(pts \(xy 34\.29 40\.64\) \(xy 34\.29 48\.26\)\)/);
        assert.match(schematic, /\(label "left" \(at 34\.29 48\.26 90\)/);
        assert.match(schematic, /\(wire \(pts \(xy 36\.83 40\.64\) \(xy 36\.83 50\.80\)\)/);
        assert.match(schematic, /\(label "right" \(at 36\.83 50\.80 90\)/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("preserves library pin declaration order in schematic instances", () => {
    const fixture = makeFixture({
        partFile: `part ReversedPinPart {
    info: {
        partNumber: "ReversedPinPart",
        manufacture: "TestCo",
        footprint: "./ReversedPinPart.kicad_mod",
        symbol: "./ReversedPinPart.kicad_sym",
        designatorPrefix: "U",
    }

    pins: [
        LEFT_NET:1,
        RIGHT_NET:2,
    ]
}
`,
        source: `#include "ReversedPinPart.schrune"

module top () {
    net left;
    net right;
    part u = new ReversedPinPart();
    u.LEFT_NET ~ left;
    u.RIGHT_NET ~ right;
}
`,
    });

    try {
        const partsDir = path.join(fixture.dir, "parts", "ReversedPinPart");
        fs.mkdirSync(partsDir, { recursive: true });
        fs.writeFileSync(path.join(partsDir, "ReversedPinPart.schrune"), `part ReversedPinPart {
    info: {
        partNumber: "ReversedPinPart",
        manufacture: "TestCo",
        footprint: "./ReversedPinPart.kicad_mod",
        symbol: "./ReversedPinPart.kicad_sym",
        designatorPrefix: "U",
    }

    pins: [
        LEFT_NET:1,
        RIGHT_NET:2,
    ]
}
`);
        fs.writeFileSync(path.join(partsDir, "ReversedPinPart.kicad_sym"), reversedPinOrderSymbolFile);
        fs.writeFileSync(path.join(partsDir, "ReversedPinPart.kicad_mod"), footprintFile.replace(/TestPart/g, "ReversedPinPart"));

        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        const schematic = fs.readFileSync(result.schematicPath, "utf8");
        const instanceBlock = schematic.match(/\(symbol \(lib_id "ReversedPinPart"\)[\s\S]*?\n  \)/);

        assert.ok(instanceBlock);
        assert.match(instanceBlock[0], /\(pin "2"[\s\S]*?\(pin "1"/);
        assert.match(schematic, /\(wire \(pts \(xy 27\.94 35\.56\) \(xy 20\.32 35\.56\)\)/);
        assert.match(schematic, /\(label "right" \(at 20\.32 35\.56 180\)/);
        assert.match(schematic, /\(wire \(pts \(xy 43\.18 35\.56\) \(xy 50\.80 35\.56\)\)/);
        assert.match(schematic, /\(label "left" \(at 50\.80 35\.56 0\)/);
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

test("uses an explicit project name for generated KiCad filenames", () => {
    const fixture = makeFixture();
    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled, { projectName: "DemoBoard" });
        const schematic = fs.readFileSync(result.schematicPath, "utf8");
        const pcb = fs.readFileSync(result.pcbPath, "utf8");

        assert.equal(path.basename(result.kicadProjectPath), "DemoBoard.kicad_pro");
        assert.equal(path.basename(result.schematicPath), "DemoBoard.kicad_sch");
        assert.equal(path.basename(result.pcbPath), "DemoBoard.kicad_pcb");
        assert.match(schematic, /\(project "DemoBoard"/);
        assert.doesNotMatch(schematic, /\(project "fixture"/);
        assert.match(pcb, /\(uuid [0-9a-f-]+\)/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
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

test("spaces grouped passive pairs far enough to avoid overlapping connection stubs", () => {
    const fixture = makeFixture({
        partFile: `part TestPart {
    info: {
        partNumber: "TestPart",
        manufacture: "TestCo",
        footprint: "./TestPart.kicad_mod",
        symbol: "./TestPart.kicad_sym",
        designatorPrefix: "R",
    }

    pins: [
        IN:1,
        GND:2,
    ]
}
`,
        source: `#include "TestPart.schrune"

module top () {
    rail power;
    power.h.name = "3V3";
    power.l.name = "GND";
    part u1 = new TestPart();
    part u2 = new TestPart();
    u1.IN ~ power.h;
    u1.GND ~ power.l;
    u2.IN ~ power.h;
    u2.GND ~ power.l;
}
`,
    });

    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        const schematic = fs.readFileSync(result.schematicPath, "utf8");

        assert.match(schematic, /\(symbol \(lib_id "TestPart"\) \(at 35\.56 35\.56 0\)/);
        assert.match(schematic, /\(symbol \(lib_id "TestPart"\) \(at 86\.36 35\.56 0\)/);
        assert.match(schematic, /\(wire \(pts \(xy 43\.18 36\.83\) \(xy 50\.80 36\.83\)\)/);
        assert.match(schematic, /\(wire \(pts \(xy 78\.74 34\.29\) \(xy 71\.12 34\.29\)\)/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("marks do-not-place components in schematic and PCB output", () => {
    const fixture = makeFixture({
        source: `#include "TestPart.schrune"

module top () {
    part u = new TestPart();
    u.place = false;
}
`,
    });

    try {
        const compiled = assignDesignators(step1(fixture.filePath));
        const result = writeKiCadFiles(fixture.filePath, compiled);
        const schematic = fs.readFileSync(result.schematicPath, "utf8");
        const pcb = fs.readFileSync(result.pcbPath, "utf8");

        assert.match(schematic, /\(in_bom no\) \(on_board yes\) \(dnp yes\)/);
        assert.match(pcb, /\(attr dnp\)/);
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
        assert.match(childSchematic, /\(global_label "board_power"/);
        assert.match(childSchematic, /\(global_label "board_power\.l"/);
        assert.match(childSchematic, /\(global_label "board_power"[\s\S]*?\(effects \(font \(size 1\.27 1\.27\)\)\)/);
        assert.match(childSchematic, /\(global_label "board_power\.l"[\s\S]*?\(effects \(font \(size 1\.27 1\.27\)\)\)/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});

test("refreshes an existing PCB while preserving placement and board items", () => {
    const fixture = makeFixture();
    try {
        const earlierPart = `part EarlierPart {
    info: {
        partNumber: "EarlierPart",
        manufacture: "TestCo",
        footprint: "./EarlierPart.kicad_mod",
        symbol: "./EarlierPart.kicad_sym",
        designatorPrefix: "U",
    }

    pins: [
        IN:1,
        GND:2,
    ]
}
`;

        const parts = [
            ["EarlierPart", "U?"],
            ["TestPart", "U?"],
        ];
        for (const [name, ref] of parts) {
            const dir = path.join(fixture.dir, "parts", name);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${name}.schrune`), name === "EarlierPart" ? earlierPart : partFile);
            fs.writeFileSync(path.join(dir, `${name}.kicad_sym`), symbolFile.replace(/TestPart/g, name).replace(/"U\?"/, JSON.stringify(ref)));
            fs.writeFileSync(path.join(dir, `${name}.kicad_mod`), footprintFile.replace(/TestPart/g, name));
        }

        fs.writeFileSync(fixture.filePath, `#include "TestPart.schrune"

module top () {
    rail power;
    net signal;
    power.l.name = "GND";
    part u = new TestPart();
    u.IN ~ signal;
    u.GND ~ power.l;
}
`);

        const initialCompiled = assignDesignators(step1(fixture.filePath));
        const initialResult = writeKiCadFiles(fixture.filePath, initialCompiled);
        const designatorState = buildDesignatorState(initialCompiled);
        const initialPcb = fs.readFileSync(initialResult.pcbPath, "utf8");
        const initialGndNet = initialPcb.match(/\(net\s+(\d+)\s+"GND"\)/)[1];
        const segmentBlock = [
            `  (segment`,
            `    (start 1.00 2.00)`,
            `    (end 3.00 4.00)`,
            `    (width 0.25)`,
            `    (layer "F.Cu")`,
            `    (net ${initialGndNet})`,
            `  )`,
        ].join("\n");
        const movedPcb = initialPcb.replace(/\n(\s*)\(at\s+[^)]+\)/, "\n$1(at 99.00 88.00 45)");
        const closingIndex = movedPcb.lastIndexOf("\n)");
        const seededPcb = closingIndex === -1
            ? `${movedPcb}\n${segmentBlock}\n`
            : `${movedPcb.slice(0, closingIndex)}\n${segmentBlock}${movedPcb.slice(closingIndex)}`;
        fs.writeFileSync(initialResult.pcbPath, seededPcb);

        fs.writeFileSync(fixture.filePath, `#include "EarlierPart.schrune"
#include "TestPart.schrune"

module top () {
    rail power;
    net signal;
    power.l.name = "GND";
    part a = new EarlierPart();
    part u = new TestPart();
    a.IN ~ signal;
    a.GND ~ power.l;
    u.IN ~ signal;
    u.GND ~ power.l;
}
`);

        const updatedCompiled = assignDesignators(step1(fixture.filePath), designatorState);
        const updatedResult = writeKiCadFiles(fixture.filePath, updatedCompiled);
        const updatedPcb = fs.readFileSync(updatedResult.pcbPath, "utf8");
        const updatedSchematic = fs.readFileSync(updatedResult.schematicPath, "utf8");
        const updatedGndNet = updatedPcb.match(/\(net\s+(\d+)\s+"GND"\)/)[1];

        assert.notEqual(updatedPcb, seededPcb);
        assert.match(updatedPcb, /\(footprint "Schrune:EarlierPart"/);
        assert.match(updatedPcb, /\(footprint "Schrune:TestPart"[\s\S]*?\(at 99\.00 88\.00 45\)/);
        assert.match(updatedPcb, new RegExp(`\\(segment[\\s\\S]*?\\(net ${updatedGndNet}\\)`));
        assert.match(updatedSchematic, /\(symbol \(lib_id "EarlierPart"[\s\S]*?\(property "Reference" "U2"/);
        assert.match(updatedSchematic, /\(symbol \(lib_id "TestPart"[\s\S]*?\(property "Reference" "U1"/);
        assert.match(updatedSchematic, /\(property "Value" "EarlierPart"/);
        assert.match(updatedSchematic, /\(property "Value" "TestPart"/);
    } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
});
