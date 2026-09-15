// src/routes.js — all API endpoints for the Meet Notetaker backend.

import { Router } from "express";
import {
  transcribeFromUrl,
  summarizeTranscript,
  answerQuestion,
} from "./groq.js";
import {
  listMeetings,
  getMeetingById,
  createMeeting,
  updateMeeting,
  deleteMeeting,
} from "./db.js";

const router = Router();

// Hard cap on JSON body size. Transcripts can be long but not unbounded.
const MAX_BODY_BYTES = "2mb";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function serverError(res, err, context) {
  console.error(`[api] ${context}:`, err);
  return res.status(500).json({
    error: `${context} failed`,
    detail: err?.message || String(err),
  });
}

/** Express async handler wrapper that routes errors to a 500 response. */
function asyncHandler(context, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!res.headersSent) serverError(res, err, context);
    }
  };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// POST /api/transcribe  { audioUrl, meetingId }
// Audio is already on Cloudinary — we pass the URL to Groq, not the bytes.
// If meetingId is supplied we persist transcript + audio metadata.
// ---------------------------------------------------------------------------
router.post(
  "/transcribe",
  asyncHandler("Transcription", async (req, res) => {
    const { audioUrl, meetingId } = req.body || {};

    if (!isNonEmptyString(audioUrl)) {
      return badRequest(res, "audioUrl is required and must be a non-empty string.");
    }

    let transcript;
    try {
      transcript = await transcribeFromUrl(audioUrl);
    } catch (err) {
      // Surface the real Groq error instead of returning null.
      console.error("[api] Groq transcribe error:", err);
      return res.status(502).json({
        error: "Transcription failed",
        detail: err?.message || String(err),
      });
    }

    if (meetingId) {
      const meeting = await getMeetingById(meetingId);
      if (!meeting) {
        return res.status(404).json({ error: `Meeting ${meetingId} not found.` });
      }
      await updateMeeting(meetingId, { transcript, audioUrl });
    }

    return res.json({ transcript });
  })
);

