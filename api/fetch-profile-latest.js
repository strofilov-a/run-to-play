function json(response, statusCode, payload) {
  response.status(statusCode).setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function dedupeIds(matches) {
  const uniqueIds = [];

  for (const match of matches) {
    const id = match[1];
    if (id && !uniqueIds.includes(id)) {
      uniqueIds.push(id);
    }
  }

  return uniqueIds;
}

function extractLatestActivityId(html) {
  const patterns = [
    /"tracks"\s*:\s*\[\s*{\s*"id"\s*:\s*"([a-z]?\d{6,})"/gi,
    /"track"\s*:\s*{\s*"id"\s*:\s*"([a-z]?\d{6,})"/gi,
    /"id"\s*:\s*"(g\d{6,})"/gi,
    /"activity"\s*:\s*"(g\d{6,})"/gi,
    /activity\s*#(g\d{6,})/gi,
    /\b(\d{8,})\b/g,
    /\b(g\d{10,})\b/g
  ];

  for (const pattern of patterns) {
    const ids = dedupeIds(Array.from(html.matchAll(pattern)));
    if (ids.length) {
      return ids[0];
    }
  }

  return null;
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  const rawUrl = request.query.url;

  if (!rawUrl || typeof rawUrl !== "string") {
    json(response, 400, { error: "Missing profile URL." });
    return;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    json(response, 400, { error: "Invalid URL." });
    return;
  }

  if (parsedUrl.hostname !== "s10.run" || !parsedUrl.pathname.startsWith("/student")) {
    json(response, 400, { error: "Only s10.run student profile links are supported." });
    return;
  }

  try {
    const upstream = await fetch(parsedUrl.toString(), {
      headers: {
        "user-agent": "RunToPlayBot/1.0",
        "accept-language": "ru,en;q=0.9"
      }
    });

    if (!upstream.ok) {
      json(response, 502, { error: "Could not load the S10 profile page." });
      return;
    }

    const html = await upstream.text();
    const activityId = extractLatestActivityId(html);

    if (!activityId) {
      json(response, 422, { error: "Could not find the latest activity on the S10 profile page." });
      return;
    }

    json(response, 200, {
      activityId,
      activityUrl: `https://s10.run/activity?aid=${activityId}`
    });
  } catch {
    json(response, 500, { error: "Failed to fetch the S10 profile." });
  }
}
