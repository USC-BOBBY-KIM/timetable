import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { getProgramData, getPrograms, writeProgramData, writeProgramsFile } from "./scripts/generate-usc-data.mjs";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = fileURLToPath(new URL("./", import.meta.url));
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const START_HOUR = 8;
const END_HOUR = 22;
const MINUTES_PER_HOUR = 60;
const DEFAULT_COLOR = "#ef9da4";
const STUDY_COLOR = "#afe9a0";
const EXPORT_IMAGE_QUALITY = 86;
const EXPORT_PRESETS = {
  desktop: {
    filename: "campus-week-planner-desktop.jpeg",
    width: 1280,
    height: 720,
    padding: 34,
    timeWidth: 78,
    titleHeight: 70,
    headerHeight: 48,
    footerHeight: 28,
    logoOpacity: 0.16,
    logoPath: "assets/usc-wordmark.png",
  },
  phone: {
    filename: "campus-week-planner-phone.jpeg",
    width: 720,
    height: 1280,
    padding: 24,
    timeWidth: 60,
    titleHeight: 92,
    headerHeight: 52,
    footerHeight: 24,
    logoOpacity: 0.12,
    logoPath: "assets/usc-monogram.png",
  },
};
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
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

    if (request.method === "POST" && url.pathname === "/api/export/jpeg") {
      await handleJpegExportApi(request, response);
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

async function handleJpegExportApi(request, response) {
  try {
    const payload = await readJsonBody(request);
    const presetName = String(payload.preset || "").trim();
    const preset = EXPORT_PRESETS[presetName];

    if (!preset) {
      sendJson(response, 400, { error: "Invalid export preset." });
      return;
    }

    const items = sanitizeExportItems(payload.items);
    const background = await renderExportBackground(preset);
    const timetable = Buffer.from(renderTimetableSvg(items, preset));
    const jpeg = await sharp(background)
      .composite([{ input: timetable, left: 0, top: 0 }])
      .jpeg({
        quality: EXPORT_IMAGE_QUALITY,
        mozjpeg: true,
      })
      .toBuffer();

    response.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": jpeg.length,
      "Content-Disposition": `attachment; filename="${preset.filename}"`,
      "Cache-Control": "no-store",
    });
    response.end(jpeg);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Could not create the JPEG file." });
  }
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
    request.on("aborted", () => reject(new Error("Request was aborted.")));
  });
}

function sanitizeExportItems(items) {
  if (!Array.isArray(items)) return [];

  return items.slice(0, 250).flatMap((item) => {
    const day = String(item.day || "").trim();
    const title = String(item.title || "").trim().slice(0, 120);
    const type = String(item.type || "Lecture").trim().slice(0, 24);
    const location = String(item.location || "").trim().slice(0, 48);
    const color = HEX_COLOR_PATTERN.test(String(item.color || "")) ? item.color : DEFAULT_COLOR;
    const start = Number(item.start);
    const end = Number(item.end);

    if (!DAYS.includes(day) || !title || !Number.isInteger(start) || !Number.isInteger(end)) return [];
    if (start < START_HOUR * MINUTES_PER_HOUR || end > END_HOUR * MINUTES_PER_HOUR || end <= start) return [];

    return [
      {
        id: String(item.id || `${day}-${title}-${start}-${end}`).slice(0, 120),
        title,
        type,
        day,
        start,
        end,
        location,
        color,
      },
    ];
  });
}

