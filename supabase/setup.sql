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

alter table public.profiles add column if not exists webhook_secret text;
alter table public.profiles add column if not exists s10_profile_url text;
alter table public.profiles add column if not exists s10_user_id text;
alter table public.profiles add column if not exists sync_enabled boolean not null default true;
alter table public.profiles add column if not exists last_webhook_at timestamptz;

create unique index if not exists profiles_webhook_secret_key
on public.profiles (webhook_secret)
where webhook_secret is not null;

create unique index if not exists profiles_s10_user_id_key
on public.profiles (s10_user_id)
where s10_user_id is not null;

create table if not exists public.activity_imports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid not null,
  source_id text not null,
  source_url text,
  activity text not null,
  bpm integer not null check (bpm > 0),
  duration_minutes integer not null check (duration_minutes > 0),
  earned_minutes integer not null check (earned_minutes >= 0),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, source_id)
);

alter table public.family_state enable row level security;
alter table public.profiles enable row level security;
alter table public.activity_imports enable row level security;

revoke insert, update, delete on table public.family_state from anon, authenticated;
revoke insert, update, delete on table public.profiles from anon, authenticated;
revoke insert, update, delete on table public.activity_imports from anon, authenticated;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles
for select
using (auth.uid() is not null and auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

drop policy if exists "Users can read own family imports" on public.activity_imports;
create policy "Users can read own family imports"
on public.activity_imports
for select
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.family_id = activity_imports.family_id
  )
);

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
drop policy if exists "Users can update own family state" on public.family_state;

create or replace function public.import_activity_webhook(
  p_user_id uuid,
  p_source_id text,
  p_source_url text,
  p_activity text,
  p_bpm integer,
  p_duration_minutes integer,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.family_state%rowtype;
  v_family_id uuid;
  v_coefficients jsonb;
  v_ledger jsonb;
  v_coefficient integer;
  v_earned_minutes integer;
  v_created_at timestamptz := now();
  v_entry jsonb;
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;

  if p_source_id is null or btrim(p_source_id) = '' then
    raise exception 'source_id is required';
  end if;

  if p_bpm is null or p_bpm <= 0 then
    raise exception 'bpm must be positive';
  end if;

  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'duration_minutes must be positive';
  end if;

  if exists (
    select 1
    from public.activity_imports
    where user_id = p_user_id
      and source_id = p_source_id
  ) then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'userId', p_user_id,
      'sourceId', p_source_id
    );
  end if;

  select *
  into v_state
  from public.family_state
  where user_id = p_user_id
  for update;

  v_family_id := coalesce(v_state.family_id, p_user_id);
  v_ledger := coalesce(v_state.ledger, '[]'::jsonb);
  v_coefficients := jsonb_build_object(
    'Running', 170,
    'Cycling', 230,
    'Gym', 250
  ) || coalesce(v_state.coefficients, '{}'::jsonb);

  v_coefficient := greatest(
    coalesce((v_coefficients ->> p_activity)::integer, 170),
    1
  );
  v_earned_minutes := greatest(round((p_bpm::numeric * p_duration_minutes::numeric) / v_coefficient), 0);

  v_entry := jsonb_build_object(
    'type', 'plus',
    'title', p_activity || ' imported',
    'minutes', v_earned_minutes,
    'meta', 'Minutes added automatically from webhook',
    'timestamp', 'Добавлено автоматически',
    'createdAt', v_created_at,
    'sourceId', p_source_id,
    'sourceUrl', nullif(p_source_url, ''),
    'bpm', p_bpm,
    'durationMinutes', p_duration_minutes
  );

  insert into public.activity_imports (
    user_id,
    family_id,
    source_id,
    source_url,
    activity,
    bpm,
    duration_minutes,
    earned_minutes,
    payload
  )
  values (
    p_user_id,
    v_family_id,
    p_source_id,
    nullif(p_source_url, ''),
    p_activity,
    p_bpm,
    p_duration_minutes,
    v_earned_minutes,
    coalesce(p_payload, '{}'::jsonb)
  );

  insert into public.family_state (
    user_id,
    family_id,
    ledger,
    coefficients,
    updated_at
  )
  values (
    p_user_id,
    v_family_id,
    v_ledger || jsonb_build_array(v_entry),
    v_coefficients,
    now()
  )
  on conflict (user_id) do update
  set family_id = excluded.family_id,
      ledger = excluded.ledger,
      coefficients = excluded.coefficients,
      updated_at = now();

  update public.profiles
  set last_webhook_at = now(),
      updated_at = now()
  where id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'userId', p_user_id,
    'sourceId', p_source_id,
    'activity', p_activity,
    'bpm', p_bpm,
    'durationMinutes', p_duration_minutes,
    'coefficient', v_coefficient,
    'earnedMinutes', v_earned_minutes,
    'balanceEntries', jsonb_array_length(v_ledger) + 1
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'userId', p_user_id,
      'sourceId', p_source_id
    );
