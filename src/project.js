const fs = require("fs");
const path = require("path");

const PROJECT_FILE = "schrune.json";
const BUILD_DIR_NAME = "build";

function normalizeRelativePath(value) {
    return String(value || "").replace(/\\/g, "/");
}

function relativeManifestPath(fromDir, targetPath) {
    let relativePath = normalizeRelativePath(path.relative(fromDir, targetPath));
    if (!relativePath || relativePath === ".") {
        return "./";
    }

    if (!relativePath.startsWith(".")) {
        relativePath = `./${relativePath}`;
    }

    return relativePath;
}

function buildPathsForEntry(entryFilePath, projectName) {
    const entryDir = path.dirname(path.resolve(entryFilePath));
    const buildDir = path.join(entryDir, BUILD_DIR_NAME);
    return {
        buildDir,
        bomPath: path.join(buildDir, `${projectName}.BOM.csv`),
        designatorStatePath: path.join(buildDir, ".schrune-designators.json"),
        kicadProjectPath: path.join(buildDir, `${projectName}.kicad_pro`),
        schematicPath: path.join(buildDir, `${projectName}.kicad_sch`),
        pcbPath: path.join(buildDir, `${projectName}.kicad_pcb`),
    };
}

function manifestBuildRecord(manifestPath, paths) {
    const manifestDir = path.dirname(path.resolve(manifestPath));
    return {
        bom: relativeManifestPath(manifestDir, paths.bomPath),
        kicadProject: relativeManifestPath(manifestDir, paths.kicadProjectPath),
        layout: relativeManifestPath(manifestDir, paths.pcbPath),
        schematic: relativeManifestPath(manifestDir, paths.schematicPath),
    };
}

function parseProjectConfig(projectPath) {
    const resolvedPath = path.resolve(projectPath);
    const config = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`${PROJECT_FILE} must contain a JSON object`);
    }

    return {
        path: resolvedPath,
        dir: path.dirname(resolvedPath),
        config,
    };
}

function writeProjectConfig(projectPath, config) {
    fs.writeFileSync(path.resolve(projectPath), `${JSON.stringify(config, null, 2)}\n`);
}

function findProjectConfigInDirectory(dirPath) {
    const candidate = path.join(path.resolve(dirPath), PROJECT_FILE);
    if (!fs.existsSync(candidate)) {
        return undefined;
    }
    return parseProjectConfig(candidate);
}

function findProjectConfig(startDir) {
    let currentDir = path.resolve(startDir);

    while (true) {
        const candidate = path.join(currentDir, PROJECT_FILE);
        if (fs.existsSync(candidate)) {
            return parseProjectConfig(candidate);
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return undefined;
        }
        currentDir = parentDir;
    }
}

function resolveBuildTarget(options = {}) {
    if (options.inputFile) {
        const entryFilePath = path.resolve(options.cwd || process.cwd(), options.inputFile);
        return {
            entryFilePath,
            project: undefined,
            projectName: path.basename(entryFilePath, ".schrune"),
        };
    }

    const project = findProjectConfig(options.cwd || process.cwd());
    if (!project) {
        throw new Error(`Could not find ${PROJECT_FILE}. Run "schrune create" or specify a .schrune file.`);
    }

    const entryField = project.config.entry || project.config.topFile;
    if (!entryField || typeof entryField !== "string") {
        throw new Error(`${PROJECT_FILE} is missing an "entry" path`);
    }

    const entryFilePath = path.resolve(project.dir, entryField);
    return {
        entryFilePath,
        project,
        projectName: project.config.name || path.basename(entryFilePath, ".schrune"),
    };
}

function addPartToProjectConfig(project, part) {
    const config = { ...project.config };
    const parts = Array.isArray(config.parts) ? [...config.parts] : [];
    const index = parts.findIndex((entry) => entry && entry.LCSC === part.LCSC);
    if (index >= 0) {
        parts[index] = { ...parts[index], ...part };
    } else {
        parts.push(part);
    }
    config.parts = parts;
    writeProjectConfig(project.path, config);
    return config;
}

module.exports = {
    BUILD_DIR_NAME,
    PROJECT_FILE,
    addPartToProjectConfig,
    buildPathsForEntry,
    findProjectConfig,
    findProjectConfigInDirectory,
    manifestBuildRecord,
    parseProjectConfig,
    relativeManifestPath,
    resolveBuildTarget,
    writeProjectConfig,
};
