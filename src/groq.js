// src/groq.js — Groq API client (Whisper + chat) used only server-side.
// The GROQ_API_KEY env var never leaves the server.

const GROQ_API_BASE = "https://api.groq.com/openai/v1";
const GROQ_CHAT_URL = `${GROQ_API_BASE}/chat/completions`;
const GROQ_AUDIO_URL = `${GROQ_API_BASE}/audio/transcriptions`;
const GROQ_CHAT_MODEL = "openai/gpt-oss-120b";
const GROQ_AUDIO_MODEL = "whisper-large-v3";

function getKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not configured on the server.");
  return key;
}

/**
 * Transcribe audio that is already hosted at a public URL (e.g. Cloudinary).
 * Groq accepts a `url` field instead of uploading bytes, so we never proxy the
 * binary through this function.
 *
 * @param {string} audioUrl publicly reachable URL to the audio file
 * @returns {Promise<string>} transcript text
 */
export async function transcribeFromUrl(audioUrl) {
  if (!audioUrl || typeof audioUrl !== "string") {
    throw new Error("audioUrl is required for transcription.");
  }

  const form = new FormData();
  form.append("model", GROQ_AUDIO_MODEL);
  form.append("url", audioUrl);
  form.append("language", "en");
  form.append("response_format", "text");

  const res = await fetch(GROQ_AUDIO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      // No Content-Type — fetch sets the correct multipart boundary for FormData.
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Groq transcription failed (${res.status}): ${detail}`);
  }

  const text = (await res.text()).trim();
  if (!text) throw new Error("Groq returned an empty transcript.");
  return text;
}


/**
 * Low-level chat helper. Throws on failure so callers can surface real errors.
 */
async function chat(messages, maxTokens = 1024, temperature = 0.3) {
  const res = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Groq chat failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty chat response.");
  return content.trim();
}

// ---------------------------------------------------------------------------
// Summarization — STRICT separation of overview / key points / action items.
// Key points must be statements, topics and decisions. Raw questions that were
// asked during the meeting must NOT appear as key points; they may only appear
// under the optional "Open questions" section when genuinely unresolved.
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM_PROMPT = `You are a precise meeting-notes assistant.

Produce meeting notes from the transcript with STRICT separation into these sections, using exactly these Markdown headings:

## Overview
A 2-3 sentence neutral summary of what the meeting was about.

## Key Discussion Points
Bullet points listing the substantive content of the discussion: statements made, topics covered, decisions reached, and conclusions. Each bullet MUST be a statement, topic, or decision — NOT a question.

CRITICAL RULE: Do NOT include raw questions that participants asked during the meeting as key points. Questions are not key points. If someone asked "Should we launch on Friday?" and the group decided "yes", the key point is the decision ("Team decided to launch on Friday"), not the question.

## Action Items
Bullet points listing concrete follow-up tasks. Include the owner when the transcript names one, in the form "Owner — task". If there are no action items, write "None identified."

## Open Questions (optional)
Only include this section if there are genuinely unresolved questions that the meeting did not answer. Bullet points. Omit the section entirely if there are none.

Rules:
- Be concise and factual. Do not invent information that is not in the transcript.
- Do not include filler, greetings, or chit-chat.
- Always output all required headings (Overview, Key Discussion Points, Action Items).
- Output Markdown only. No preamble, no closing remarks.`;

const MAX_TRANSCRIPT_CHARS = 48_000;

function truncateTranscript(transcript) {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  // Keep the beginning and the end — decisions are often at both.
  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
  return (
    transcript.slice(0, half) +
    "\n\n[... transcript truncated for length ...]\n\n" +
    transcript.slice(-half)
  );
}

/**
 * Summarize a transcript. Returns the full Markdown notes plus parsed fields.
 * @param {string} transcript
 * @returns {Promise<{notes: string, overview: string, keyPoints: string, actionItems: string}>}
 */
export async function summarizeTranscript(transcript) {
  if (!transcript || !transcript.trim()) {
    throw new Error("transcript is required for summarization.");
  }

  const notes = await chat(
    [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `Transcript:\n\n${truncateTranscript(transcript)}` },
    ],
    1600,
    0.2
  );

  return {
    notes,
    overview: extractSection(notes, "Overview"),
    keyPoints: extractSection(notes, "Key Discussion Points"),
    actionItems: extractSection(notes, "Action Items"),
  };
}

/**
 * Answer a question grounded strictly in the transcript.
 * @param {string} question
 * @param {string} transcript
 * @returns {Promise<string>}
 */
export async function answerQuestion(question, transcript) {
  if (!question || !question.trim()) {
    throw new Error("question is required.");
  }
  if (!transcript || !transcript.trim()) {
    throw new Error("transcript is required to answer a question.");
  }

  return chat(
    [
      {
        role: "system",
        content:
          "Answer questions about the meeting transcript below. Only use information found in the transcript. " +
          "If the answer is not in the transcript, say so plainly. Be concise.\n\nTranscript:\n\n" +
          truncateTranscript(transcript),
      },
      { role: "user", content: question },
    ],
    512,
    0.3
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the body of a `## <heading>` section out of Markdown notes. */
function extractSection(markdown, heading) {
  const lines = markdown.split("\n");
  const target = heading.toLowerCase();
  let capturing = false;
  const out = [];

  for (const line of lines) {
    const headingMatch = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (headingMatch) {
      const name = headingMatch[1].trim().toLowerCase();
      if (capturing) break; // next heading ends the section
      if (name === target || name.startsWith(target)) {
        capturing = true;
        continue;
      }
    }
    if (capturing) out.push(line);
  }

  return out.join("\n").trim();
}

async function safeText(res) {
  try {
    const t = await res.text();
    return t.slice(0, 500) || res.statusText;
  } catch {
    return res.statusText;
  }
}