end;
$$;

revoke all on function public.import_activity_webhook(uuid, text, text, text, integer, integer, jsonb) from public;
revoke all on function public.import_activity_webhook(uuid, text, text, text, integer, integer, jsonb) from anon;
revoke all on function public.import_activity_webhook(uuid, text, text, text, integer, integer, jsonb) from authenticated;
grant execute on function public.import_activity_webhook(uuid, text, text, text, integer, integer, jsonb) to service_role;

create or replace function public.sync_profile_client(
  p_webhook_secret text,
  p_s10_profile_url text,
  p_s10_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.profiles%rowtype;
begin
  if v_user_id is null then
    raise exception 'auth required';
  end if;

  select *
  into v_existing
  from public.profiles
  where id = v_user_id;

  insert into public.profiles (
    id,
    family_id,
    webhook_secret,
    s10_profile_url,
    s10_user_id,
    sync_enabled,
    updated_at
  )
  values (
    v_user_id,
    coalesce(v_existing.family_id, v_user_id),
    nullif(trim(p_webhook_secret), ''),
    nullif(trim(p_s10_profile_url), ''),
    coalesce(v_existing.s10_user_id, nullif(trim(p_s10_user_id), '')),
    coalesce(v_existing.sync_enabled, true),
    now()
  )
  on conflict (id) do update
  set webhook_secret = coalesce(excluded.webhook_secret, public.profiles.webhook_secret),
      s10_profile_url = coalesce(excluded.s10_profile_url, public.profiles.s10_profile_url),
      s10_user_id = coalesce(public.profiles.s10_user_id, excluded.s10_user_id),
      updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'userId', v_user_id
  );
end;
$$;

revoke all on function public.sync_profile_client(text, text, text) from public;
grant execute on function public.sync_profile_client(text, text, text) to authenticated;

create or replace function public.spend_family_minutes(
  p_user_id uuid,
  p_minutes integer,
  p_note text default 'Gameplay used'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_state public.family_state%rowtype;
  v_ledger jsonb;
  v_entry jsonb;
  v_created_at timestamptz := now();
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;

  if auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;

  if p_minutes is null or p_minutes <= 0 then
    raise exception 'minutes must be positive';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = p_user_id;

  if v_profile.id is null then
    raise exception 'profile not found';
  end if;

  select *
  into v_state
  from public.family_state
  where family_id = v_profile.family_id
  for update;

  v_ledger := coalesce(v_state.ledger, '[]'::jsonb);
  v_entry := jsonb_build_object(
    'type', 'minus',
    'title', coalesce(nullif(trim(p_note), ''), 'Gameplay used'),
    'minutes', p_minutes,
    'meta', 'Minutes removed from balance',
    'timestamp', 'Списано автоматически',
    'createdAt', v_created_at
  );

  if v_state.user_id is null then
    insert into public.family_state (
      user_id,
      family_id,
      ledger,
      coefficients,
      updated_at
    )
    values (
      p_user_id,
      v_profile.family_id,
      jsonb_build_array(v_entry),
      '{"Running":170,"Cycling":230,"Gym":250}'::jsonb,
      now()
    );
  else
    update public.family_state
    set ledger = v_ledger || jsonb_build_array(v_entry),
        updated_at = now()
    where user_id = v_state.user_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'minutes', p_minutes
  );
end;
$$;

revoke all on function public.spend_family_minutes(uuid, integer, text) from public;
grant execute on function public.spend_family_minutes(uuid, integer, text) to authenticated;

create or replace function public.clear_family_log(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;

  if auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = p_user_id;

  if v_profile.id is null then
    raise exception 'profile not found';
  end if;

  update public.family_state
  set ledger = '[]'::jsonb,
      updated_at = now()
  where family_id = v_profile.family_id;

  return jsonb_build_object(
    'ok', true
  );
end;
$$;

revoke all on function public.clear_family_log(uuid) from public;
grant execute on function public.clear_family_log(uuid) to authenticated;
