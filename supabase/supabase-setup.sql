-- Work Log - Supabase Setup
-- Run this in Supabase SQL Editor

-- 1. Create table to store all user data (hybrid offline-first)
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  attendance jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{"dailyRate":16000,"weekendMultiplier":2}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Enable RLS
alter table public.user_data enable row level security;

-- 3. Policies: users can only read/write their own row
drop policy if exists "Users can view own data" on public.user_data;
create policy "Users can view own data"
  on public.user_data for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own data" on public.user_data;
create policy "Users can insert own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own data" on public.user_data;
create policy "Users can update own data"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own data" on public.user_data;
create policy "Users can delete own data"
  on public.user_data for delete
  using (auth.uid() = user_id);

-- 4. Optional: function to auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_updated_at on public.user_data;
create trigger set_updated_at
  before update on public.user_data
  for each row execute function public.handle_updated_at();

-- Done. Now create a user via Supabase Auth (email/password) and the app will auto-create rows.
