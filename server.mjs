import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { getProgramData, getPrograms, writeProgramData, writeProgramsFile } from "./scripts/generate-usc-data.mjs";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = fileURLToPath(new URL("./", import.meta.url));
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

let programRefreshPromise = null;
const onlineClients = new Set();
const onlineClientCounts = new Map();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`);

    if (request.method === "GET" && url.pathname === "/api/usc/programs") {
      await handleProgramsApi(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/online") {
      handleOnlineStream(url, request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/usc/program") {
      await handleProgramApi(url, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    await serveStatic(url.pathname, request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Server error." });
  }
});

async function handleProgramsApi(response) {
  const programs = await refreshPrograms();
  sendJson(response, 200, {
    termCode: 20263,
    refreshedAt: new Date().toISOString(),
    programs,
  });
}

async function handleProgramApi(url, response) {
  const school = String(url.searchParams.get("school") || "").trim();
  const programPrefix = String(url.searchParams.get("program") || "").trim();

  if (!school || !programPrefix) {
    sendJson(response, 400, { error: "Missing school or program parameter." });
    return;
  }

  const programs = await refreshPrograms();
  const program = programs.find((candidate) => candidate.schoolPrefix === school && candidate.programPrefix === programPrefix);

  if (!program) {
    sendJson(response, 404, { error: "USC major not found." });
    return;
  }

  const payload = await getProgramData(program);
  await writeProgramData(program, payload);
  sendJson(response, 200, payload);
}

function handleOnlineStream(url, request, response) {
  const clientId = String(url.searchParams.get("client") || `connection-${Date.now()}-${Math.random()}`).trim();
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  });
  response.write("\n");

  onlineClients.add(response);
  onlineClientCounts.set(clientId, (onlineClientCounts.get(clientId) || 0) + 1);
  broadcastOnlineCount();

  const keepAlive = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, 25000);

  request.on("close", () => {
    clearInterval(keepAlive);
    onlineClients.delete(response);
    const nextCount = (onlineClientCounts.get(clientId) || 1) - 1;
    if (nextCount > 0) {
      onlineClientCounts.set(clientId, nextCount);
    } else {
      onlineClientCounts.delete(clientId);
    }
    broadcastOnlineCount();
  });
}

function broadcastOnlineCount() {
  const payload = `data: ${JSON.stringify({ count: onlineClientCounts.size })}\n\n`;
  for (const client of onlineClients) {
    client.write(payload);
  }
}

function refreshPrograms() {
  if (!programRefreshPromise) {
    programRefreshPromise = getPrograms()
      .then(async (programs) => {
        await writeProgramsFile(programs);
        return programs;
      })
      .finally(() => {
        programRefreshPromise = null;
      });
  }

  return programRefreshPromise;
}

async function serveStatic(pathname, request, response) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = normalize(join(ROOT_DIR, requestedPath));
  const relativePath = relative(ROOT_DIR, filePath);

  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes("..")) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Length": fileStat.size,
      "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

server.listen(PORT, HOST, () => {
  console.log(`Campus Week Planner is running at http://${HOST}:${PORT}/`);
});
