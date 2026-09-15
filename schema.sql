-- Meet Notetaker — Supabase Postgres schema
-- Run once against your Supabase database (SQL editor or psql).

create extension if not exists "pgcrypto";

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Untitled meeting',
  created_at timestamptz not null default now(),
  audio_url text,
  audio_public_id text,
  transcript text,
  overview text,
  key_points text,
  action_items text,
  duration_seconds int
);

create index if not exists meetings_created_at_idx on meetings (created_at desc);
