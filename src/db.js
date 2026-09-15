// src/db.js — Supabase Postgres access layer (via `pg`).
// The DATABASE_URL env var must point at your Supabase connection string.
// Supabase requires SSL; we enable it when the URL is remote.

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  // Do not throw at import time — Vercel collects logs on first request.
  console.error("[db] DATABASE_URL is not set. All DB operations will fail.");
}

const needsSsl = !!DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("[db] unexpected pool error:", err);
});

/**
 * Run a query. Throws a descriptive error if the DB is misconfigured.
 * @param {string} text SQL text with $1, $2 placeholders
 * @param {any[]} params
 */
export async function query(text, params = []) {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured on the server.");
  }
  return pool.query(text, params);
}

const MEETING_COLUMNS =
  "id, title, created_at, audio_url, audio_public_id, transcript, overview, key_points, action_items, duration_seconds";

/** Map a DB row into the shape the extension expects. */
export function rowToMeeting(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    audioUrl: row.audio_url,
    audioPublicId: row.audio_public_id,
    transcript: row.transcript,
    overview: row.overview,
    keyPoints: row.key_points,
    actionItems: row.action_items,
    durationSeconds: row.duration_seconds,
  };
}

export async function listMeetings() {
  const { rows } = await query(
    `select ${MEETING_COLUMNS} from meetings order by created_at desc`
  );
  return rows.map(rowToMeeting);
}

export async function getMeetingById(id) {
  const { rows } = await query(
    `select ${MEETING_COLUMNS} from meetings where id = $1`,
    [id]
  );
  return rowToMeeting(rows[0]);
}

export async function createMeeting({
  id,
  title,
  audioUrl = null,
  audioPublicId = null,
  durationSeconds = null,
}) {
  const { rows } = await query(
    `insert into meetings (id, title, audio_url, audio_public_id, duration_seconds)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
     returning ${MEETING_COLUMNS}`,
    [id || null, title || "Untitled meeting", audioUrl, audioPublicId, durationSeconds]
  );
  return rowToMeeting(rows[0]);
}

export async function updateMeeting(id, fields) {
  const map = {
    title: "title",
    audioUrl: "audio_url",
    audioPublicId: "audio_public_id",
    transcript: "transcript",
    overview: "overview",
    keyPoints: "key_points",
    actionItems: "action_items",
    durationSeconds: "duration_seconds",
  };

  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${col} = $${i++}`);
      values.push(fields[key]);
    }
  }

  if (!sets.length) {
    return getMeetingById(id);
  }

  values.push(id);
  const { rows } = await query(
    `update meetings set ${sets.join(", ")} where id = $${i} returning ${MEETING_COLUMNS}`,
    values
  );
  return rowToMeeting(rows[0]);
}

export async function deleteMeeting(id) {
  const { rowCount } = await query(`delete from meetings where id = $1`, [id]);
  return rowCount > 0;
}