async function renderExportBackground(preset) {
  const { width, height, logoOpacity } = preset;
  const logo = await getLogoAsset(preset.logoPath);
  const layers = [];

  if (logo) {
    const maxLogoWidth = width * 0.72;
    const maxLogoHeight = height * 0.58;
    const scale = Math.min(maxLogoWidth / logo.width, maxLogoHeight / logo.height);
    const logoWidth = Math.max(1, Math.round(logo.width * scale));
    const logoHeight = Math.max(1, Math.round(logo.height * scale));
    const left = Math.round((width - logoWidth) / 2);
    const top = Math.round((height - logoHeight) / 2);
    const logoImage = await createOpacityImage(logo.buffer, logoWidth, logoHeight, logoOpacity);
    layers.push({ input: logoImage, left, top });
  }

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#f6f3ee",
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

async function createOpacityImage(buffer, width, height, opacity) {
  const { data, info } = await sharp(buffer)
    .resize(width, height, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let index = 3; index < data.length; index += 4) {
    data[index] = Math.round(data[index] * opacity);
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

function renderTimetableSvg(items, preset) {
  const timeRange = getExportTimeRange(items);
  const { width, height, padding, timeWidth, titleHeight, headerHeight, footerHeight } = preset;
  const visibleHours = Math.max(1, timeRange.endHour - timeRange.startHour);
  const gridLeft = padding + timeWidth;
  const headerTop = padding + titleHeight;
  const gridTop = headerTop + headerHeight;
  const gridWidth = width - padding * 2 - timeWidth;
  const gridBottom = height - padding - footerHeight;
  const gridHeight = gridBottom - gridTop;
  const dayWidth = gridWidth / DAYS.length;
  const hourHeight = gridHeight / visibleHours;
  const conflicts = findConflicts(items);
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(renderBackdropGrid(width, height));
  parts.push(renderExportHeader(items, conflicts, preset, timeRange));
  parts.push(`<rect x="${padding}" y="${headerTop}" width="${width - padding * 2}" height="${gridBottom - headerTop}" fill="#ffffff" fill-opacity="0.74" stroke="#d7d8d2"/>`);
  parts.push(`<rect x="${padding}" y="${headerTop}" width="${timeWidth}" height="${headerHeight}" fill="#f8faf9" fill-opacity="0.86"/>`);
  const uscCellFontSize = Math.min(30, Math.max(20, timeWidth * 0.4));
  parts.push(`<text x="${padding + timeWidth / 2}" y="${headerTop + headerHeight / 2 + uscCellFontSize * 0.34}" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="${uscCellFontSize}" font-weight="900" fill="#990000">USC</text>`);

  DAYS.forEach((day, index) => {
    const x = gridLeft + dayWidth * index;
    parts.push(`<rect x="${x}" y="${headerTop}" width="${dayWidth}" height="${headerHeight}" fill="#ffffff" fill-opacity="0.82"/>`);
    const dayFontSize = Math.min(16, Math.max(13, dayWidth * 0.13));
    parts.push(`<text x="${x + dayWidth / 2}" y="${headerTop + headerHeight / 2 + dayFontSize * 0.36}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${dayFontSize}" font-weight="900" fill="#394348">${escapeSvgText(day)}</text>`);
  });

  for (let hour = timeRange.startHour; hour <= timeRange.endHour; hour += 1) {
    const y = gridTop + (hour - timeRange.startHour) * hourHeight;
    parts.push(`<line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="#d7d8d2"/>`);
    if (hour < timeRange.endHour) {
      parts.push(`<text x="${padding + timeWidth - 14}" y="${y + 22}" text-anchor="end" font-family="Arial, sans-serif" font-size="12" font-weight="500" fill="#687177">${escapeSvgText(toClock(hour * MINUTES_PER_HOUR))}</text>`);
    }
  }

  for (let index = 0; index <= DAYS.length; index += 1) {
    const x = gridLeft + dayWidth * index;
    parts.push(`<line x1="${x}" y1="${headerTop}" x2="${x}" y2="${gridBottom}" stroke="#d7d8d2"/>`);
  }

  items
    .slice()
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start)
    .filter((item) => item.end > timeRange.startHour * MINUTES_PER_HOUR && item.start < timeRange.endHour * MINUTES_PER_HOUR)
    .forEach((item) => {
      parts.push(renderTimetableItem(item, conflicts.has(item.id), {
        padding,
        timeWidth,
        dayWidth,
        titleHeight,
        headerHeight,
        hourHeight,
        startHour: timeRange.startHour,
        endHour: timeRange.endHour,
      }));
    });

  parts.push(`<text x="${padding}" y="${height - 12}" font-family="Arial, sans-serif" font-size="13" font-weight="500" fill="#687177">Created with Campus Week Planner</text>`);
  parts.push("</svg>");

  return parts.join("");
}

function renderBackdropGrid(width, height) {
  const lines = [];
  for (let x = 0; x < width; x += 48) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#236369" stroke-opacity="0.06"/>`);
  }
  for (let y = 0; y < height; y += 48) {
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#236369" stroke-opacity="0.06"/>`);
  }
  return `<g>${lines.join("")}</g>`;
}

function renderExportHeader(items, conflicts, preset, timeRange) {
  const { padding, width, titleHeight } = preset;
  const studyCount = items.filter((item) => item.type === "Study").length;
  const summary = `${items.length} item${items.length === 1 ? "" : "s"} · ${studyCount} study · ${conflicts.size} conflict${conflicts.size === 1 ? "" : "s"}`;
  const timeLabel = formatExportHourRange(timeRange.startHour, timeRange.endHour);

  return [
    `<rect x="${padding}" y="${padding}" width="${width - padding * 2}" height="${titleHeight - 12}" fill="#f7fbfa" fill-opacity="0.82"/>`,
    `<rect x="${padding}" y="${padding}" width="118" height="${titleHeight - 12}" fill="#e8f3f1" fill-opacity="0.82"/>`,
    `<rect x="${padding + 19}" y="${padding + 17}" width="78" height="30" rx="15" fill="#ffffff"/>`,
    `<text x="${padding + 30}" y="${padding + 37}" font-family="Arial, sans-serif" font-size="13" font-weight="900" fill="#236369">MON-FRI</text>`,
    `<text x="${padding + 142}" y="${padding + 35}" font-family="Arial, sans-serif" font-size="24" font-weight="900" fill="#202427">Week Plan</text>`,
    `<text x="${padding + 142}" y="${padding + 60}" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="#536066">${escapeSvgText(summary)}</text>`,
    `<text x="${width - padding - 6}" y="${padding + 37}" text-anchor="end" font-family="Arial, sans-serif" font-size="12" font-weight="800" fill="#687177">${escapeSvgText(timeLabel)}</text>`,
  ].join("");
}

function renderTimetableItem(item, hasConflict, layout) {
  const { padding, timeWidth, dayWidth, titleHeight, headerHeight, hourHeight, startHour, endHour } = layout;
  const dayIndex = DAYS.indexOf(item.day);
  if (dayIndex === -1) return "";

  const visibleStart = Math.max(item.start, startHour * MINUTES_PER_HOUR);
  const visibleEnd = Math.min(item.end, endHour * MINUTES_PER_HOUR);
  if (visibleEnd <= visibleStart) return "";

  const x = padding + timeWidth + dayWidth * dayIndex + 10;
  const y = padding + titleHeight + headerHeight + ((visibleStart - startHour * MINUTES_PER_HOUR) / MINUTES_PER_HOUR) * hourHeight + 5;
  const itemWidth = dayWidth - 20;
  const itemHeight = Math.max(48, ((visibleEnd - visibleStart) / MINUTES_PER_HOUR) * hourHeight - 10);
  const color = hasConflict ? "#a43f45" : item.type === "Study" ? STUDY_COLOR : item.color;
  const textColor = hasConflict ? "#ffffff" : getReadableTextColor(color);
  const mutedColor = hasConflict ? "#ffffff" : "#202427";
  const mutedOpacity = hasConflict ? "0.9" : "0.78";
  const { code, name } = splitScheduleTitle(item.title);
  const codeFontSize = Math.min(21, Math.max(15, itemWidth * 0.145));
  const detailFontSize = Math.min(13, Math.max(10, itemWidth * 0.105));
  const detailLineHeight = detailFontSize + 3;
  const codeText = trimSvgText(code, itemWidth - 28, codeFontSize);
  const nameLines = itemHeight > 72 ? wrapSvgText(name, itemWidth - 28, detailFontSize, 2) : [];
  const meta = trimSvgText(`${item.type} · ${formatRange(item.start, item.end)}${item.location ? ` · ${item.location}` : ""}`, itemWidth - 28, detailFontSize);

  return [
    `<rect x="${x}" y="${y}" width="${itemWidth}" height="${itemHeight}" rx="10" fill="${color}"/>`,
    `<text x="${x + 14}" y="${y + codeFontSize + 7}" font-family="Arial, sans-serif" font-size="${codeFontSize}" font-weight="900" fill="${textColor}">${escapeSvgText(codeText)}</text>`,
    nameLines.map((line, index) => `<text x="${x + 14}" y="${y + codeFontSize + 24 + index * detailLineHeight}" font-family="Arial, sans-serif" font-size="${detailFontSize}" font-weight="700" fill="${mutedColor}" fill-opacity="${mutedOpacity}">${escapeSvgText(line)}</text>`).join(""),
    `<text x="${x + 14}" y="${y + itemHeight - 14}" font-family="Arial, sans-serif" font-size="${detailFontSize}" font-weight="600" fill="${mutedColor}" fill-opacity="${mutedOpacity}">${escapeSvgText(meta)}</text>`,
  ].join("");
}

const logoCache = new Map();

async function getLogoAsset(logoPath) {
  if (!logoPath) return null;
  if (logoCache.has(logoPath)) return logoCache.get(logoPath);

  const promise = readFile(join(ROOT_DIR, logoPath))
    .then((buffer) => ({
      buffer,
      ...getPngDimensions(buffer),
    }))
    .catch(() => null);

  logoCache.set(logoPath, promise);
  return promise;
}

function getPngDimensions(buffer) {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function getExportTimeRange(items) {
  if (!items.length) {
    return { startHour: 9, endHour: 18 };
  }

  const earliestStart = Math.min(...items.map((item) => item.start));
  const latestEnd = Math.max(...items.map((item) => item.end));
  const startHour = earliestStart < 9 * MINUTES_PER_HOUR ? START_HOUR : 9;
  const roundedEndHour = Math.ceil(latestEnd / MINUTES_PER_HOUR);
  const endHour = Math.min(END_HOUR, Math.max(startHour + 1, roundedEndHour));

  return { startHour, endHour };
}

function findConflicts(items) {
  const conflictIds = new Set();

  DAYS.forEach((day) => {
    const dayItems = items
      .filter((item) => item.day === day)
      .sort((a, b) => a.start - b.start);

    dayItems.forEach((item, index) => {
      for (let nextIndex = index + 1; nextIndex < dayItems.length; nextIndex += 1) {
        const next = dayItems[nextIndex];
        if (next.start >= item.end) break;
        conflictIds.add(item.id);
        conflictIds.add(next.id);
      }
    });
  });

  return conflictIds;
}

function toClock(minutes) {
  const date = new Date(2000, 0, 1, 0, minutes);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRange(start, end) {
  return `${toClock(start)}-${toClock(end)}`;
}

function formatExportHourRange(startHour, endHour) {
  return `${formatExportHour(startHour)}-${formatExportHour(endHour)}`;
}

function formatExportHour(hour) {
  return toClock(hour * MINUTES_PER_HOUR).replace(":00", "");
}

function splitScheduleTitle(title) {
  const match = title.match(/^([A-Z]{2,5}\s+\d+[A-Z]*[a-z]*)(?:\s+-\s+(.+))?$/);

  if (!match) {
    return { code: title, name: "" };
  }

  return {
    code: match[1],
    name: match[2] || "",
  };
}

function wrapSvgText(text, maxWidth, fontSize, maxLines) {
  if (!text) return [];

  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (measureSvgText(candidate, fontSize) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  });
  if (line) lines.push(line);

  return lines.slice(0, maxLines).map((currentLine, index) => {
    const isLastVisibleLine = index === maxLines - 1 && lines.length > maxLines;
    return trimSvgText(isLastVisibleLine ? `${currentLine}...` : currentLine, maxWidth, fontSize);
  });
}

function trimSvgText(text, maxWidth, fontSize) {
  const output = String(text || "");
  const maxCharacters = Math.max(1, Math.floor(maxWidth / (fontSize * 0.56)));

  if (output.length <= maxCharacters) return output;
  if (maxCharacters <= 3) return ".".repeat(maxCharacters);

  return `${output.slice(0, maxCharacters - 3)}...`;
}

function measureSvgText(text, fontSize) {
  return String(text || "").length * fontSize * 0.56;
}

function getReadableTextColor(color) {
  const red = parseInt(color.slice(1, 3), 16);
  const green = parseInt(color.slice(3, 5), 16);
  const blue = parseInt(color.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.56 ? "#202427" : "#ffffff";
}

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
