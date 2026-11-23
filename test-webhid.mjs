import assert from "node:assert/strict";
import { connectCh347, readEeprom, parseSfpA0, parseSfpDdm, eepromFilename } from "./webhid/reader.mjs";

class FakeCh347 extends EventTarget {
    async open() { this.opened = true; }
    async close() { this.opened = false; }

    async sendReport(id, packet) {
        assert.equal(id, 0);
        assert.equal(packet.length, 512);
        const size = new DataView(packet.buffer).getUint16(0, true);
        const command = [...packet.subarray(2, size + 2)];
        if ([0x60, 0x61, 0x62, 0x63, 0x66].includes(command[1])) {
            assert.deepEqual(command, [0xAA, command[1], 0]);
            this.modes = [...(this.modes ?? []), command[1] & 7];
            return;
        }
        assert.deepEqual(command.slice(0, 3), [0xAA, 0x74, 0x82]);
        const bank = command[3] >> 1;
        const offset = command[4];
        const count = command.length === 11 ? 1 : (command[8] & 63) + 1;
        assert.ok(bank >= 0x50 && bank <= 0x53 && offset + count <= 256);
        assert.deepEqual(command.slice(5, 8), [0x74, 0x81, command[3] | 1]);
        assert.deepEqual(command.slice(-3), [0xC0, 0x75, 0]);

        const response = new Uint8Array(512);
        response.set([count + 3, 0, Number(!this.nack), 1, 1]);
        for (let i = 0; i < count; i++) response[5 + i] = (offset + i + bank) & 255;
        this.dispatchEvent(Object.assign(new Event("inputreport"), {
            reportId: 0,
            data: new DataView(response.buffer)
        }));
    }
}

const fake = new FakeCh347();
fake.nack = true;
const device = await connectCh347({
    requestDevice: async ({ filters }) => {
        assert.deepEqual(filters, [{ vendorId: 0x1A86, productId: 0x55DC, usagePage: 0xFFA0, usage: 1 }]);
        return [fake];
    }
});
assert.deepEqual(fake.modes, [2]);
await assert.rejects(readEeprom(device), /Нет ACK/);
fake.nack = false;
const bytes = await readEeprom(device);
assert.equal(bytes.length, 1024);
assert.equal(bytes[1023], 0x52);
assert.deepEqual([...await readEeprom(device, { offset: 255, length: 2 })], [0x4F, 0x51]);
await assert.rejects(readEeprom(device, { offset: 1024, length: 1 }), RangeError);
await readEeprom(device, { length: 1, speedKhz: 100 });
await readEeprom(device, { length: 1, speedKhz: 100 });
await assert.rejects(readEeprom(device, { length: 1, speedKhz: 250 }), RangeError);
await readEeprom(device, { length: 1, speedKhz: 750 });
await readEeprom(device, { length: 1, speedKhz: 1000 });
assert.deepEqual(fake.modes, [2, 1, 3, 6]);
await device.close();
console.log("WebHID 24C08 mock checks passed.");

const ddm = new Uint8Array(512);
ddm[0] = 3;
ddm[92] = 0x68; // DDM, internal calibration, average RX power
ddm[93] = 0x80; // alarm and warning flags
const a2 = new DataView(ddm.buffer, 256);
a2.setInt16(96, -5 * 256);
a2.setUint16(98, 33000);
a2.setUint16(100, 2500);
a2.setUint16(102, 10000);
a2.setUint16(104, 1000);
a2.setInt16(2, -10 * 256);
a2.setUint8(112, 0x40);
a2.setUint8(117, 0x80);
const internal = parseSfpDdm(ddm);
assert.equal(internal.calibration, "internal");
assert.equal(internal.rxPowerType, "average");
assert.deepEqual(internal.measurements.map(item => item.value), [-5, 3.3000000000000003, 5, 1, 0.1]);
assert.equal(internal.measurements[0].thresholds.lowAlarm, -10);
assert.equal(internal.measurements[0].flags.lowAlarm, true);
assert.equal(internal.measurements[4].flags.highWarning, true);
assert.equal(internal.measurements[4].dBm, -10);
assert.equal(parseSfpDdm(ddm.subarray(0, 256)).state, "missing-a2");
assert.equal(parseSfpDdm(ddm.subarray(256), 256).state, "missing-a0");
a2.setUint8(110, 1);
assert.equal(parseSfpDdm(ddm).ready, false);
ddm[92] = 0x50;
a2.setUint16(84, 512);
a2.setInt16(86, 256);
a2.setUint16(88, 256);
a2.setUint16(76, 256);
a2.setUint16(80, 256);
a2.setUint16(104, 10);
a2.setFloat32(56, 1);
a2.setFloat32(68, 2);
a2.setFloat32(72, 5);
const external = parseSfpDdm(ddm);
assert.equal(external.calibration, "external");
assert.equal(external.measurements[0].value, -9);
assert.equal(external.measurements[4].value, 1.0025);
ddm[92] = 0;
assert.equal(parseSfpDdm(ddm).state, "unsupported-ddm");
console.log("SFF-8472 DDM checks passed.");

const a0 = new Uint8Array(96);
a0[0] = 3;
a0[2] = 7;
a0[3] = 0x20;
a0[11] = 6;
a0[12] = 255;
a0[14] = 10;
a0[18] = 9;
a0.set(new TextEncoder().encode("FIBO TEST"), 20);
a0.set([0x11, 0x22, 0xAA], 37);
a0.set([0x05, 0x1E], 60);
a0[65] = 0x10;
a0[66] = 103;
a0[67] = 2;
a0[92] = 0x60;
a0[63] = a0.subarray(0, 63).reduce((sum, b) => sum + b, 0) & 255;
a0[95] = a0.subarray(64, 95).reduce((sum, b) => sum + b, 0) & 255;
const fields = input => Object.fromEntries(parseSfpA0(input).groups.flatMap(group => group.fields));
const info = fields(a0);
assert.equal(info["Разъём"], "LC (0x07)");
assert.equal(info["Vendor"], "FIBO TEST");
assert.equal(info.OUI, "11:22:AA");
assert.equal(info["Скорость сигнализации"], "25750 Мбод");
assert.equal(info["Длина волны"], "1310 нм");
assert.equal(info.OM4, "90 м");
assert.match(info["Опции"], /TX_DISABLE/);
assert.match(info["10G Ethernet / 1X InfiniBand · 0x03"], /10GBASE-LR/);
assert.match(info.CC_BASE, /OK/);
assert.match(info.CC_EXT, /OK/);
a0[8] = 4;
assert.equal(fields(a0)["Длина кабеля · поле 0x12"], "9 м");
assert.match(fields(a0).CC_BASE, /ожидалось/);
assert.equal(parseSfpA0(a0.subarray(0, 95)).state, "missing-a0");
assert.equal(parseSfpA0(a0, 256).state, "missing-a0");
assert.equal(parseSfpA0(new Uint8Array(96)).state, "unsupported-module");
console.log("SFF-8472 A0 identification checks passed.");

a0.set(new TextEncoder().encode("FT/10:LR"), 40);
const saveDate = new Date(2026, 0, 9, 12);
assert.equal(eepromFilename(a0, 0, saveDate), "09-01-2026_FIBO TEST_FT-10-LR.bin");
assert.equal(eepromFilename(a0.subarray(0, 94), 0, saveDate), "09-01-2026_UnknownVendor_UnknownPN.bin");
assert.equal(eepromFilename(a0, 256, saveDate), "09-01-2026_UnknownVendor_UnknownPN.bin");
console.log("EEPROM filename checks passed.");
