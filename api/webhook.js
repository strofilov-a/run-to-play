const DEFAULT_SUPABASE_URL = "https://redwncjfnkgnoglzhzdz.supabase.co";

function json(response, statusCode, payload) {
  response.status(statusCode).setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getFirstValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function readGetPayload(request) {
  const query = request.query || {};
  const payload = {};

  for (const [key, value] of Object.entries(query)) {
    payload[key] = getFirstValue(value);
  }

  return payload;
}

function parseDurationToMinutes(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(Math.round(value), 0);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const clockMatch = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

  if (clockMatch) {
    const hours = clockMatch[3] ? Number(clockMatch[1]) : 0;
    const minutes = clockMatch[3] ? Number(clockMatch[2]) : Number(clockMatch[1]);
    const seconds = clockMatch[3] ? Number(clockMatch[3]) : Number(clockMatch[2]);
    return Math.max(Math.round(hours * 60 + minutes + seconds / 60), 0);
  }

  const compact = normalized.replace(/\s+/g, "");
  const hoursMatch = compact.match(/(\d+)h/);
  const minutesMatch = compact.match(/(\d+)m/);
  const secondsMatch = compact.match(/(\d+)s/);

  if (!hoursMatch && !minutesMatch && !secondsMatch) {
    return null;
  }

  const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
  const minutes = minutesMatch ? Number(minutesMatch[1]) : 0;
  const seconds = secondsMatch ? Number(secondsMatch[1]) : 0;

  return Math.max(Math.round(hours * 60 + minutes + seconds / 60), 0);
}

function parseTimeToMinutes(match) {
  if (!match) {
    return null;
  }

  const hours = match[3] ? Number(match[1]) : 0;
  const minutes = match[3] ? Number(match[2]) : Number(match[1]);
  const seconds = match[3] ? Number(match[3]) : Number(match[2]);
  return Math.round(hours * 60 + minutes + seconds / 60);
}

function normalizeActivity(rawActivity) {
  const source = String(rawActivity || "").toLowerCase();

  if (/cycle|bike|velo|вел/i.test(source)) {
    return "Cycling";
  }

  if (/gym|strength|зал|сил/i.test(source)) {
    return "Gym";
  }

  return "Running";
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTrackDataFromHtml(html) {
  const bpmMatch = html.match(/"bpm"\s*:\s*(\d{2,3})/i);
  const cleanTimeMatch =
    html.match(/"clean_time"\s*:\s*"(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})"/i) ||
    html.match(/"pureTime"\s*:\s*"(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})"/i);
  const typeMatch = html.match(/"type"\s*:\s*"([^"]+)"/i);

  return {
    bpm: bpmMatch ? Number(bpmMatch[1]) : null,
    cleanTime: cleanTimeMatch ? cleanTimeMatch[1] : null,
    type: typeMatch ? typeMatch[1] : null
  };
}

function extractHeartRate(text) {
  const bpmMatch =
    text.match(/(\d{2,3})\s*bpm/i) ||
    text.match(/пульс[^0-9]{0,20}(\d{2,3})/i) ||
    text.match(/heart\s*rate[^0-9]{0,20}(\d{2,3})/i);

  if (!bpmMatch) {
    return null;
  }

  const value = Number(bpmMatch[1]);
  return value >= 60 && value <= 220 ? value : null;
}

function extractMovingTime(text) {
  const strictMovingTime =
    text.match(/чист[ао]е\s*время[^0-9]{0,20}(\d{1,2}):(\d{2})(?::(\d{2}))?/i) ||
    text.match(/moving\s*time[^0-9]{0,20}(\d{1,2}):(\d{2})(?::(\d{2}))?/i);

  const strictMinutes = parseTimeToMinutes(strictMovingTime);
  if (strictMinutes !== null) {
    return strictMinutes;
  }

  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] || "";
    const combined = `${line} ${nextLine}`.trim();

    if (/чист[ао]е\s*время/i.test(line) || /moving\s*time/i.test(line)) {
      const nearby = combined.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      const nearbyMinutes = parseTimeToMinutes(nearby);
      if (nearbyMinutes !== null) {
        return nearbyMinutes;
      }
    }
  }

  return null;
}

function inferActivity(text) {
  if (/cycle|cycling|вело|велосип/i.test(text)) {
    return "Cycling";
  }

  if (/gym|зал|силов/i.test(text)) {
    return "Gym";
  }

  return "Running";
}

function inferActivityFromType(type, fallbackText) {
  if (/cycle|bike/i.test(type || "")) {
    return "Cycling";
  }

  if (/gym|strength/i.test(type || "")) {
    return "Gym";
  }

  if (/run/i.test(type || "")) {
    return "Running";
  }

  return inferActivity(fallbackText);
}

