export const EEPROM_SIZE = 1024;
export const DEFAULT_SPEED_KHZ = 400;

const speedModes = new Map([[20, 0], [100, 1], [400, 2], [750, 3], [1000, 6]]);
const deviceSpeed = new WeakMap();

const filter = { vendorId: 0x1A86, productId: 0x55DC, usagePage: 0xFFA0, usage: 1 };
const reportId = 0;
const packetSize = 512;
const chunkSize = 32;
const active = new WeakSet();

class HidTimeout extends Error {}
class I2cNack extends Error {}

function send(device, commands) {
    const packet = new Uint8Array(packetSize);
    new DataView(packet.buffer).setUint16(0, commands.length, true);
    packet.set(commands, 2);
    return device.sendReport(reportId, packet);
}

async function setSpeed(device, speedKhz) {
    const mode = speedModes.get(speedKhz);
    if (mode === undefined) throw new RangeError("Допустимые скорости I²C: 20, 100, 400, 750 и 1000 кГц.");
    if (deviceSpeed.get(device) !== speedKhz) {
        await send(device, [0xAA, 0x60 | mode, 0]);
        deviceSpeed.set(device, speedKhz);
    }
}

async function exchange(device, commands, timeoutMs) {
    let timer;
    let onReport;
    try {
        const response = new Promise((resolve, reject) => {
            onReport = event => {
                if (event.reportId === reportId) resolve(event.data);
            };
            device.addEventListener("inputreport", onReport);
            timer = setTimeout(() => reject(new HidTimeout("CH347 не вернул HID-ответ.")), timeoutMs);
        });
        const [, report] = await Promise.all([send(device, commands), response]);
        return report;
    } finally {
        clearTimeout(timer);
        device.removeEventListener("inputreport", onReport);
    }
}

async function readChunk(device, offset, length, timeoutMs = 750) {
    const bank = 0x50 + (offset >> 8);
    // Random read: address + word pointer, repeated START, read address, final byte with NACK.
    const commands = [0xAA, 0x74, 0x82, bank << 1, offset & 0xFF, 0x74, 0x81, (bank << 1) | 1];
    if (length > 1) commands.push(0xC0 | (length - 1));
    commands.push(0xC0, 0x75, 0);
    const report = await exchange(device, commands, timeoutMs);
    if (report.byteLength < 5)
        throw new Error("Слишком короткий заголовок ответа CH347.");

    const size = report.getUint16(0, true);
    const acks = [report.getUint8(2), report.getUint8(3), report.getUint8(4)];
    if (size < 3 || size + 2 > report.byteLength || acks.some(ack => ack !== 0 && ack !== 1))
        throw new Error("Некорректный ответ I²C от CH347.");
    if (acks.includes(0))
        throw new I2cNack(`Нет ACK от EEPROM по адресу 0x${bank.toString(16).toUpperCase()} (смещение 0x${offset.toString(16).toUpperCase()}).`);
    if (size !== length + 3)
        throw new Error(`CH347 вернул ${size - 3} байт вместо ${length}.`);
    return new Uint8Array(report.buffer, report.byteOffset + 5, length).slice();
}

/** Open the CH347 I²C interface. Call directly from a click handler. */
export async function connectCh347(hid = globalThis.navigator?.hid, { speedKhz = DEFAULT_SPEED_KHZ } = {}) {
    if (!hid)
        throw new Error("WebHID недоступен. Откройте страницу в Chrome или Edge через localhost либо HTTPS.");

    if (!speedModes.has(speedKhz)) throw new RangeError("Недопустимая скорость I²C.");
    const devices = await hid.requestDevice({ filters: [filter] });
    if (!devices.length) throw new Error("CH347 не выбран.");

    let failure;
    for (const device of devices) {
        try {
            await device.open();
            deviceSpeed.delete(device);
            await setSpeed(device, speedKhz);
            try {
                await readChunk(device, 0, 1, 450);
            } catch (error) {
                // A valid NACK still confirms the I²C interface; the EEPROM may be unplugged.
                if (!(error instanceof I2cNack)) throw error;
            }
            return device;
        } catch (error) {
            failure = error;
            if (device.opened) await device.close();
        }
    }
    throw new Error(`Не удалось открыть интерфейс I²C CH347. ${failure?.message ?? ""} Проверьте, что WinUI отключён от адаптера.`);
}

