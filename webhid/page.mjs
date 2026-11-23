import { connectCh347, readEeprom, parseSfpA0, parseSfpDdm, eepromFilename } from "./reader.mjs";

const form = document.querySelector("form");
const connect = document.querySelector("#connect");
const read = document.querySelector("#read");
const save = document.querySelector("#save");
const status = document.querySelector("#status");
const hex = document.querySelector("#hex");
const offsetField = document.querySelector("#offset");
const lengthField = document.querySelector("#length");
const auto = document.querySelector("#auto");
const interval = document.querySelector("#interval");
const speed = document.querySelector("#speed");
let timer;
let device;
let dump;
let busy = false;
let foregroundBusy = false;

const ddmInfo = document.querySelector("#ddm-info");
const ddmRows = document.querySelector("#ddm-rows");
const ddmTable = document.querySelector("#ddm-table");
const ddmLabels = {
    temperature: "Температура", voltage: "Напряжение", txBias: "Ток смещения TX",
    txPower: "Мощность TX", rxPower: "Мощность RX"
};
const ddmStatuses = {
    "missing-a0": "Для определения формата нужен диапазон со смещения 0x000.",
    "missing-a2": "Для DDM должны быть прочитаны данные A2h до адреса 0x169 включительно.",
    "unsupported-module": "В дампе нет идентификатора SFP (0x03).",
    "unsupported-ddm": "В A0h модуль не заявляет поддержку DDM.",
    "unknown-calibration": "В A0h не указан однозначный режим калибровки DDM."
};
const flagLabels = {
    highAlarm: "верхняя авария", lowAlarm: "нижняя авария",
    highWarning: "верхнее предупреждение", lowWarning: "нижнее предупреждение"
};

function showA0(result) {
    const content = document.querySelector("#a0-content");
    const info = document.querySelector("#a0-info");
    content.replaceChildren();
    info.hidden = result?.state === "ok";
    if (result?.state !== "ok") {
        info.textContent = result?.state === "unsupported-module"
            ? "Идентификатор модуля отличается от SFP (0x03)."
            : "Для A0h прочитайте не менее 96 байт со смещения 0x000.";
        return;
    }
    for (const group of result.groups) {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = group.title;
        const list = document.createElement("dl");
        for (const [label, value] of group.fields) {
            const term = document.createElement("dt");
            const description = document.createElement("dd");
            term.textContent = label;
            description.textContent = value;
            list.append(term, description);
        }
        section.append(heading, list);
        content.append(section);
    }
}

function showDdm(result) {
    ddmTable.hidden = result?.state !== "ok";
    ddmRows.replaceChildren();
    if (!result || result.state !== "ok") {
        ddmInfo.textContent = result ? ddmStatuses[result.state] : "Прочитайте дамп с областями A0h и A2h.";
        return;
    }

    const calibration = result.calibration === "external" ? "Внешняя" : "Внутренняя";
    const rx = result.rxPowerType === "average" ? "средняя мощность" : "OMA";
    const readiness = result.ready === false ? " Модуль сообщает, что измерения ещё не готовы." : "";
    ddmInfo.textContent = `${calibration} калибровка. RX: ${rx}.${readiness}`;

    const number = new Intl.NumberFormat("ru", { maximumFractionDigits: 4 });
    const format = (value, unit) => value === null ? "—" : `${number.format(value)} ${unit}`;
    for (const item of result.measurements) {
        const row = document.createElement("tr");
        const dbm = item.dBm === null ? "" : ` (${format(item.dBm, "дБм")})`;
        const value = result.ready === false ? "—" : format(item.value, item.unit) + dbm;
        const flags = Object.keys(flagLabels).filter(key => item.flags?.[key]).map(key => flagLabels[key]);
        for (const entry of [ddmLabels[item.key], value,
            ...Object.keys(flagLabels).map(key => format(item.thresholds[key], item.unit)),
            item.flags ? flags.join(", ") || "Нет" : "—"]) {
            const cell = document.createElement("td");
            cell.textContent = entry;
            row.append(cell);
        }
        ddmRows.append(row);
    }
}

