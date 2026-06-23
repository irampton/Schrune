#!/usr/bin/env node

const { spawnSync } = require("child_process");

function candidateCommands() {
    const envCommand = process.env.EASYEDA2KICAD_PYTHON;
    const commands = [
        envCommand && envCommand.trim(),
        "python3",
        "python",
    ].filter(Boolean);

    return [...new Set(commands)];
}

function runInstall(command) {
    const result = spawnSync(command, ["-m", "pip", "install", "easyeda2kicad"], {
        env: process.env,
        encoding: "utf8",
    });

    return {
        command,
        result,
    };
}

const attempts = [];

for (const command of candidateCommands()) {
    const { result } = runInstall(command);
    if (result.status === 0) {
        console.log(`easyeda2kicad installed with ${command}`);
        process.exit(0);
    }

    attempts.push(
        result.error
            ? `${command}: ${result.error.code === "ENOENT" ? "not found" : result.error.message}`
            : `${command}: exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`
    );
}

console.error("Failed to install easyeda2kicad.");
console.error(`Tried: ${attempts.join("; ")}`);
process.exit(1);
