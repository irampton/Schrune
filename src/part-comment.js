function firstDefined(values) {
    for (const value of values) {
        const text = String(value ?? "").trim();
        if (text && text !== "-") {
            return text;
        }
    }
    return "";
}

function normalizeTolerance(value) {
    const text = String(value || "").trim();
    if (!text) {
        return "";
    }
    return text.startsWith("±") ? text : `±${text.replace(/^[+-]+/, "")}`;
}

function commentFields(kind, source = {}) {
    const attributes = source.attributes || {};

    if (kind === "Resistor") {
        const value = firstDefined([attributes.Resistance, source.value]);
        const tolerance = normalizeTolerance(firstDefined([attributes.Tolerance, source.tolerance]));
        const wattage = firstDefined([
            attributes["Power(Watts)"],
            attributes.Power,
            attributes["Rated Power"],
            source.wattage,
            source.power,
        ]);
        return {
            value,
            tolerance,
            wattage,
            comment: [value, tolerance, wattage].filter(Boolean).join(" "),
        };
    }

    if (kind === "Capacitor") {
        const value = firstDefined([attributes.Capacitance, source.value]);
        const tolerance = normalizeTolerance(firstDefined([attributes.Tolerance, source.tolerance]));
        const maxVoltage = firstDefined([
            attributes["Rated Voltage"],
            attributes.Voltage,
            attributes["Voltage - Rated"],
            source.maxVoltage,
            source.voltage,
        ]);
        const temperatureCoefficient = firstDefined([
            attributes["Temperature Characteristics"],
            attributes["Temperature Coefficient"],
            attributes["Temp. Coefficient"],
            source.temperatureCoefficient,
        ]);
        return {
            value,
            tolerance,
            maxVoltage,
            temperatureCoefficient,
            comment: [value, tolerance, maxVoltage, temperatureCoefficient].filter(Boolean).join(" "),
        };
    }

    if (kind === "Inductor") {
        const value = firstDefined([attributes.Inductance, source.value]);
        const tolerance = normalizeTolerance(firstDefined([attributes.Tolerance, source.tolerance]));
        const currentRating = firstDefined([
            attributes["Rated Current"],
            attributes["Current Rating"],
            attributes.Current,
            source.currentRating,
        ]);
        const dcr = firstDefined([
            attributes.DCR,
            attributes["DCR(Max)"],
            attributes["DCR (Max)"],
            attributes["DC Resistance (DCR)"],
            source.dcr,
        ]);
        return {
            value,
            tolerance,
            currentRating,
            dcr,
            comment: [value, tolerance, currentRating, dcr].filter(Boolean).join(" "),
        };
    }

    if (kind === "Diode") {
        const reverseVoltage = firstDefined([
            attributes["Reverse Voltage (Vr)"],
            attributes["Reverse Voltage"],
            attributes.Vr,
            source.reverseVoltage,
        ]);
        const voltageDrop = firstDefined([
            attributes["Forward Voltage (Vf@If)"],
            attributes["Forward Voltage"],
            attributes.Vf,
            source.voltageDrop,
        ]);
        const current = firstDefined([
            attributes["Average Rectified Current (Io)"],
            attributes["Forward Current"],
            attributes.Current,
            attributes.Io,
            source.current,
        ]);
        return {
            reverseVoltage,
            voltageDrop,
            current,
            comment: [reverseVoltage, voltageDrop, current].filter(Boolean).join(" "),
        };
    }

    return {
        comment: firstDefined([source.comment]),
    };
}

module.exports = {
    commentFields,
};