function show(message, error = false, success = false) {
    status.textContent = message;
    status.dataset.error = error;
    status.dataset.success = success;
}

function refresh() {
    connect.disabled = busy || Boolean(device?.opened);
    read.disabled = busy || auto.checked || !device?.opened;
    save.disabled = foregroundBusy || !dump;
    offsetField.disabled = lengthField.disabled = speed.disabled = foregroundBusy;
}

async function perform(action, { background = false } = {}) {
    busy = true;
    foregroundBusy = !background;
    if (foregroundBusy) refresh();
    try {
        await action();
    } catch (error) {
        show(error.message, true);
    } finally {
        busy = false;
        foregroundBusy = false;
        refresh();
        schedulePoll();
    }
}

function format(bytes, offset) {
    const lines = [];
    const bytesPerRow = 32;
    for (let position = 0; position < bytes.length; position += bytesPerRow) {
        const address = (offset + position).toString(16).padStart(3, "0");
        const values = Array.from(bytes.subarray(position, position + bytesPerRow), byte =>
            byte.toString(16).padStart(2, "0"));
        lines.push(`${address}  ${values.join(" ")}`.toUpperCase());
    }
    return lines.join("\n");
}

connect.addEventListener("click", () => perform(async () => {
    device = await connectCh347(undefined, { speedKhz: Number(speed.value) });
    show("CH347 подключён. Приложите pogo-пины и нажмите «Прочитать».");
}));

async function readOnce(automatic) {
    if (!automatic) {
        dump = undefined;
        hex.value = "";
        showA0();
        showDdm();
        refresh();
        show("Чтение EEPROM…");
    }
    const text = offsetField.value.trim();
    if (!/^(?:\d+|0x[\da-f]+)$/i.test(text))
        throw new Error("Введите смещение в десятичном виде или с префиксом 0x.");

    const offset = Number(text);
    const bytes = await readEeprom(device, { offset, length: Number(lengthField.value), speedKhz: Number(speed.value) });
    dump = { offset, bytes };
    hex.value = format(bytes, offset);
    showA0(parseSfpA0(bytes, offset));
    showDdm(parseSfpDdm(bytes, offset));
    const polling = automatic && auto.checked ? " Авточтение включено." : "";
    show(`Память прочитана (${bytes.length} байт) — можно убрать щуп программатора.${polling}`, false, true);
}

function schedulePoll(immediate = false) {
    clearTimeout(timer);
    if (busy || !auto.checked || !device?.opened || !interval.validity.valid) return;
    timer = setTimeout(() => perform(async () => {
        try {
            await readOnce(true);
        } catch (error) {
            const previous = dump ? " Показан последний успешный дамп." : "";
            show(error.message + previous, true);
        }
    }, { background: true }), immediate ? 0 : Math.min(interval.valueAsNumber * 1000, 2147483647));
}

auto.addEventListener("change", () => {
    refresh();
    if (!auto.checked && !busy) show("Авточтение выключено.");
    schedulePoll(true);
});
interval.addEventListener("input", () => schedulePoll());

form.addEventListener("submit", event => {
    event.preventDefault();
    if (!busy && !auto.checked && device?.opened) perform(() => readOnce(false));
});

save.addEventListener("click", () => {
    const { offset, bytes } = dump;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = eepromFilename(bytes, offset);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

navigator.hid?.addEventListener("disconnect", event => {
    if (event.device !== device) return;
    device = undefined;
    auto.checked = false;
    schedulePoll();
    show("CH347 отключён.");
    refresh();
});
if (!navigator.hid) show("Откройте страницу в Chrome или Edge с поддержкой WebHID.", true);

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(selected) {
    for (const tab of tabs) {
        const active = tab === selected;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
}
for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
        let target;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const delta = event.key === "ArrowDown" ? 1 : -1;
            target = tabs[(index + delta + tabs.length) % tabs.length];
        } else if (event.key === "Home") {
            target = tabs[0];
        } else if (event.key === "End") {
            target = tabs.at(-1);
        } else {
            return;
        }
        event.preventDefault();
        selectTab(target);
        target.focus();
    });
}
