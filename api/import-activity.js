const DEFAULT_SUPABASE_URL = "https://redwncjfnkgnoglzhzdz.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_ftH6aqby5DJ-mzpIQbbipg_jnJ3Lk8B";

function json(response, statusCode, payload) {
  response.status(statusCode).setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
  return raw ? JSON.parse(raw) : {};
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

function parseTimeToMinutes(match) {
  if (!match) {
    return null;
  }

  const hours = match[3] ? Number(match[1]) : 0;
  const minutes = match[3] ? Number(match[2]) : Number(match[1]);
  const seconds = match[3] ? Number(match[3]) : Number(match[2]);
  return Math.round(hours * 60 + minutes + seconds / 60);
}

function extractTrackDataFromHtml(html) {
  const bpmMatch = html.match(/"bpm"\s*:\s*(\d{2,3}|null)/i);
  const cleanTimeMatch =
    html.match(/"clean_time"\s*:\s*"(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})"/i) ||
    html.match(/"pureTime"\s*:\s*"(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})"/i);
  const typeMatch = html.match(/"type"\s*:\s*"([^"]+)"/i);
  const studentIdMatch = html.match(/"studentInfo"\s*:\s*{[\s\S]*?"id"\s*:\s*(\d+)/i);

  return {
    bpm: bpmMatch && bpmMatch[1] !== "null" ? Number(bpmMatch[1]) : null,
    cleanTime: cleanTimeMatch ? cleanTimeMatch[1] : null,
    type: typeMatch ? typeMatch[1] : null,
    studentId: studentIdMatch ? studentIdMatch[1] : ""
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

  return null;
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

  return normalizeActivity(fallbackText);
}

function extractSourceId(activityUrl) {
  try {
    const parsedUrl = new URL(activityUrl);
    return parsedUrl.searchParams.get("aid") || parsedUrl.toString();
  } catch {
    return "";
  }
}

async function fetchSupabase(path, options = {}) {
  const supabaseUrl = getEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL);
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  return fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function callSupabaseRpc(name, payload) {
  const response = await fetchSupabase(`/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function getAuthUser(request) {
  const authHeader = request.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const accessToken = match ? match[1] : "";

  if (!accessToken) {
    return null;
  }

  const response = await fetch(`${getEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL)}/auth/v1/user`, {
    headers: {
      apikey: getEnv("SUPABASE_ANON_KEY", DEFAULT_SUPABASE_ANON_KEY),
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function getProfile(userId) {
  const response = await fetchSupabase(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,s10_user_id,sync_enabled&limit=1`, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function fetchActivityDetails(activityUrl) {
  const upstream = await fetch(activityUrl, {
    headers: {
      "user-agent": "RunToPlayBot/1.0",
      "accept-language": "ru,en;q=0.9"
    }
  });

  if (!upstream.ok) {
    throw new Error("Could not load the S10 activity page.");
  }

  const html = await upstream.text();
  const text = htmlToText(html);
  const trackData = extractTrackDataFromHtml(html);
  const durationMinutes = trackData.cleanTime
    ? parseTimeToMinutes(trackData.cleanTime.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/))
    : extractMovingTime(text);

  if (!durationMinutes) {
    throw new Error("Could not parse moving time from the S10 activity page.");
  }

  return {
    bpm: trackData.bpm ?? extractHeartRate(text) ?? 100,
    durationMinutes,
    activity: inferActivityFromType(trackData.type, text),
    studentId: trackData.studentId
  };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  if (!getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    json(response, 500, { error: "Server is not configured." });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch {
    json(response, 400, { error: "Invalid JSON body." });
    return;
  }

  const activityUrl = typeof body.url === "string" ? body.url.trim() : "";

  if (!activityUrl) {
    json(response, 400, { error: "Missing activity URL." });
    return;
  }

  const user = await getAuthUser(request);

  if (!user?.id) {
    json(response, 401, { error: "Authentication required." });
    return;
  }

  try {
    const profile = await getProfile(user.id);

    if (!profile?.id || profile.sync_enabled === false) {
      json(response, 403, { error: "Profile sync is not enabled." });
      return;
    }

    const details = await fetchActivityDetails(activityUrl);

    if (!profile.s10_user_id || details.studentId !== String(profile.s10_user_id)) {
      json(response, 403, { error: "This activity does not belong to the signed-in S10 profile." });
      return;
    }

    const result = await callSupabaseRpc("import_activity_webhook", {
      p_user_id: user.id,
      p_source_id: extractSourceId(activityUrl),
      p_source_url: activityUrl,
      p_activity: normalizeActivity(details.activity),
      p_bpm: details.bpm,
      p_duration_minutes: details.durationMinutes,
      p_payload: {
        source: "manual_import"
      }
    });

    json(response, 200, result);
  } catch (error) {
    json(response, 500, {
      error: "Import failed.",
      details: error instanceof Error ? error.message : "Unknown error."
    });
  }
}