/** Read a contiguous span of a 24C08 and return only bytes received from the chip. */
export async function readEeprom(device, { offset = 0, length = EEPROM_SIZE - offset, speedKhz } = {}) {
    if (!Number.isInteger(offset) || !Number.isInteger(length)
        || offset < 0 || length < 1 || length > EEPROM_SIZE - offset)
        throw new RangeError("Диапазон должен лежать в пределах 0x000–0x3FF.");
    if (!device?.opened) throw new Error("Сначала подключите CH347.");
    const speed = speedKhz ?? deviceSpeed.get(device) ?? DEFAULT_SPEED_KHZ;
    if (!speedModes.has(speed)) throw new RangeError("Недопустимая скорость I²C.");
    if (active.has(device)) throw new Error("Чтение уже выполняется.");

    active.add(device);
    try {
        await setSpeed(device, speed);
        const bytes = new Uint8Array(length);
        for (let done = 0; done < length;) {
            const position = offset + done;
            const count = Math.min(chunkSize, length - done, 256 - (position & 0xFF));
            bytes.set(await readChunk(device, position, count), done);
            done += count;
        }
        return bytes;
    } catch (error) {
        if (!(error instanceof I2cNack) && device.opened) await device.close();
        throw error;
    } finally {
        active.delete(device);
    }
}

/**
 * Decode SFF-8472 DDM from a linear dump (A0h at 0x000, A2h at 0x100).
 * offset is the absolute EEPROM address of bytes[0].
 */
export function parseSfpDdm(bytes, offset = 0) {
    if (!(bytes instanceof Uint8Array) || !Number.isInteger(offset) || offset < 0)
        throw new TypeError("Нужен Uint8Array и неотрицательное целое смещение.");
    const end = offset + bytes.length;
    if (offset !== 0 || end < 94)
        return { state: "missing-a0" };
    if (bytes[0] !== 0x03)
        return { state: "unsupported-module" };

    const type = bytes[92];
    if (!(type & 0x40))
        return { state: "unsupported-ddm" };
    if (end < 0x100 + 106)
        return { state: "missing-a2" };

    const internal = Boolean(type & 0x20);
    const external = Boolean(type & 0x10);
    if (internal === external)
        return { state: "unknown-calibration" };

    const a2 = new DataView(bytes.buffer, bytes.byteOffset + 0x100, end - 0x100);
    const status = a2.byteLength > 110 ? a2.getUint8(110) : null;
    const flagsAvailable = Boolean(bytes[93] & 0x80) && a2.byteLength >= 118;
    const definitions = [
        { key: "temperature", unit: "°C", scale: 1 / 256, slope: 84, signed: true },
        { key: "voltage", unit: "В", scale: 0.0001, slope: 88 },
        { key: "txBias", unit: "мА", scale: 0.002, slope: 76 },
        { key: "txPower", unit: "мВт", scale: 0.0001, slope: 80 },
        { key: "rxPower", unit: "мВт", scale: 0.0001 }
    ];
    const measurements = definitions.map(({ key, unit, scale, slope, signed }, index) => {
        function decode(position) {
            const raw = signed ? a2.getInt16(position) : a2.getUint16(position);
            let calibrated = raw;
            if (external) {
                if (slope !== undefined) {
                    calibrated = raw * (a2.getUint16(slope) / 256) + a2.getInt16(slope + 2);
                } else {
                    calibrated = 0;
                    // Rx_PWR(4) through Rx_PWR(0), highest degree first.
                    for (let coefficient = 56; coefficient <= 72; coefficient += 4)
                        calibrated = calibrated * raw + a2.getFloat32(coefficient);
                }
            }
            const value = calibrated * scale;
            return Number.isFinite(value) ? value : null;
        }
        const threshold = index * 8;
        const flagByte = index < 4 ? 112 : 113;
        const high = 0x80 >> ((index % 4) * 2);
        const value = decode(96 + index * 2);
        return {
            key, unit, value,
            dBm: unit === "мВт" && value > 0 ? 10 * Math.log10(value) : null,
            thresholds: {
                highAlarm: decode(threshold), lowAlarm: decode(threshold + 2),
                highWarning: decode(threshold + 4), lowWarning: decode(threshold + 6)
            },
            flags: flagsAvailable ? {
                highAlarm: Boolean(a2.getUint8(flagByte) & high),
                lowAlarm: Boolean(a2.getUint8(flagByte) & (high >> 1)),
                highWarning: Boolean(a2.getUint8(flagByte + 4) & high),
                lowWarning: Boolean(a2.getUint8(flagByte + 4) & (high >> 1))
            } : null
        };
    });
    return {
        state: "ok", calibration: external ? "external" : "internal",
        rxPowerType: type & 0x08 ? "average" : "oma",
        ready: status === null ? null : !(status & 1),
        measurements
    };
}