function extractSourceId(payload) {
  if (typeof payload.newactivity === "string" && payload.newactivity.trim()) {
    return payload.newactivity.trim();
  }

  if (typeof payload.sourceId === "string" && payload.sourceId.trim()) {
    return payload.sourceId.trim();
  }

  const url = payload.sourceUrl || payload.url;

  if (typeof url !== "string") {
    return "";
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.searchParams.get("aid") || parsedUrl.toString();
  } catch {
    return url.trim();
  }
}

function buildActivityUrl(sourceId, payload) {
  if (typeof payload.url === "string" && payload.url.trim()) {
    return payload.url.trim();
  }

  if (typeof payload.sourceUrl === "string" && payload.sourceUrl.trim()) {
    return payload.sourceUrl.trim();
  }

  return sourceId ? `https://s10.run/activity?aid=${encodeURIComponent(sourceId)}` : "";
}

async function fetchSupabase(path, options = {}) {
  const supabaseUrl = getEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL);
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  return response;
}

async function callSupabaseRpc(name, payload) {
  const response = await fetchSupabase(`/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not execute ${name} (${response.status}): ${details}`);
  }

  return response.json();
}

async function resolveProfileByWebhookSecret(secret) {
  const response = await fetchSupabase(
    `/rest/v1/profiles?webhook_secret=eq.${encodeURIComponent(secret)}&select=id,sync_enabled&limit=1`,
    { method: "GET" }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not resolve webhook secret (${response.status}): ${details}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function resolveProfileByS10UserId(s10UserId) {
  const response = await fetchSupabase(
    `/rest/v1/profiles?s10_user_id=eq.${encodeURIComponent(s10UserId)}&select=id,sync_enabled&limit=1`,
    { method: "GET" }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not resolve S10 user (${response.status}): ${details}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchActivityDetails(activityUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(activityUrl);
  } catch {
    throw new Error("Invalid activity URL.");
  }

  if (parsedUrl.hostname !== "s10.run") {
    throw new Error("Only s10.run activity links are supported.");
  }

  const upstream = await fetch(parsedUrl.toString(), {
    headers: {
      "user-agent": "RunToPlayBot/1.0",
      "accept-language": "ru,en;q=0.9"
    }
  });

  if (!upstream.ok) {
    throw new Error(`Could not load the activity page (${upstream.status}).`);
  }

  const html = await upstream.text();
  const text = htmlToText(html);
  const trackData = extractTrackDataFromHtml(html);
  const bpm = trackData.bpm ?? extractHeartRate(text);
  const durationMinutes = trackData.cleanTime
    ? parseTimeToMinutes(trackData.cleanTime.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/))
    : extractMovingTime(text);
  const activity = inferActivityFromType(trackData.type, text);

  if (!bpm || !durationMinutes) {
    throw new Error("Could not parse bpm and moving time from the S10 activity page.");
  }

  return {
    bpm,
    durationMinutes,
    activity: normalizeActivity(activity)
  };
}

export default async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "GET") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!serviceRoleKey) {
    json(response, 500, {
      error: "Webhook is not configured yet. Add SUPABASE_SERVICE_ROLE_KEY in Vercel."
    });
    return;
  }

  let payload;

  try {
    payload = request.method === "GET" ? readGetPayload(request) : await readJsonBody(request);
  } catch {
    json(response, 400, {
      error: request.method === "GET" ? "Invalid query string." : "Invalid JSON body."
    });
    return;
  }

  const s10UserId = String(payload.user || payload.s10_user_id || "").trim();
  const sourceId = extractSourceId(payload);
  const activityUrl = buildActivityUrl(sourceId, payload);
  const providedSecret =
    request.headers["x-webhook-secret"] ||
    request.headers["x-run-to-play-secret"] ||
    payload.webhook_secret ||
    payload.secret;

  if (!sourceId) {
    json(response, 400, { error: "Missing newactivity/sourceId." });
    return;
  }

  if (!s10UserId && !providedSecret) {
    json(response, 400, { error: "Missing user or webhook secret." });
    return;
  }

  try {
    const profile = s10UserId
      ? await resolveProfileByS10UserId(s10UserId)
      : await resolveProfileByWebhookSecret(providedSecret);

    if (!profile?.id) {
      json(response, 401, { error: "Unknown S10 user or webhook secret." });
      return;
    }

    if (profile.sync_enabled === false) {
      json(response, 409, { error: "Automatic sync is disabled for this account." });
      return;
    }

    const details = await fetchActivityDetails(activityUrl);
    const result = await callSupabaseRpc("import_activity_webhook", {
      p_user_id: profile.id,
      p_source_id: sourceId,
      p_source_url: activityUrl || null,
      p_activity: details.activity,
      p_bpm: details.bpm,
      p_duration_minutes: details.durationMinutes,
      p_payload: {
        ...payload,
        resolved_activity_url: activityUrl,
        s10_user_id: s10UserId || null
      }
    });

    json(response, 200, result);
  } catch (error) {
    json(response, 500, {
      error: "Webhook failed.",
      details: error instanceof Error ? error.message : "Unknown error."
    });
  }
}
