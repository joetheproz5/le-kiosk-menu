create table if not exists public.app_backups (
  backup_key text primary key,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists app_backups_created_at_idx
  on public.app_backups (created_at desc);

comment on table public.app_backups is
  'Daily operational snapshots created by the Le Kiosk Cloudflare Worker.';
