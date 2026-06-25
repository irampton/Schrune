const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    addPartToProjectConfig,
    buildPathsForEntry,
    findProjectConfig,
    manifestBuildRecord,
    resolveBuildTarget,
    writeProjectConfig,
} = require("../../src/project");

test("resolveBuildTarget uses schrune.json entry and project name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-project-"));
    const srcDir = path.join(dir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "main.schrune"), "module top () {}\n");
    writeProjectConfig(path.join(srcDir, "schrune.json"), {
        name: "DemoBoard",
        entry: "./main.schrune",
        parts: [],
    });

    try {
        const target = resolveBuildTarget({ cwd: srcDir });
        assert.equal(target.projectName, "DemoBoard");
        assert.equal(target.entryFilePath, path.join(srcDir, "main.schrune"));
        assert.equal(target.project.path, path.join(srcDir, "schrune.json"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("manifestBuildRecord writes build outputs relative to schrune.json", () => {
    const manifestPath = "/tmp/demo/schrune.json";
    const buildPaths = buildPathsForEntry("/tmp/demo/src/main.schrune", "DemoBoard");
    const record = manifestBuildRecord(manifestPath, buildPaths);

    assert.deepEqual(record, {
        bom: "./src/build/DemoBoard.BOM.csv",
        kicadProject: "./src/build/DemoBoard.kicad_pro",
        layout: "./src/build/DemoBoard.kicad_pcb",
        schematic: "./src/build/DemoBoard.kicad_sch",
    });
});

test("addPartToProjectConfig appends imported parts metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schrune-project-part-"));
    const projectPath = path.join(dir, "schrune.json");
    writeProjectConfig(projectPath, {
        name: "DemoBoard",
        entry: "./main.schrune",
    });

    try {
        const project = findProjectConfig(dir);
        const updated = addPartToProjectConfig(project, {
            MPN: "ACME_123",
            LCSC: "C1234",
        });

        assert.deepEqual(updated.parts, [{ MPN: "ACME_123", LCSC: "C1234" }]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
