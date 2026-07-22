import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..", "..");
const HOST = "127.0.0.1";
const PORT = 8000;
const CONTENT_TYPES = Object.freeze({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8"
});

function isAllowedPath(pathname) {
    return ["/index.html", "/admin.html", "/style.css"].includes(pathname)
        || pathname.startsWith("/js/")
        || pathname.startsWith("/Images/");
}

export function createSandboxStaticServer() {
    return createServer((req, res) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
        } catch {
            res.writeHead(400).end("Bad request");
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed");
            return;
        }
        if (pathname === "/") {
            pathname = "/index.html";
        }
        if (
            !isAllowedPath(pathname)
            || pathname.includes("\\")
            || pathname.split("/").some(part => part.startsWith("."))
        ) {
            res.writeHead(404).end("Not found");
            return;
        }
        const filePath = resolve(REPOSITORY_DIRECTORY, `.${pathname}`);
        if (!filePath.startsWith(`${REPOSITORY_DIRECTORY}${sep}`)) {
            res.writeHead(404).end("Not found");
            return;
        }
        let fileStatus;
        try {
            fileStatus = statSync(filePath);
        } catch {
            res.writeHead(404).end("Not found");
            return;
        }
        if (!fileStatus.isFile()) {
            res.writeHead(404).end("Not found");
            return;
        }
        res.writeHead(200, {
            "cache-control": "no-store",
            "content-length": fileStatus.size,
            "content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
            "x-content-type-options": "nosniff"
        });
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        createReadStream(filePath).pipe(res);
    });
}

export function startSandboxStaticServer() {
    const server = createSandboxStaticServer();
    server.listen(PORT, HOST, () => {
        process.stdout.write(`Sandbox website ready at http://localhost:${PORT}\n`);
    });
    const stop = () => server.close(() => process.exitCode = 0);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return server;
}

const invokedPath = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : null;
if (invokedPath === import.meta.url) {
    startSandboxStaticServer();
}
