const DEFAULT_SUPABASE_URL = "https://redwncjfnkgnoglzhzdz.supabase.co";
const DEFAULT_COEFFICIENTS = {
  Running: 170,
  Cycling: 230,
  Gym: 250
};
const DEFAULT_WEBHOOK_TARGET_EMAIL = "strofilov.a@icloud.com";

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

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
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

function extractSourceId(payload) {
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

function buildLedgerEntry(payload) {
  const createdAt = new Date().toISOString();

  return {
    type: "plus",
    title: `${payload.activity} imported`,
    minutes: payload.earnedMinutes,
    meta: "Minutes added automatically from webhook",
    timestamp: `Added ${new Date(createdAt).toLocaleString("ru-RU", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    })}`,
    createdAt,
    sourceId: payload.sourceId || null,
    sourceUrl: payload.sourceUrl || null,
    bpm: payload.bpm,
    durationMinutes: payload.durationMinutes
  };
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

async function resolveUserIdByEmail(email) {
  const pageResponse = await fetchSupabase("/auth/v1/admin/users?page=1&per_page=1000", {
    method: "GET"
  });

  if (!pageResponse.ok) {
    const details = await pageResponse.text();
    throw new Error(`Could not load Supabase users (${pageResponse.status}): ${details}`);
  }

  const payload = await pageResponse.json();
  const users = Array.isArray(payload?.users) ? payload.users : [];
  const match = users.find((user) => String(user.email || "").toLowerCase() === email.toLowerCase());

  return match?.id || null;
}

async function loadFamilyState(userId) {
  const response = await fetchSupabase(`/rest/v1/family_state?user_id=eq.${encodeURIComponent(userId)}&select=user_id,ledger,coefficients`, {
    method: "GET"
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not load family state (${response.status}): ${details}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function saveFamilyState(userId, ledger, coefficients) {
  const response = await fetchSupabase("/rest/v1/family_state", {
    method: "POST",
    headers: {
      prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify([
      {
        user_id: userId,
        ledger,
        coefficients
      }
    ])
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not save family state (${response.status}): ${details}`);
  }

  return response.json();
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  const webhookSecret = getEnv("WEBHOOK_SECRET");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!webhookSecret || !serviceRoleKey) {
    json(response, 500, {
      error: "Webhook is not configured yet. Add WEBHOOK_SECRET and SUPABASE_SERVICE_ROLE_KEY in Vercel."
    });
    return;
  }

  let payload;

  try {
    payload = await readJsonBody(request);
  } catch {
    json(response, 400, { error: "Invalid JSON body." });
    return;
  }

  const providedSecret =
    request.headers["x-webhook-secret"] ||
    request.headers["x-run-to-play-secret"] ||
    payload.secret;

  if (providedSecret !== webhookSecret) {
    json(response, 401, { error: "Invalid webhook secret." });
    return;
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const userIdFromBody = typeof payload.userId === "string" ? payload.userId.trim() : "";
  const targetEmail = email || getEnv("WEBHOOK_TARGET_EMAIL", DEFAULT_WEBHOOK_TARGET_EMAIL);
  const userId = userIdFromBody || (targetEmail ? await resolveUserIdByEmail(targetEmail) : null);

  if (!userId) {
    json(response, 400, { error: "Provide a valid userId, email, or WEBHOOK_TARGET_EMAIL." });
    return;
  }

  const activity = normalizeActivity(payload.activity || payload.type);
  const bpm = Math.max(Number(payload.bpm ?? payload.heartRate ?? 0) || 0, 0);
  const durationMinutes = parseDurationToMinutes(
    payload.clean_time ??
      payload.cleanTime ??
      payload.pureTime ??
      payload.duration ??
      payload.durationMinutes
  );
  const sourceUrl = typeof (payload.sourceUrl || payload.url) === "string" ? String(payload.sourceUrl || payload.url).trim() : "";
  const sourceId = extractSourceId(payload);

  if (!bpm || !durationMinutes) {
    json(response, 400, { error: "Payload must include bpm and clean_time (or duration)." });
    return;
  }

  try {
    const state = await loadFamilyState(userId);
    const ledger = Array.isArray(state?.ledger) ? state.ledger : [];
    const coefficients = {
      ...DEFAULT_COEFFICIENTS,
      ...(state?.coefficients && typeof state.coefficients === "object" ? state.coefficients : {})
    };

    if (sourceId && ledger.some((entry) => entry && entry.sourceId === sourceId)) {
      json(response, 200, {
        ok: true,
        duplicate: true,
        message: "Activity already imported.",
        userId,
        sourceId
      });
      return;
    }

    const coefficient = Math.max(Number(coefficients[activity]) || DEFAULT_COEFFICIENTS[activity], 1);
    const earnedMinutes = Math.max(Math.round((bpm * durationMinutes) / coefficient), 0);
    const nextLedger = ledger.concat(
      buildLedgerEntry({
        activity,
        bpm,
        durationMinutes,
        earnedMinutes,
        sourceId,
        sourceUrl
      })
    );

    await saveFamilyState(userId, nextLedger, coefficients);

    json(response, 200, {
      ok: true,
      duplicate: false,
      userId,
      targetEmail,
      sourceId,
      activity,
      bpm,
      durationMinutes,
      coefficient,
      earnedMinutes,
      balanceEntries: nextLedger.length
    });
  } catch (error) {
    json(response, 500, {
      error: "Webhook failed.",
      details: error instanceof Error ? error.message : "Unknown error."
    });
  }
}
