function normalize(value, path) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`Non-finite number at ${path}.`);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => normalize(item, `${path}[${index}]`));
    }
    if (value && typeof value === "object") {
        return Object.keys(value).sort().reduce((result, key) => {
            if (value[key] === undefined) {
                throw new Error(`Undefined value at ${path}.${key}.`);
            }
            result[key] = normalize(value[key], `${path}.${key}`);
            return result;
        }, {});
    }
    throw new Error(`Unsupported canonical JSON value at ${path}.`);
}

export function canonicalJson(value) {
    return JSON.stringify(normalize(value, "$"));
}

export function signingPayload(envelope) {
    const { signature: _signature, ...unsigned } = envelope;
    return canonicalJson(unsigned);
}
