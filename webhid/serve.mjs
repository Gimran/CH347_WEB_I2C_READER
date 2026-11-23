import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";

const files = new Map([
    ["/", ["index.html", "text/html"]],
    ["/style.css", ["style.css", "text/css"]],
    ["/page.mjs", ["page.mjs", "text/javascript"]],
    ["/reader.mjs", ["reader.mjs", "text/javascript"]],
]);

async function serve(request, response) {
    const asset = files.get(request.url);
    if (request.method !== "GET" || !asset) {
        response.writeHead(404).end();
        return;
    }
    try {
        const [name, type] = asset;
        const content = await readFile(new URL(name, import.meta.url));
        response.writeHead(200, {
            "Content-Type": type + "; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
            "Permissions-Policy": "hid=(self)",
            "X-Content-Type-Options": "nosniff"
        }).end(content);
    } catch (error) {
        console.error(error.message);
        response.writeHead(500).end();
    }
}

const pfx = process.env.EEPROM_WEBHID_PFX;
const host = process.env.EEPROM_WEBHID_HOST ?? "127.0.0.1";
const port = Number(process.env.EEPROM_WEBHID_PORT ?? (pfx ? 5443 : 5173));
if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("EEPROM_WEBHID_PORT must be between 1 and 65535.");
if (!pfx && host !== "127.0.0.1")
    throw new Error("LAN access requires HTTPS.");

const server = pfx
    ? createHttpsServer({ pfx: Buffer.from(pfx, "base64"), passphrase: process.env.EEPROM_WEBHID_PFX_PASSWORD }, serve)
    : createHttpServer(serve);
const url = pfx ? `https://${host}:${port}/` : `http://localhost:${port}/`;
server.listen(port, host, () => console.log(`Open ${url} in Chrome or Edge.`));