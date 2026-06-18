-- [MVP-0b] RLS helpers, private config, digest helpers, bootstrap challenges,
-- rate-limit state, and Guard-only public-mode boundary.
-- Create/join/snapshot business flows remain fail-closed until MVP-0c.

create table private.sharing_runtime_config (
  singleton boolean primary key default true check (singleton),
  public_mode text not null default 'local'
    check (public_mode in ('local', 'limited_test', 'public')),
  guard_required boolean not null default false,
  payload_protection_mode text not null default 'encrypted'
    check (payload_protection_mode in ('encrypted', 'plaintext_local_fixture')),
  contract_version integer not null default 1 check (contract_version = 1),
  challenge_ttl_seconds integer not null default 300
    check (challenge_ttl_seconds between 30 and 900),
  bootstrap_attempt_window_seconds integer not null default 300
    check (bootstrap_attempt_window_seconds between 60 and 3600),
  bootstrap_attempt_limit integer not null default 10
    check (bootstrap_attempt_limit between 1 and 100),
  max_unconsumed_create_payloads_per_auth integer not null default 10
    check (max_unconsumed_create_payloads_per_auth between 1 and 100),
  max_unconsumed_create_payloads_per_room integer not null default 3
    check (max_unconsumed_create_payloads_per_room between 1 and 20),
  max_unconsumed_create_payloads_total integer not null default 1000
    check (max_unconsumed_create_payloads_total between 1 and 100000),
  max_unconsumed_create_payload_bytes_per_auth bigint not null default 52428800
    check (max_unconsumed_create_payload_bytes_per_auth > 0),
  max_unconsumed_create_payload_bytes_total bigint not null default 536870912
    check (max_unconsumed_create_payload_bytes_total > 0),
  max_room_members integer not null default 20 check (max_room_members = 20),
  max_room_items integer not null default 5000 check (max_room_items = 5000),
  max_canonical_create_payload_bytes integer not null default 10485760
    check (max_canonical_create_payload_bytes = 10485760),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into private.sharing_runtime_config(singleton)
values (true);

create trigger sharing_runtime_config_set_updated_at
before update on private.sharing_runtime_config
for each row execute function private.set_updated_at();

create table private.sharing_secret_versions (
  secret_kind text not null
    check (secret_kind in (
      'payload_encryption',
      'payload_fixture_encryption',
      'room_code',
      'room_code_encryption',
      'member_restore_lookup',
      'member_restore_verify'
    )),
  secret_version integer not null check (secret_version > 0),
  secret_value text not null check (length(secret_value) >= 32),
  is_current boolean not null default false,
  is_accepted boolean not null default true,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  primary key (secret_kind, secret_version),
  check (is_current = false or is_accepted = true)
);

create unique index sharing_secret_versions_one_current_per_kind
  on private.sharing_secret_versions(secret_kind)
  where is_current;

create table private.room_code_digest_aliases (
  room_id uuid not null references public.rooms(id) on delete cascade,
  secret_version integer not null,
  room_code_digest bytea not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (room_id, secret_version)
);

create unique index room_code_digest_aliases_active_digest_unique
  on private.room_code_digest_aliases(secret_version, room_code_digest)
  where is_active;

create table private.room_code_sealed_codes (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  encryption_key_version integer not null,
  encrypted_normalized_room_code bytea not null,
  encryption_algorithm text not null default 'openpgp-aes256'
    check (encryption_algorithm = 'openpgp-aes256'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger room_code_sealed_codes_set_updated_at
before update on private.room_code_sealed_codes
for each row execute function private.set_updated_at();

create table private.room_member_credentials (
  room_member_id uuid primary key references public.room_members(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  secret_version integer not null,
  member_key_lookup_digest bytea not null,
  member_key_digest bytea not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (room_id, member_key_lookup_digest)
);

create table private.room_create_payload_challenges (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  auth_user_id uuid not null,
  client_room_id uuid not null,
  encrypted_payload bytea not null,
  encryption_algorithm text not null default 'openpgp-aes256'
    check (encryption_algorithm = 'openpgp-aes256'),
  encryption_key_version integer not null,
  plaintext_fingerprint text not null,
  plaintext_size_bytes integer not null check (plaintext_size_bytes >= 0),
  item_count integer not null check (item_count between 0 and 5000),
  canonical_schema_version integer not null check (canonical_schema_version = 1),
  payload_protection_mode text not null
    check (payload_protection_mode in ('encrypted', 'plaintext_local_fixture')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index room_create_payload_challenges_auth_created_idx
  on private.room_create_payload_challenges(auth_user_id, created_at desc);

create table private.room_join_challenges (
  challenge_id uuid primary key default pg_catalog.gen_random_uuid(),
  purpose text not null check (purpose in ('create_room', 'join', 'restore')),
  room_id uuid,
  auth_user_id uuid not null,
  room_code_secret_version integer,
  room_code_digest bytea,
  create_payload_challenge_id uuid
    references private.room_create_payload_challenges(id) on delete cascade,
  create_payload_fingerprint text,
  canonical_schema_version integer,
  canonical_payload_ref uuid,
  payload_size_bytes integer,
  item_count integer,
  token_context text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (
    (purpose = 'create_room' and create_payload_challenge_id is not null)
    or (purpose in ('join', 'restore') and create_payload_challenge_id is null)
  )
);

create index room_join_challenges_auth_purpose_created_idx
  on private.room_join_challenges(auth_user_id, purpose, created_at desc);

create table private.bootstrap_attempts (
  id bigint generated always as identity primary key,
  auth_user_id uuid,
  purpose text not null check (purpose in ('create_room', 'join', 'restore')),
  result_code text not null,
  created_at timestamptz not null default now()
);

create index bootstrap_attempts_auth_purpose_created_idx
  on private.bootstrap_attempts(auth_user_id, purpose, created_at desc);

create or replace function private.base64url(p_bytes bytea)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select rtrim(translate(encode(p_bytes, 'base64'), '+/', '-_'), '=');
$$;

create or replace function private.sharing_success(p_data jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'data', coalesce(p_data, '{}'::jsonb),
    'contract_version', 1
  );
$$;

create or replace function private.sharing_error(
  p_code text,
  p_retry_after_seconds integer default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_strip_nulls(jsonb_build_object(
      'code', p_code,
      'retry_after_seconds', p_retry_after_seconds,
      'contract_version', 1
    ))
  );
$$;

create or replace function private.get_sharing_runtime_config()
returns private.sharing_runtime_config
language sql
stable
security definer
set search_path = ''
as $$
  select *
  from private.sharing_runtime_config
  where singleton = true;
$$;

create or replace function private.direct_bootstrap_disallowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public_mode = 'public' or guard_required
    from private.sharing_runtime_config
    where singleton = true
  ), true);
$$;

create or replace function private.current_room_member_id(p_room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select rm.id
  from public.room_members rm
  where rm.room_id = p_room_id
    and rm.user_id = auth.uid()
    and rm.membership_status = 'active'
  order by rm.joined_at desc
  limit 1;
$$;

create or replace function private.is_active_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_room_member_id(p_room_id) is not null;
$$;

create or replace function private.is_host_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
      and rm.role = 'host'
      and rm.membership_status = 'active'
  );
$$;

create or replace function private.get_secret_value(
  p_secret_kind text,
  p_secret_version integer
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select secret_value
  from private.sharing_secret_versions
  where secret_kind = p_secret_kind
    and secret_version = p_secret_version
    and is_accepted
    and retired_at is null;
$$;

create or replace function private.get_current_secret_version(p_secret_kind text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select secret_version
  from private.sharing_secret_versions
  where secret_kind = p_secret_kind
    and is_current
    and is_accepted
    and retired_at is null;
$$;

create or replace function private.normalize_room_code(p_room_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_room_code, ''), '\s+', '', 'g'));
$$;

create or replace function private.room_code_digest(
  p_normalized_room_code text,
  p_secret_version integer
)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select extensions.hmac(
    convert_to('room-code:v1:' || p_normalized_room_code, 'UTF8'),
    convert_to(private.get_secret_value('room_code', p_secret_version), 'UTF8'),
    'sha256'
  );
$$;

create or replace function private.member_key_lookup_digest(
  p_room_id uuid,
  p_member_restore_token text,
  p_secret_version integer
)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select extensions.hmac(
    convert_to('lookup:v1:' || p_room_id::text || ':' || p_member_restore_token, 'UTF8'),
    convert_to(private.get_secret_value('member_restore_lookup', p_secret_version), 'UTF8'),
    'sha256'
  );
$$;

create or replace function private.member_key_digest(
  p_room_id uuid,
  p_member_restore_token text,
  p_secret_version integer
)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select extensions.hmac(
    convert_to('verify:v1:' || p_room_id::text || ':' || p_member_restore_token, 'UTF8'),
    convert_to(private.get_secret_value('member_restore_verify', p_secret_version), 'UTF8'),
    'sha256'
  );
$$;

create or replace function private.accepted_room_code_digest_candidates(p_room_code text)
returns table(secret_version integer, room_code_digest bytea)
language sql
stable
security definer
set search_path = ''
as $$
  select s.secret_version,
         private.room_code_digest(private.normalize_room_code(p_room_code), s.secret_version)
  from private.sharing_secret_versions s
  where s.secret_kind = 'room_code'
    and s.is_accepted
    and s.retired_at is null;
$$;

create or replace function private.seal_normalized_room_code(
  p_room_id uuid,
  p_normalized_room_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  key_version integer;
  key_value text;
begin
  key_version := private.get_current_secret_version('room_code_encryption');
  key_value := private.get_secret_value('room_code_encryption', key_version);
  if key_version is null or key_value is null then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  insert into private.room_code_sealed_codes(
    room_id,
    encryption_key_version,
    encrypted_normalized_room_code
  )
  values (
    p_room_id,
    key_version,
    extensions.pgp_sym_encrypt_bytea(
      convert_to(p_normalized_room_code, 'UTF8'),
      key_value,
      'cipher-algo=aes256, compress-algo=0'
    )
  )
  on conflict (room_id) do update
    set encryption_key_version = excluded.encryption_key_version,
        encrypted_normalized_room_code = excluded.encrypted_normalized_room_code;

  return private.sharing_success();
end;
$$;

create or replace function private.open_normalized_room_code(p_room_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sealed_row private.room_code_sealed_codes;
  key_value text;
begin
  select * into sealed_row
  from private.room_code_sealed_codes
  where room_id = p_room_id;

  if not found then
    return null;
  end if;

  key_value := private.get_secret_value(
    'room_code_encryption',
    sealed_row.encryption_key_version
  );
  if key_value is null then
    return null;
  end if;

  return convert_from(
    extensions.pgp_sym_decrypt_bytea(
      sealed_row.encrypted_normalized_room_code,
      key_value
    ),
    'UTF8'
  );
exception
  when others then
    return null;
end;
$$;

create or replace function private.backfill_room_code_aliases(p_secret_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  room_record record;
  normalized_code text;
  inserted_count integer := 0;
begin
  if not exists (
    select 1
    from private.sharing_secret_versions
    where secret_kind = 'room_code'
      and secret_version = p_secret_version
      and is_accepted
      and retired_at is null
  ) then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  for room_record in
    select r.id
    from public.rooms r
    where r.sharing_status = 'active'
      and r.expires_at > now()
    order by r.id
  loop
    normalized_code := private.open_normalized_room_code(room_record.id);
    if normalized_code is null then
      return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
    end if;

    insert into private.room_code_digest_aliases(
      room_id,
      secret_version,
      room_code_digest,
      is_active
    )
    values (
      room_record.id,
      p_secret_version,
      private.room_code_digest(normalized_code, p_secret_version),
      true
    )
    on conflict (room_id, secret_version) do update
      set room_code_digest = excluded.room_code_digest,
          is_active = true;
    inserted_count := inserted_count + 1;
  end loop;

  return private.sharing_success(jsonb_build_object('backfilledRooms', inserted_count));
exception
  when unique_violation then
    return private.sharing_error('ROOM_UNAVAILABLE');
end;
$$;

create or replace function private.jsonb_max_string_length(p_value jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  with recursive walk(value) as (
    select p_value
    union all
    select child.value
    from walk
    cross join lateral (
      select value from jsonb_array_elements(walk.value)
      where jsonb_typeof(walk.value) = 'array'
      union all
      select value from jsonb_each(walk.value)
      where jsonb_typeof(walk.value) = 'object'
    ) child
  )
  select coalesce(max(length(trim(both '"' from value::text))), 0)
  from walk
  where jsonb_typeof(value) = 'string';
$$;

create or replace function private.validate_create_payload_metadata(
  p_client_room_id uuid,
  p_canonical_payload text,
  p_item_count integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  payload jsonb;
  snapshot_count integer;
begin
  begin
    payload := p_canonical_payload::jsonb;
  exception
    when others then
      return private.sharing_error('INVALID_REQUEST');
  end;

  if jsonb_typeof(payload) <> 'object'
     or payload ->> 'schemaVersion' <> '1'
     or jsonb_typeof(payload -> 'itemSnapshots') <> 'object' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select count(*) into snapshot_count
  from jsonb_object_keys(payload -> 'itemSnapshots');

  if snapshot_count <> p_item_count then
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  if payload ? 'roomId'
     and payload ->> 'roomId' <> p_client_room_id::text then
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  if private.jsonb_max_string_length(payload) > 8192 then
    return private.sharing_error('CREATE_PAYLOAD_TOO_LARGE');
  end if;

  return private.sharing_success();
end;
$$;

create or replace function private.check_create_payload_quota(
  p_auth_user_id uuid,
  p_client_room_id uuid,
  p_payload_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  auth_count integer;
  room_count integer;
  total_count integer;
  auth_bytes bigint;
  total_bytes bigint;
begin
  select * into cfg from private.get_sharing_runtime_config();
  if not found then
    return private.sharing_error('SHARING_DISABLED');
  end if;

  select count(*), coalesce(sum(plaintext_size_bytes), 0)
    into auth_count, auth_bytes
  from private.room_create_payload_challenges
  where auth_user_id = p_auth_user_id
    and consumed_at is null
    and expires_at > now();

  select count(*) into room_count
  from private.room_create_payload_challenges
  where client_room_id = p_client_room_id
    and consumed_at is null
    and expires_at > now();

  select count(*), coalesce(sum(plaintext_size_bytes), 0)
    into total_count, total_bytes
  from private.room_create_payload_challenges
  where consumed_at is null
    and expires_at > now();

  if auth_count >= cfg.max_unconsumed_create_payloads_per_auth
     or room_count >= cfg.max_unconsumed_create_payloads_per_room
     or total_count >= cfg.max_unconsumed_create_payloads_total
     or auth_bytes + p_payload_size_bytes > cfg.max_unconsumed_create_payload_bytes_per_auth
     or total_bytes + p_payload_size_bytes > cfg.max_unconsumed_create_payload_bytes_total then
    return private.sharing_error('RATE_LIMITED', cfg.bootstrap_attempt_window_seconds);
  end if;

  return private.sharing_success();
end;
$$;

create or replace function private.cleanup_expired_bootstrap_challenges()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_join integer;
  deleted_payload integer;
begin
  delete from private.room_join_challenges
  where expires_at <= now()
     or consumed_at is not null;
  get diagnostics deleted_join = row_count;

  delete from private.room_create_payload_challenges p
  where p.expires_at <= now()
     or p.consumed_at is not null
     or not exists (
       select 1
       from private.room_join_challenges c
       where c.create_payload_challenge_id = p.id
     );
  get diagnostics deleted_payload = row_count;

  return private.sharing_success(jsonb_build_object(
    'deletedChallenges', deleted_join,
    'deletedPayloads', deleted_payload
  ));
end;
$$;

create or replace function private.guard_service_role_claim_ok()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb;
begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return false;
  end;

  return coalesce(claims ->> 'role', '') = 'service_role';
end;
$$;

create or replace function private.check_bootstrap_rate_limit(
  p_auth_user_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  recent_attempts integer;
begin
  select * into cfg from private.get_sharing_runtime_config();
  if not found then
    return private.sharing_error('SHARING_DISABLED');
  end if;

  select count(*) into recent_attempts
  from private.bootstrap_attempts
  where auth_user_id is not distinct from p_auth_user_id
    and purpose = p_purpose
    and created_at >= now() - make_interval(secs => cfg.bootstrap_attempt_window_seconds);

  if recent_attempts >= cfg.bootstrap_attempt_limit then
    return private.sharing_error('RATE_LIMITED', cfg.bootstrap_attempt_window_seconds);
  end if;

  return private.sharing_success();
end;
$$;

create or replace function private.record_bootstrap_attempt(
  p_auth_user_id uuid,
  p_purpose text,
  p_result_code text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.bootstrap_attempts(auth_user_id, purpose, result_code)
  values (p_auth_user_id, p_purpose, p_result_code);
$$;

create or replace function private.check_room_member_limit(
  p_room_id uuid,
  p_existing_member_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_members integer;
begin
  perform 1
  from public.rooms
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at > now()
  for update;

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if p_existing_member_id is not null and exists (
    select 1
    from public.room_members
    where id = p_existing_member_id
      and room_id = p_room_id
      and membership_status = 'active'
  ) then
    return private.sharing_success(jsonb_build_object('existingMember', true));
  end if;

  select count(*) into active_members
  from public.room_members
  where room_id = p_room_id
    and membership_status = 'active';

  if active_members >= 20 then
    return private.sharing_error('ROOM_MEMBER_LIMIT_REACHED');
  end if;

  return private.sharing_success(jsonb_build_object('activeMembers', active_members));
end;
$$;

create or replace function private.store_room_member_credential(
  p_room_member_id uuid,
  p_member_restore_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_room_id uuid;
  secret_version integer;
begin
  if p_member_restore_token is null
     or p_member_restore_token !~ '^[A-Za-z0-9_-]{43}$' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select room_id into member_room_id
  from public.room_members
  where id = p_room_member_id;

  if member_room_id is null then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  secret_version := private.get_current_secret_version('member_restore_lookup');
  if secret_version is null
     or private.get_current_secret_version('member_restore_verify') is distinct from secret_version then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  insert into private.room_member_credentials(
    room_member_id,
    room_id,
    secret_version,
    member_key_lookup_digest,
    member_key_digest
  )
  values (
    p_room_member_id,
    member_room_id,
    secret_version,
    private.member_key_lookup_digest(
      member_room_id,
      p_member_restore_token,
      secret_version
    ),
    private.member_key_digest(
      member_room_id,
      p_member_restore_token,
      secret_version
    )
  )
  on conflict (room_member_id) do update
    set secret_version = excluded.secret_version,
        member_key_lookup_digest = excluded.member_key_lookup_digest,
        member_key_digest = excluded.member_key_digest,
        rotated_at = now();

  return private.sharing_success(jsonb_build_object('roomMemberId', p_room_member_id));
end;
$$;

create or replace function private.validate_bootstrap_challenge(
  p_challenge_id uuid,
  p_expected_purpose text,
  p_auth_user_id uuid,
  p_room_id uuid default null,
  p_payload_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge_row private.room_join_challenges;
  error_code text;
begin
  select * into challenge_row
  from private.room_join_challenges
  where challenge_id = p_challenge_id
  for update;

  if not found then
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  if challenge_row.consumed_at is not null
     or challenge_row.expires_at <= now() then
    error_code := 'CHALLENGE_INVALID';
  elsif challenge_row.purpose <> p_expected_purpose
     or challenge_row.auth_user_id <> p_auth_user_id
     or (p_room_id is not null and challenge_row.room_id <> p_room_id)
     or (
       p_payload_fingerprint is not null
       and challenge_row.create_payload_fingerprint <> p_payload_fingerprint
     ) then
    error_code := 'CHALLENGE_INVALID';
  else
    return private.sharing_success(jsonb_build_object(
      'challengeId', challenge_row.challenge_id,
      'purpose', challenge_row.purpose,
      'roomId', challenge_row.room_id,
      'payloadFingerprint', challenge_row.create_payload_fingerprint
    ));
  end if;

  update private.room_join_challenges
  set attempt_count = attempt_count + 1
  where challenge_id = p_challenge_id;

  perform private.record_bootstrap_attempt(
    challenge_row.auth_user_id,
    challenge_row.purpose,
    error_code
  );

  return private.sharing_error(error_code);
end;
$$;

create or replace function private.create_room_code_aliases(
  p_room_id uuid,
  p_room_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_code text;
  current_version integer;
  current_digest bytea;
begin
  normalized_code := private.normalize_room_code(p_room_code);
  if normalized_code !~ '^[A-Z0-9]{5,32}$' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  current_version := private.get_current_secret_version('room_code');
  if current_version is null then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(normalized_code, 0));
  current_digest := private.room_code_digest(normalized_code, current_version);

  if coalesce((private.seal_normalized_room_code(p_room_id, normalized_code) ->> 'ok')::boolean, false) = false then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  update public.rooms
  set room_code_secret_version = current_version,
      room_code_digest = current_digest
  where id = p_room_id;

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  insert into private.room_code_digest_aliases(
    room_id,
    secret_version,
    room_code_digest,
    is_active
  )
  select p_room_id,
         candidate.secret_version,
         candidate.room_code_digest,
         true
  from private.accepted_room_code_digest_candidates(normalized_code) candidate
  on conflict (room_id, secret_version) do update
    set room_code_digest = excluded.room_code_digest,
        is_active = true;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomCodeSecretVersion', current_version
  ));
exception
  when unique_violation then
    return private.sharing_error('ROOM_UNAVAILABLE');
end;
$$;

create or replace function private.prepare_create_room_challenge_internal(
  p_auth_user_id uuid,
  p_client_room_id uuid,
  p_canonical_payload text,
  p_plaintext_fingerprint text,
  p_item_count integer,
  p_canonical_schema_version integer,
  p_payload_protection_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  rate_result jsonb;
  payload_bytes bytea;
  actual_fingerprint text;
  payload_key_version integer;
  payload_key text;
  payload_row_id uuid;
  v_challenge_id uuid;
  v_expires_at timestamptz;
  validation_result jsonb;
  quota_result jsonb;
begin
  if p_auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  select * into cfg from private.get_sharing_runtime_config();
  if not found then
    return private.sharing_error('SHARING_DISABLED');
  end if;

  rate_result := private.check_bootstrap_rate_limit(p_auth_user_id, 'create_room');
  if coalesce((rate_result ->> 'ok')::boolean, false) = false then
    return rate_result;
  end if;

  if p_payload_protection_mode <> 'encrypted'
     or cfg.payload_protection_mode <> 'encrypted' then
    perform private.record_bootstrap_attempt(
      p_auth_user_id,
      'create_room',
      'PAYLOAD_PROTECTION_REQUIRED'
    );
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  if p_client_room_id is null
     or p_canonical_schema_version <> 1
     or p_item_count is null
     or p_item_count < 0
     or p_item_count > cfg.max_room_items
     or p_plaintext_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
     or p_canonical_payload is null then
    perform private.record_bootstrap_attempt(p_auth_user_id, 'create_room', 'INVALID_REQUEST');
    return private.sharing_error('INVALID_REQUEST');
  end if;

  payload_bytes := convert_to(p_canonical_payload, 'UTF8');
  if length(payload_bytes) > cfg.max_canonical_create_payload_bytes then
    perform private.record_bootstrap_attempt(
      p_auth_user_id,
      'create_room',
      'CREATE_PAYLOAD_TOO_LARGE'
    );
    return private.sharing_error('CREATE_PAYLOAD_TOO_LARGE');
  end if;

  validation_result := private.validate_create_payload_metadata(
    p_client_room_id,
    p_canonical_payload,
    p_item_count
  );
  if coalesce((validation_result ->> 'ok')::boolean, false) = false then
    perform private.record_bootstrap_attempt(
      p_auth_user_id,
      'create_room',
      coalesce(validation_result #>> '{error,code}', 'INVALID_REQUEST')
    );
    return validation_result;
  end if;

  actual_fingerprint := private.base64url(extensions.digest(payload_bytes, 'sha256'));
  if actual_fingerprint <> p_plaintext_fingerprint then
    perform private.record_bootstrap_attempt(p_auth_user_id, 'create_room', 'CHALLENGE_INVALID');
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  quota_result := private.check_create_payload_quota(
    p_auth_user_id,
    p_client_room_id,
    length(payload_bytes)
  );
  if coalesce((quota_result ->> 'ok')::boolean, false) = false then
    perform private.record_bootstrap_attempt(
      p_auth_user_id,
      'create_room',
      coalesce(quota_result #>> '{error,code}', 'RATE_LIMITED')
    );
    return quota_result;
  end if;

  payload_key_version := private.get_current_secret_version('payload_encryption');
  payload_key := private.get_secret_value('payload_encryption', payload_key_version);
  if payload_key_version is null or payload_key is null then
    perform private.record_bootstrap_attempt(
      p_auth_user_id,
      'create_room',
      'PAYLOAD_PROTECTION_REQUIRED'
    );
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  v_expires_at := now() + make_interval(secs => cfg.challenge_ttl_seconds);

  insert into private.room_create_payload_challenges(
    auth_user_id,
    client_room_id,
    encrypted_payload,
    encryption_key_version,
    plaintext_fingerprint,
    plaintext_size_bytes,
    item_count,
    canonical_schema_version,
    payload_protection_mode,
    expires_at
  )
  values (
    p_auth_user_id,
    p_client_room_id,
    extensions.pgp_sym_encrypt_bytea(
      payload_bytes,
      payload_key,
      'cipher-algo=aes256, compress-algo=0'
    ),
    payload_key_version,
    actual_fingerprint,
    length(payload_bytes),
    p_item_count,
    p_canonical_schema_version,
    'encrypted',
    v_expires_at
  )
  returning id into payload_row_id;

  insert into private.room_join_challenges(
    purpose,
    room_id,
    auth_user_id,
    create_payload_challenge_id,
    create_payload_fingerprint,
    canonical_schema_version,
    canonical_payload_ref,
    payload_size_bytes,
    item_count,
    expires_at
  )
  values (
    'create_room',
    p_client_room_id,
    p_auth_user_id,
    payload_row_id,
    actual_fingerprint,
    p_canonical_schema_version,
    payload_row_id,
    length(payload_bytes),
    p_item_count,
    v_expires_at
  )
  returning room_join_challenges.challenge_id into v_challenge_id;

  return private.sharing_success(jsonb_build_object(
    'challengeId', v_challenge_id,
    'roomId', p_client_room_id,
    'expiresAt', v_expires_at
  ));
end;
$$;

create or replace function private.prepare_create_room_fixture_challenge_internal(
  p_auth_user_id uuid,
  p_client_room_id uuid,
  p_canonical_payload text,
  p_plaintext_fingerprint text,
  p_fixture_run_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  payload_bytes bytea;
  payload_json jsonb;
  actual_fingerprint text;
  payload_key_version integer;
  payload_key text;
  payload_row_id uuid;
  v_challenge_id uuid;
  v_expires_at timestamptz;
begin
  select * into cfg from private.get_sharing_runtime_config();
  if not found
     or cfg.public_mode <> 'local'
     or cfg.payload_protection_mode <> 'plaintext_local_fixture' then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  if p_auth_user_id is null
     or p_client_room_id is null
     or p_fixture_run_id is null
     or length(p_fixture_run_id) < 8 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  begin
    payload_json := p_canonical_payload::jsonb;
  exception
    when others then
      return private.sharing_error('INVALID_REQUEST');
  end;

  if payload_json ->> 'fixtureOnly' <> 'true'
     or payload_json ->> 'fixtureRunId' <> p_fixture_run_id then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  payload_bytes := convert_to(p_canonical_payload, 'UTF8');
  if length(payload_bytes) > cfg.max_canonical_create_payload_bytes then
    return private.sharing_error('CREATE_PAYLOAD_TOO_LARGE');
  end if;

  actual_fingerprint := private.base64url(extensions.digest(payload_bytes, 'sha256'));
  if actual_fingerprint <> p_plaintext_fingerprint then
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  payload_key_version := private.get_current_secret_version('payload_fixture_encryption');
  payload_key := private.get_secret_value('payload_fixture_encryption', payload_key_version);
  if payload_key_version is null or payload_key is null then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  v_expires_at := now() + make_interval(secs => cfg.challenge_ttl_seconds);

  insert into private.room_create_payload_challenges(
    auth_user_id,
    client_room_id,
    encrypted_payload,
    encryption_key_version,
    plaintext_fingerprint,
    plaintext_size_bytes,
    item_count,
    canonical_schema_version,
    payload_protection_mode,
    expires_at
  )
  values (
    p_auth_user_id,
    p_client_room_id,
    extensions.pgp_sym_encrypt_bytea(
      payload_bytes,
      payload_key,
      'cipher-algo=aes256, compress-algo=0'
    ),
    payload_key_version,
    actual_fingerprint,
    length(payload_bytes),
    0,
    1,
    'plaintext_local_fixture',
    v_expires_at
  )
  returning id into payload_row_id;

  insert into private.room_join_challenges(
    purpose,
    room_id,
    auth_user_id,
    create_payload_challenge_id,
    create_payload_fingerprint,
    canonical_schema_version,
    canonical_payload_ref,
    payload_size_bytes,
    item_count,
    expires_at
  )
  values (
    'create_room',
    p_client_room_id,
    p_auth_user_id,
    payload_row_id,
    actual_fingerprint,
    1,
    payload_row_id,
    length(payload_bytes),
    0,
    v_expires_at
  )
  returning room_join_challenges.challenge_id into v_challenge_id;

  return private.sharing_success(jsonb_build_object(
    'challengeId', v_challenge_id,
    'roomId', p_client_room_id,
    'expiresAt', v_expires_at
  ));
end;
$$;

create or replace function private.prepare_member_token_internal(
  p_auth_user_id uuid,
  p_room_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  rate_result jsonb;
  matched_room_id uuid;
  matched_version integer;
  matched_digest bytea;
  v_challenge_id uuid;
  token_context text;
  v_expires_at timestamptz;
begin
  if p_auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  select * into cfg from private.get_sharing_runtime_config();
  if not found then
    return private.sharing_error('SHARING_DISABLED');
  end if;

  rate_result := private.check_bootstrap_rate_limit(p_auth_user_id, 'join');
  if coalesce((rate_result ->> 'ok')::boolean, false) = false then
    return rate_result;
  end if;

  if private.normalize_room_code(p_room_code) !~ '^[A-Z0-9]{5,32}$' then
    perform private.record_bootstrap_attempt(p_auth_user_id, 'join', 'ROOM_UNAVAILABLE');
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select r.id, a.secret_version, a.room_code_digest
    into matched_room_id, matched_version, matched_digest
  from private.accepted_room_code_digest_candidates(p_room_code) candidate
  join private.room_code_digest_aliases a
    on a.secret_version = candidate.secret_version
   and a.room_code_digest = candidate.room_code_digest
   and a.is_active
  join public.rooms r
    on r.id = a.room_id
   and r.sharing_status = 'active'
   and r.expires_at > now()
  order by r.created_at desc
  limit 1;

  if matched_room_id is null then
    perform private.record_bootstrap_attempt(p_auth_user_id, 'join', 'ROOM_UNAVAILABLE');
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  token_context := 'restore:v1:' || matched_room_id::text;
  v_expires_at := now() + make_interval(secs => cfg.challenge_ttl_seconds);

  insert into private.room_join_challenges(
    purpose,
    room_id,
    auth_user_id,
    room_code_secret_version,
    room_code_digest,
    token_context,
    expires_at
  )
  values (
    'join',
    matched_room_id,
    p_auth_user_id,
    matched_version,
    matched_digest,
    token_context,
    v_expires_at
  )
  returning room_join_challenges.challenge_id into v_challenge_id;

  return private.sharing_success(jsonb_build_object(
    'challengeId', v_challenge_id,
    'roomId', matched_room_id,
    'tokenContext', token_context,
    'expiresAt', v_expires_at
  ));
end;
$$;

create or replace function private.prepare_restore_token_internal(
  p_auth_user_id uuid,
  p_room_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  rate_result jsonb;
  v_challenge_id uuid;
  token_context text;
  v_expires_at timestamptz;
begin
  if p_auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  select * into cfg from private.get_sharing_runtime_config();
  if not found then
    return private.sharing_error('SHARING_DISABLED');
  end if;

  rate_result := private.check_bootstrap_rate_limit(p_auth_user_id, 'restore');
  if coalesce((rate_result ->> 'ok')::boolean, false) = false then
    return rate_result;
  end if;

  if not exists (
    select 1
    from public.rooms
    where rooms.id = p_room_id
      and sharing_status = 'active'
      and rooms.expires_at > now()
  ) then
    perform private.record_bootstrap_attempt(p_auth_user_id, 'restore', 'ROOM_UNAVAILABLE');
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  token_context := 'restore:v1:' || p_room_id::text;
  v_expires_at := now() + make_interval(secs => cfg.challenge_ttl_seconds);

  insert into private.room_join_challenges(
    purpose,
    room_id,
    auth_user_id,
    token_context,
    expires_at
  )
  values (
    'restore',
    p_room_id,
    p_auth_user_id,
    token_context,
    v_expires_at
  )
  returning room_join_challenges.challenge_id into v_challenge_id;

  return private.sharing_success(jsonb_build_object(
    'challengeId', v_challenge_id,
    'roomId', p_room_id,
    'tokenContext', token_context,
    'expiresAt', v_expires_at
  ));
end;
$$;

create or replace function public.prepare_create_room_challenge(
  p_client_room_id uuid,
  p_canonical_payload text,
  p_plaintext_fingerprint text,
  p_item_count integer,
  p_canonical_schema_version integer,
  p_payload_protection_mode text default 'encrypted'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if private.direct_bootstrap_disallowed() then
    return private.sharing_error('GUARD_REQUIRED');
  end if;

  return private.prepare_create_room_challenge_internal(
    auth.uid(),
    p_client_room_id,
    p_canonical_payload,
    p_plaintext_fingerprint,
    p_item_count,
    p_canonical_schema_version,
    p_payload_protection_mode
  );
end;
$$;

create or replace function public.prepare_room_member_token(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if private.direct_bootstrap_disallowed() then
    return private.sharing_error('GUARD_REQUIRED');
  end if;

  return private.prepare_member_token_internal(auth.uid(), p_room_code);
end;
$$;

create or replace function public.prepare_restore_member_token(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if private.direct_bootstrap_disallowed() then
    return private.sharing_error('GUARD_REQUIRED');
  end if;

  return private.prepare_restore_token_internal(auth.uid(), p_room_id);
end;
$$;

create or replace function public.guard_prepare_create_room_internal(
  p_auth_user_id uuid,
  p_client_room_id uuid,
  p_canonical_payload text,
  p_plaintext_fingerprint text,
  p_item_count integer,
  p_canonical_schema_version integer,
  p_payload_protection_mode text default 'encrypted'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.guard_service_role_claim_ok() then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  return private.prepare_create_room_challenge_internal(
    p_auth_user_id,
    p_client_room_id,
    p_canonical_payload,
    p_plaintext_fingerprint,
    p_item_count,
    p_canonical_schema_version,
    p_payload_protection_mode
  );
end;
$$;

create or replace function public.guard_prepare_join_internal(
  p_auth_user_id uuid,
  p_room_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.guard_service_role_claim_ok() then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  return private.prepare_member_token_internal(p_auth_user_id, p_room_code);
end;
$$;

create or replace function public.guard_prepare_restore_internal(
  p_auth_user_id uuid,
  p_room_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.guard_service_role_claim_ok() then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  return private.prepare_restore_token_internal(p_auth_user_id, p_room_id);
end;
$$;

create or replace function public.create_room(p_challenge_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sharing_error('CHALLENGE_INVALID');
$$;

create or replace function public.join_room_by_code(
  p_challenge_id uuid,
  p_member_restore_token text,
  p_display_name text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sharing_error('CHALLENGE_INVALID');
$$;

create or replace function public.restore_member_by_key(
  p_challenge_id uuid,
  p_member_restore_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sharing_error('CHALLENGE_INVALID');
$$;

create or replace function public.get_room_snapshot(p_room_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sharing_error('SHARING_DISABLED');
$$;

create or replace function public.ack_room_snapshot_watermark(
  p_room_id uuid,
  p_snapshot_receipt_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sharing_error('SNAPSHOT_RECEIPT_INVALID');
$$;

create or replace function public.claim_item(
  p_user_id uuid,
  p_status text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sharing_error('CLIENT_UPGRADE_REQUIRED');
$$;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

revoke all on all tables in schema private from anon, authenticated;
revoke all on all functions in schema private from public;

revoke all on function public.prepare_create_room_challenge(
  uuid,
  text,
  text,
  integer,
  integer,
  text
) from public;
revoke all on function public.prepare_room_member_token(text) from public;
revoke all on function public.prepare_restore_member_token(uuid) from public;
revoke all on function public.guard_prepare_create_room_internal(
  uuid,
  uuid,
  text,
  text,
  integer,
  integer,
  text
) from public;
revoke all on function public.guard_prepare_join_internal(uuid, text) from public;
revoke all on function public.guard_prepare_restore_internal(uuid, uuid) from public;
revoke all on function public.create_room(uuid) from public;
revoke all on function public.join_room_by_code(uuid, text, text) from public;
revoke all on function public.restore_member_by_key(uuid, text) from public;
revoke all on function public.get_room_snapshot(uuid) from public;
revoke all on function public.ack_room_snapshot_watermark(uuid, uuid) from public;
revoke all on function public.claim_item(uuid, text) from public;

grant execute on function public.prepare_create_room_challenge(
  uuid,
  text,
  text,
  integer,
  integer,
  text
) to authenticated;
grant execute on function public.prepare_room_member_token(text) to authenticated;
grant execute on function public.prepare_restore_member_token(uuid) to authenticated;
grant execute on function public.create_room(uuid) to authenticated;
grant execute on function public.join_room_by_code(uuid, text, text) to authenticated;
grant execute on function public.restore_member_by_key(uuid, text) to authenticated;
grant execute on function public.get_room_snapshot(uuid) to authenticated;
grant execute on function public.ack_room_snapshot_watermark(uuid, uuid) to authenticated;
grant execute on function public.claim_item(uuid, text) to authenticated;

grant execute on function public.guard_prepare_create_room_internal(
  uuid,
  uuid,
  text,
  text,
  integer,
  integer,
  text
) to service_role;
grant execute on function public.guard_prepare_join_internal(uuid, text) to service_role;
grant execute on function public.guard_prepare_restore_internal(uuid, uuid) to service_role;
