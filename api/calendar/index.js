import { endOptions } from "../_cors.js";
import { assertSignalWriteAccess } from "../mentors/_lib.js";
import {
  deleteEvent,
  listEvents,
  readJsonBody,
  sendJson,
  upsertEvent,
} from "./_lib.js";

export const config = { maxDuration: 30 };

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://localhost");
      const mentorEmail = url.searchParams.get("mentorEmail") || "";
      // Clients must ask for a specific mentor — never dump every mentor's signals.
      if (!normalizeEmail(mentorEmail).includes("@")) {
        sendJson(res, 200, { events: [] });
        return;
      }
      const events = await listEvents({ mentorEmail });
      sendJson(res, 200, { events });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const action = String(body.action || body.type || "upsert").toLowerCase();
      const payload = body.event || body;
      const mentorEmail = normalizeEmail(
        payload.mentorEmail || body.mentorEmail || ""
      );
      const writeToken =
        body.signalWriteToken ||
        payload.signalWriteToken ||
        req.headers?.["x-signal-write-token"] ||
        "";

      // Only the signed-in mentor can create/update/delete their own direction.
      await assertSignalWriteAccess(mentorEmail, writeToken);

      if (action === "delete" || action === "remove") {
        const event = await deleteEvent(body.id || payload.id, mentorEmail);
        sendJson(res, 200, { event });
        return;
      }

      const event = await upsertEvent({ ...payload, mentorEmail });
      sendJson(res, 200, { event });
      return;
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url || "/", "http://localhost");
      const id = url.searchParams.get("id") || "";
      const mentorEmail = url.searchParams.get("mentorEmail") || "";
      const writeToken =
        url.searchParams.get("signalWriteToken") ||
        req.headers?.["x-signal-write-token"] ||
        "";
      await assertSignalWriteAccess(mentorEmail, writeToken);
      const event = await deleteEvent(id, mentorEmail);
      sendJson(res, 200, { event });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Economic calendar sync failed",
      details: error.data || null,
    });
  }
}