// ---------------------------------------------------------------------------
// POST /api/summarize  { transcript, meetingId }
// ---------------------------------------------------------------------------
router.post(
  "/summarize",
  asyncHandler("Summarization", async (req, res) => {
    const { transcript, meetingId } = req.body || {};

    if (!isNonEmptyString(transcript)) {
      return badRequest(res, "transcript is required and must be a non-empty string.");
    }

    let summary;
    try {
      summary = await summarizeTranscript(transcript);
    } catch (err) {
      console.error("[api] Groq summarize error:", err);
      return res.status(502).json({
        error: "Summarization failed",
        detail: err?.message || String(err),
      });
    }

    if (meetingId) {
      const meeting = await getMeetingById(meetingId);
      if (!meeting) {
        return res.status(404).json({ error: `Meeting ${meetingId} not found.` });
      }
      await updateMeeting(meetingId, {
        transcript,
        overview: summary.overview,
        keyPoints: summary.keyPoints,
        actionItems: summary.actionItems,
      });
    }

    return res.json({
      overview: summary.overview,
      keyPoints: summary.keyPoints,
      actionItems: summary.actionItems,
      notes: summary.notes,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/ask  { question, transcript }
// ---------------------------------------------------------------------------
router.post(
  "/ask",
  asyncHandler("Q&A", async (req, res) => {
    const { question, transcript } = req.body || {};

    if (!isNonEmptyString(question)) {
      return badRequest(res, "question is required and must be a non-empty string.");
    }
    if (!isNonEmptyString(transcript)) {
      return badRequest(res, "transcript is required and must be a non-empty string.");
    }

    try {
      const answer = await answerQuestion(question, transcript);
      return res.json({ answer });
    } catch (err) {
      console.error("[api] Groq ask error:", err);
      return res.status(502).json({
        error: "Question answering failed",
        detail: err?.message || String(err),
      });
    }
  })
);

// ---------------------------------------------------------------------------
// POST /api/retranscribe  { meetingId, audioUrl }
// Re-runs transcribe + summarize for an existing meeting. No re-upload needed
// when the meeting already has a stored Cloudinary URL.
// ---------------------------------------------------------------------------
router.post(
  "/retranscribe",
  asyncHandler("Retranscription", async (req, res) => {
    const { meetingId } = req.body || {};
    let { audioUrl } = req.body || {};

    if (!isNonEmptyString(meetingId)) {
      return badRequest(res, "meetingId is required.");
    }

    const meeting = await getMeetingById(meetingId);
    if (!meeting) {
      return res.status(404).json({ error: `Meeting ${meetingId} not found.` });
    }

    audioUrl = audioUrl || meeting.audioUrl;
    if (!isNonEmptyString(audioUrl)) {
      return badRequest(
        res,
        "No audio URL available for this meeting. Supply audioUrl or store one first."
      );
    }

    let transcript;
    try {
      transcript = await transcribeFromUrl(audioUrl);
    } catch (err) {
      console.error("[api] Groq retranscribe error:", err);
      return res.status(502).json({
        error: "Retranscription failed",
        detail: err?.message || String(err),
      });
    }

    let summary;
    try {
      summary = await summarizeTranscript(transcript);
    } catch (err) {
      console.error("[api] Groq resummarize error:", err);
      return res.status(502).json({
        error: "Transcription succeeded but summarization failed",
        detail: err?.message || String(err),
        transcript,
      });
    }

    const updated = await updateMeeting(meetingId, {
      audioUrl,
      transcript,
      overview: summary.overview,
      keyPoints: summary.keyPoints,
      actionItems: summary.actionItems,
    });

    return res.json({
      transcript,
      overview: summary.overview,
      keyPoints: summary.keyPoints,
      actionItems: summary.actionItems,
      meeting: updated,
    });
  })
);

// ---------------------------------------------------------------------------
// Meetings CRUD (Supabase is the source of truth)
// ---------------------------------------------------------------------------

// POST /api/meetings — create a meeting record after a Cloudinary upload.
router.post(
  "/meetings",
  asyncHandler("Create meeting", async (req, res) => {
    const {
      id,
      title,
      audioUrl,
      audioPublicId,
      durationSeconds,
    } = req.body || {};

    if (!isNonEmptyString(audioUrl)) {
      return badRequest(res, "audioUrl is required to create a meeting.");
    }

    const meeting = await createMeeting({
      id,
      title: isNonEmptyString(title) ? title.trim() : undefined,
      audioUrl,
      audioPublicId: audioPublicId || null,
      durationSeconds:
        typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
          ? Math.round(durationSeconds)
          : null,
    });

    return res.status(201).json({ meeting });
  })
);

// GET /api/meetings — list all meetings, newest first.
router.get(
  "/meetings",
  asyncHandler("List meetings", async (_req, res) => {
    const meetings = await listMeetings();
    return res.json({ meetings });
  })
);

// GET /api/meetings/:id — fetch one meeting.
router.get(
  "/meetings/:id",
  asyncHandler("Get meeting", async (req, res) => {
    const meeting = await getMeetingById(req.params.id);
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    return res.json({ meeting });
  })
);

// PATCH /api/meetings/:id — update title / transcript / summary fields.
router.patch(
  "/meetings/:id",
  asyncHandler("Update meeting", async (req, res) => {
    const allowed = [
      "title",
      "audioUrl",
      "audioPublicId",
      "transcript",
      "overview",
      "keyPoints",
      "actionItems",
      "durationSeconds",
    ];
    const fields = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        fields[key] = req.body[key];
      }
    }

    if (!Object.keys(fields).length) {
      return badRequest(res, "No updatable fields supplied.");
    }

    const meeting = await updateMeeting(req.params.id, fields);
    if (!meeting) return res.status(404).json({ error: "Meeting not found." });
    return res.json({ meeting });
  })
);

// DELETE /api/meetings/:id
router.delete(
  "/meetings/:id",
  asyncHandler("Delete meeting", async (req, res) => {
    const ok = await deleteMeeting(req.params.id);
    if (!ok) return res.status(404).json({ error: "Meeting not found." });
    return res.json({ ok: true });
  })
);

// GET /api/health — lightweight readiness probe.
router.get(
  "/health",
  asyncHandler("Health", async (_req, res) => {
    const checks = {
      groqKey: !!process.env.GROQ_API_KEY,
      databaseUrl: !!process.env.DATABASE_URL,
    };
    const ok = checks.groqKey && checks.databaseUrl;
    return res.status(ok ? 200 : 503).json({ ok, checks });
  })
);

export default router;
export { MAX_BODY_BYTES };
