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

function parseTimeToMinutes(match) {
  if (!match) {
    return null;
  }

  const hours = match[3] ? Number(match[1]) : 0;
  const minutes = match[3] ? Number(match[2]) : Number(match[1]);
  const seconds = match[3] ? Number(match[3]) : Number(match[2]);
  return Math.round(hours * 60 + minutes + seconds / 60);
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

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  const rawUrl = request.query.url;

  if (!rawUrl || typeof rawUrl !== "string") {
    response.status(400).json({ error: "Missing activity URL." });
    return;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    response.status(400).json({ error: "Invalid URL." });
    return;
  }

  if (parsedUrl.hostname !== "s10.run") {
    response.status(400).json({ error: "Only s10.run links are supported right now." });
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
      response.status(502).json({ error: "Could not load the activity page." });
      return;
    }

    const html = await upstream.text();
    const text = htmlToText(html);
    const trackData = extractTrackDataFromHtml(html);
    const parsedHeartRate = trackData.bpm ?? extractHeartRate(text);
    const durationMinutes = trackData.cleanTime
      ? parseTimeToMinutes(trackData.cleanTime.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/))
      : extractMovingTime(text);
    const activity = inferActivityFromType(trackData.type, text);

    if (durationMinutes === null) {
      response.status(422).json({ error: "Could not find moving time on the page." });
      return;
    }

    response.status(200).json({
      heartRate: parsedHeartRate ?? 100,
      durationMinutes,
      activity
    });
  } catch {
    response.status(500).json({ error: "Failed to fetch activity data." });
  }
}
