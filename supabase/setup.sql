create table if not exists public.family_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ledger jsonb not null default '[]'::jsonb,
  coefficients jsonb not null default '{"Running":170,"Cycling":230,"Gym":250}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.family_state enable row level security;

drop policy if exists "Users can read own family state" on public.family_state;
create policy "Users can read own family state"
on public.family_state
for select
using (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "Users can insert own family state" on public.family_state;
create policy "Users can insert own family state"
on public.family_state
for insert
with check (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "Users can update own family state" on public.family_state;
create policy "Users can update own family state"
on public.family_state
for update
using (auth.uid() is not null and auth.uid() = user_id)
with check (auth.uid() is not null and auth.uid() = user_id);
