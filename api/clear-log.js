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

  try {
    const result = await callSupabaseRpc("clear_family_log", {
      p_user_id: user.id
    });

    json(response, 200, result);
  } catch (error) {
    json(response, 500, {
      error: "Clear failed.",
      details: error instanceof Error ? error.message : "Unknown error."
    });
  }
}
