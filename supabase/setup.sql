create table if not exists public.family_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  family_id uuid,
  ledger jsonb not null default '[]'::jsonb,
  coefficients jsonb not null default '{"Running":170,"Cycling":230,"Gym":250}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.family_state add column if not exists family_id uuid;
update public.family_state
set family_id = coalesce(family_id, user_id)
where family_id is null;

create unique index if not exists family_state_family_id_key
on public.family_state (family_id);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  family_id uuid not null,
  family_code text unique,
  role text not null default 'parent' check (role in ('parent', 'kid')),
  display_name text,
  updated_at timestamptz not null default now()
);

alter table public.family_state enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles
for select
using (auth.uid() is not null and auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
on public.profiles
for insert
with check (auth.uid() is not null and auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles
for update
using (auth.uid() is not null and auth.uid() = id)
with check (auth.uid() is not null and auth.uid() = id);

create or replace function public.find_family_by_code(input_code text)
returns table (family_id uuid)
language sql
security definer
set search_path = public
as $$
  select profiles.family_id
  from public.profiles
  where upper(profiles.family_code) = upper(trim(input_code))
  limit 1;
$$;

revoke all on function public.find_family_by_code(text) from public;
grant execute on function public.find_family_by_code(text) to authenticated;

drop policy if exists "Users can read own family state" on public.family_state;
create policy "Users can read own family state"
on public.family_state
for select
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.family_id = family_state.family_id
  )
);

drop policy if exists "Users can insert own family state" on public.family_state;
create policy "Users can insert own family state"
on public.family_state
for insert
with check (
  auth.uid() is not null
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.family_id = family_state.family_id
  )
);

drop policy if exists "Users can update own family state" on public.family_state;
create policy "Users can update own family state"
on public.family_state
for update
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.family_id = family_state.family_id
  )
)
with check (
  auth.uid() is not null
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.family_id = family_state.family_id
  )
);