/** Decode the standard SFP identification fields in the first 96 bytes of A0h. */
export function parseSfpA0(bytes, offset = 0) {
    if (!(bytes instanceof Uint8Array) || !Number.isInteger(offset) || offset < 0)
        throw new TypeError("Нужен Uint8Array и неотрицательное целое смещение.");
    if (offset !== 0 || bytes.length < 96) return { state: "missing-a0" };
    if (bytes[0] !== 3) return { state: "unsupported-module" };

    const hex = value => "0x" + value.toString(16).toUpperCase().padStart(2, "0");
    const code = (value, names) => names[value] ? `${names[value]} (${hex(value)})` : hex(value);
    const ascii = (start, length) => Array.from(bytes.subarray(start, start + length),
        value => value >= 32 && value <= 126 ? String.fromCharCode(value) : " ").join("").trim() || "—";
    const quantity = (value, unit) => value ? `${value} ${unit}` : "—";
    const distance = (value, scale, unit) =>
        value === 255 ? `> ${254 * scale} ${unit}` : quantity(value * scale, unit);
    const check = (start, end) => {
        const sum = bytes.subarray(start, end).reduce((total, value) => total + value, 0) & 0xFF;
        return `${hex(bytes[end])} · ${sum === bytes[end] ? "OK" : `ожидалось ${hex(sum)}`}`;
    };
    const connectors = { 0: "Не указан", 1: "SC", 6: "Fibre Jack", 7: "LC", 8: "MT-RJ",
        9: "MU", 10: "SG", 11: "ST", 12: "MPO 1×12", 13: "MPO 2×16",
        32: "HSSDC II", 33: "Медный pigtail", 34: "RJ45", 35: "Без разъёма", 36: "MXC 2×16" };
    const encodings = ["Не указано", "8B/10B", "4B/5B", "NRZ", "Manchester", "SONET scrambled",
        "64B/66B", "256B/257B", "PAM4"];
    const cable = Boolean(bytes[8] & 0x0C) || bytes[2] === 33;
    const extendedRate = bytes[12] === 255;
    const options = [
        [65, 0x20, "RATE_SELECT"], [65, 0x10, "TX_DISABLE"], [65, 0x08, "TX_FAULT"],
        [65, 0x04, "RX_LOS (инверт.)"], [65, 0x02, "RX_LOS"],
        [93, 0x80, "Флаги аварий и предупреждений"]
    ].filter(([address, mask]) => bytes[address] & mask).map(([, , label]) => label);
    const compliance = [
        [3, "10G Ethernet / 1X InfiniBand", ["10GBASE-ER", "10GBASE-LRM", "10GBASE-LR", "10GBASE-SR",
            "1X SX", "1X LX", "1X Copper Active", "1X Copper Passive"]],
        [4, "ESCON / SONET"], [5, "SONET"],
        [6, "Ethernet", ["BASE-PX", "BASE-BX10", "100BASE-FX", "100BASE-LX/LX10",
            "1000BASE-T", "1000BASE-CX", "1000BASE-LX", "1000BASE-SX"]],
        [7, "Fibre Channel · длина / технология", ["Very long", "Short", "Intermediate", "Long", "Medium",
            "Shortwave linear Rx", "Longwave laser", "Electrical inter-enclosure"]],
        [8, "Fibre Channel · технология", ["Electrical intra-enclosure", "Shortwave without OFC",
            "Shortwave with OFC", "Longwave laser (LC)", "Active cable", "Passive cable"]],
        [9, "Fibre Channel · среда", ["Twin axial", "Twisted pair", "Miniature coax", "Video coax",
            "MMF 62,5 µm", "MMF 50 µm", null, "SMF"]],
        [10, "Fibre Channel · скорость", ["1200 MB/s", "800 MB/s", "1600 MB/s", "400 MB/s",
            "3200 MB/s", "200 MB/s", null, "100 MB/s"]],
        [36, "Расширенный код"], [62, "Fibre Channel Speed 2"]
    ].map(([address, label, names = []]) => {
        const set = names.filter((name, index) => name && (bytes[address] & (0x80 >> index)));
        return [`${label} · ${hex(address)}`, [hex(bytes[address]), ...set].join(" · ")];
    });
    const oui = [...bytes.subarray(37, 40)].map(value => hex(value).slice(2)).join(":");
    const wavelength = (bytes[60] << 8) | bytes[61];
    const vendor = ascii(20, 16);
    const partNumber = ascii(40, 16);
    return { state: "ok", vendor, partNumber, groups: [
        { title: "Идентификация", fields: [
            ["Идентификатор", "SFP / SFP+ / SFP28 (0x03)"], ["Расширенный идентификатор", hex(bytes[1])],
            ["Разъём", code(bytes[2], connectors)], ["Кодирование", code(bytes[11], encodings)],
            ["Скорость сигнализации", quantity(extendedRate ? bytes[66] * 250 : bytes[12] * 100, "Мбод")],
            ["Допуск скорости", extendedRate ? quantity(bytes[67], "% (±)") : `+${bytes[66]}% / −${bytes[67]}%`],
            ["Rate Identifier", hex(bytes[13])],
            [cable ? "Код кабеля" : "Длина волны", cable ? hex(bytes[60]) + " " + hex(bytes[61]) : quantity(wavelength, "нм")]
        ] },
        { title: "Производитель", fields: [
            ["Vendor", vendor], ["OUI", oui], ["PN", partNumber],
            ["Rev", ascii(56, 4)], ["SN", ascii(68, 16)], ["Код даты и партии", ascii(84, 8)]
        ] },
        { title: "Дальности и опции", fields: [
            ...(cable ? [["Затухание 12,9 ГГц", quantity(bytes[14], "дБ")],
                ["Затухание 25,78 ГГц", quantity(bytes[15], "дБ")],
                ["Длина кабеля · поле 0x12", quantity(bytes[18], "м")],
                ["Дополнительный код длины · 0x13", hex(bytes[19])]]
                : [["SMF · 0x0E", distance(bytes[14], 1, "км")], ["SMF · 0x0F", distance(bytes[15], 100, "м")],
                    ["OM1", distance(bytes[17], 10, "м")], ["OM2", distance(bytes[16], 10, "м")],
                    ["OM3", distance(bytes[19], 10, "м")], ["OM4", distance(bytes[18], 10, "м")]]),
            ["Опции", [hex(bytes[64]) + " " + hex(bytes[65]), ...options].join(" · ")],
            ["DDM", bytes[92] & 0x40 ? "Заявлено" : "Не заявлено"],
            ["Код редакции SFF-8472", hex(bytes[94])],
            ["CC_BASE", check(0, 63)], ["CC_EXT", check(64, 95)]
        ] },
        { title: "Коды совместимости", fields: compliance }
    ] };
}

/** Build a Windows-safe filename from the local save date and A0h identification. */
export function eepromFilename(bytes, offset = 0, date = new Date()) {
    const { vendor, partNumber } = parseSfpA0(bytes, offset);
    const safe = (value, fallback) => {
        if (!value || value === "—") return fallback;
        return value.replace(/[<>:"/\\|?*]/g, "-").replace(/[. ]+$/, "") || fallback;
    };
    const pad = value => String(value).padStart(2, "0");
    const day = `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${String(date.getFullYear()).padStart(4, "0")}`;
    return `${day}_${safe(vendor, "UnknownVendor")}_${safe(partNumber, "UnknownPN")}.bin`;
}
