const DEFAULT_SUPABASE_URL = "https://redwncjfnkgnoglzhzdz.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_ftH6aqby5DJ-mzpIQbbipg_jnJ3Lk8B";
const DEFAULT_COEFFICIENTS = {
  Running: 111,
  Cycling: 230,
  Gym: 250
};

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
  const response = await fetchSupabase(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,family_id,role&limit=1`, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function getFamilyState(familyId) {
  const response = await fetchSupabase(`/rest/v1/family_state?family_id=eq.${encodeURIComponent(familyId)}&select=user_id,family_id,ledger,coefficients&limit=1`, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function saveFamilyState(payload) {
  const response = await fetchSupabase("/rest/v1/family_state", {
    method: "POST",
    headers: {
      prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify([payload])
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : null;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  const user = await getAuthUser(request);

  if (!user?.id) {
    json(response, 401, { error: "Authentication required." });
    return;
  }

  let body;

  try {
    body = await readJsonBody(request);
  } catch {
    json(response, 400, { error: "Invalid JSON body." });
    return;
  }

  const activity = String(body.activity || "Running");
  const bpm = Math.max(Number(body.heartRate) || 0, 0);
  const durationMinutes = Math.max(Number(body.durationMinutes) || 0, 0);
  const bonus = Math.max(Number(body.bonus) || 0, 0);

  if (!durationMinutes || !bpm) {
    json(response, 400, { error: "Heart rate and duration are required." });
    return;
  }

  try {
    const profile = await getProfile(user.id);

    if (!profile?.id) {
      json(response, 403, { error: "Profile not found." });
      return;
    }

    if (profile.role !== "parent") {
      json(response, 403, { error: "Only parent accounts can add manual sessions." });
      return;
    }

    const state = await getFamilyState(profile.family_id || user.id);
    const coefficients = {
      ...DEFAULT_COEFFICIENTS,
      ...(state?.coefficients && typeof state.coefficients === "object" ? state.coefficients : {})
    };
    const coefficient = Math.max(Number(coefficients[activity]) || DEFAULT_COEFFICIENTS[activity] || 111, 1);
    const earnedMinutes = Math.max(Math.round((bpm * durationMinutes) / coefficient + bonus), 0);
    const createdAt = new Date().toISOString();
    const nextLedger = (Array.isArray(state?.ledger) ? state.ledger : []).concat([
      {
        type: "plus",
        title: `${activity} added`,
        minutes: earnedMinutes,
        meta: `${durationMinutes} min at ${bpm} bpm${bonus ? ` + ${bonus} bonus` : ""}`,
        timestamp: "Добавлено вручную",
        createdAt,
        sourceUrl: null
      }
    ]);

    const saved = await saveFamilyState({
      user_id: state?.user_id || user.id,
      family_id: state?.family_id || profile.family_id || user.id,
      ledger: nextLedger,
      coefficients
    });

    json(response, 200, {
      ok: true,
      activity,
      bpm,
      durationMinutes,
      bonus,
      earnedMinutes,
      balanceEntries: Array.isArray(saved?.ledger) ? saved.ledger.length : nextLedger.length
    });
  } catch (error) {
    json(response, 500, {
      error: "Manual add failed.",
      details: error instanceof Error ? error.message : "Unknown error."
    });
  }
}
