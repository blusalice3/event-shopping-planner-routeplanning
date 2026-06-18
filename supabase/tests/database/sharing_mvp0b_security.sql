begin;

select plan(55);

select has_table('public', 'rooms', 'foundation creates rooms');
select has_table('public', 'room_members', 'foundation creates room_members');
select has_table('public', 'room_items', 'foundation creates room_items');
select has_table('public', 'room_event_data', 'foundation creates room_event_data');
select has_table('private', 'sharing_runtime_config', 'mvp0b creates private runtime config');
select has_table('private', 'sharing_secret_versions', 'mvp0b creates private secret versions');
select has_table('private', 'room_create_payload_challenges', 'mvp0b creates encrypted payload challenge table');
select has_table('private', 'room_join_challenges', 'mvp0b creates join challenge table');
select has_table('private', 'room_member_credentials', 'mvp0b creates private credential digest table');
select has_table('private', 'room_code_sealed_codes', 'mvp0b stores room codes only as encrypted sealed values');

select has_function(
  'public',
  'prepare_create_room_challenge',
  array['uuid', 'text', 'text', 'integer', 'integer', 'text'],
  'local/limited bootstrap create challenge RPC exists'
);

select has_function(
  'public',
  'guard_prepare_create_room_internal',
  array['uuid', 'uuid', 'text', 'text', 'integer', 'integer', 'text'],
  'public Guard create challenge RPC exists'
);

select has_function(
  'public',
  'guard_prepare_join_internal',
  array['uuid', 'text'],
  'public Guard join challenge RPC exists'
);

select has_function(
  'private',
  'prepare_create_room_fixture_challenge_internal',
  array['uuid', 'uuid', 'text', 'text', 'text'],
  'fixture challenge RPC is private-only'
);

select isnt_empty(
  $$
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and coalesce(p.proconfig::text, '') like '%search_path%'
  $$,
  'SECURITY DEFINER functions pin search_path explicitly'
);

select ok(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated cannot use private schema directly'
);

select ok(
  not has_table_privilege('authenticated', 'private.room_create_payload_challenges', 'select'),
  'authenticated cannot select private payload rows'
);

select ok(
  not has_table_privilege('authenticated', 'private.room_member_credentials', 'select'),
  'authenticated cannot select private credential digest rows'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.prepare_create_room_fixture_challenge_internal(uuid, uuid, text, text, text)',
    'execute'
  ),
  'authenticated cannot execute fixture-only private RPC'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

update private.sharing_runtime_config
set public_mode = 'public',
    guard_required = true,
    payload_protection_mode = 'encrypted';

select is(
  public.prepare_create_room_challenge(
    '22222222-2222-4222-8222-222222222222',
    '{"itemSnapshots":{},"schemaVersion":1}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1}', 'UTF8'), 'sha256')),
    0,
    1,
    'encrypted'
  ) #>> '{error,code}',
  'GUARD_REQUIRED',
  'sharing_mvp0b_guard_db_boundary: public mode rejects direct browser create bootstrap'
);

select is(
  (select count(*)::integer from private.room_create_payload_challenges),
  0,
  'sharing_mvp0b_guard_db_boundary: rejected direct create bootstrap creates no payload row'
);

select is(
  public.prepare_room_member_token('AB12C') #>> '{error,code}',
  'GUARD_REQUIRED',
  'sharing_mvp0b_guard_db_boundary: public mode rejects direct browser join bootstrap'
);

select is(
  public.prepare_restore_member_token('33333333-3333-4333-8333-333333333333') #>> '{error,code}',
  'GUARD_REQUIRED',
  'sharing_mvp0b_guard_db_boundary: public mode rejects direct browser restore bootstrap'
);

select is(
  public.guard_prepare_create_room_internal(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '{"itemSnapshots":{},"schemaVersion":1}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1}', 'UTF8'), 'sha256')),
    0,
    1,
    'encrypted'
  ) #>> '{error,code}',
  'PERMISSION_DENIED',
  'sharing_mvp0b_guard_db_boundary: Guard internal create rejects missing service_role JWT claim'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"00000000-0000-4000-8000-000000000000"}',
  true
);

select is(
  public.guard_prepare_create_room_internal(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '{"itemSnapshots":{},"schemaVersion":1}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1}', 'UTF8'), 'sha256')),
    0,
    1,
    'encrypted'
  ) #>> '{error,code}',
  'PAYLOAD_PROTECTION_REQUIRED',
  'sharing_mvp0b_private_payload_protection: Guard create fails closed when payload key is missing'
);

insert into private.sharing_secret_versions(
  secret_kind,
  secret_version,
  secret_value,
  is_current,
  is_accepted
) values
  ('payload_encryption', 1, repeat('p', 32), true, true),
  ('payload_fixture_encryption', 1, repeat('f', 32), true, true),
  ('room_code', 1, repeat('r', 32), true, true),
  ('room_code_encryption', 1, repeat('e', 32), true, true),
  ('member_restore_lookup', 1, repeat('l', 32), true, true),
  ('member_restore_verify', 1, repeat('v', 32), true, true);

select ok(
  (public.guard_prepare_create_room_internal(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '{"itemSnapshots":{},"schemaVersion":1}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1}', 'UTF8'), 'sha256')),
    0,
    1,
    'encrypted'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_private_payload_protection: Guard create stores encrypted payload challenge after key injection'
);

select is(
  (select count(*)::integer from private.room_create_payload_challenges),
  1,
  'sharing_mvp0b_private_payload_protection: Guard create inserts one payload row'
);

select isnt(
  encode((select encrypted_payload from private.room_create_payload_challenges limit 1), 'escape'),
  '{"itemSnapshots":{},"schemaVersion":1}',
  'sharing_mvp0b_private_payload_protection: canonical payload is not stored as plaintext'
);

select is(
  public.guard_prepare_create_room_internal(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222223',
    '{"itemSnapshots":{},"schemaVersion":1}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1}', 'UTF8'), 'sha256')),
    1,
    1,
    'encrypted'
  ) #>> '{error,code}',
  'CHALLENGE_INVALID',
  'sharing_mvp0b_create_payload_limits: item_count must match itemSnapshots count'
);

select is(
  public.guard_prepare_create_room_internal(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222224',
    '{"itemSnapshots":{},"schemaVersion":1,"remarks":"' || repeat('x', 8193) || '"}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1,"remarks":"' || repeat('x', 8193) || '"}', 'UTF8'), 'sha256')),
    0,
    1,
    'encrypted'
  ) #>> '{error,code}',
  'CREATE_PAYLOAD_TOO_LARGE',
  'sharing_mvp0b_create_payload_limits: too-long string field is rejected'
);

update private.sharing_runtime_config
set max_unconsumed_create_payloads_per_auth = 1;

select is(
  public.guard_prepare_create_room_internal(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222225',
    '{"itemSnapshots":{},"schemaVersion":1}',
    private.base64url(extensions.digest(convert_to('{"itemSnapshots":{},"schemaVersion":1}', 'UTF8'), 'sha256')),
    0,
    1,
    'encrypted'
  ) #>> '{error,code}',
  'RATE_LIMITED',
  'sharing_mvp0b_create_payload_limits: unconsumed payload quota rejects new create challenge'
);

update private.sharing_runtime_config
set max_unconsumed_create_payloads_per_auth = 10;

insert into public.rooms(id, event_name, created_by)
values (
  '33333333-3333-4333-8333-333333333333',
  'MVP-0b test room',
  '11111111-1111-4111-8111-111111111111'
);

select ok(
  (private.create_room_code_aliases(
    '33333333-3333-4333-8333-333333333333',
    'AB12C'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_room_code_secret_rotation: room code alias helper writes accepted-version aliases'
);

select ok(
  exists (
    select 1
    from private.room_code_sealed_codes
    where room_id = '33333333-3333-4333-8333-333333333333'
  ),
  'sharing_mvp0b_room_code_secret_rotation: normalized room code is retained only as sealed private data'
);

select ok(
  (public.guard_prepare_join_internal(
    '11111111-1111-4111-8111-111111111111',
    'AB12C'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_guard_db_boundary: Guard join creates challenge for valid code'
);

insert into public.rooms(id, event_name, created_by)
values (
  '33333333-3333-4333-8333-333333333334',
  'MVP-0b duplicate code room',
  '11111111-1111-4111-8111-111111111111'
);

select is(
  private.create_room_code_aliases(
    '33333333-3333-4333-8333-333333333334',
    'AB12C'
  ) #>> '{error,code}',
  'ROOM_UNAVAILABLE',
  'sharing_mvp0b_room_code_secret_rotation: same active plaintext code is rejected by digest alias uniqueness'
);

update public.rooms
set sharing_status = 'closed'
where id = '33333333-3333-4333-8333-333333333334';

insert into private.sharing_secret_versions(
  secret_kind,
  secret_version,
  secret_value,
  is_current,
  is_accepted
) values
  ('room_code', 2, repeat('s', 32), false, true);

select ok(
  (private.backfill_room_code_aliases(2) ->> 'ok')::boolean,
  'sharing_mvp0b_room_code_secret_rotation: accepted-version alias backfill succeeds from sealed code'
);

select ok(
  exists (
    select 1
    from private.room_code_digest_aliases
    where room_id = '33333333-3333-4333-8333-333333333333'
      and secret_version = 2
      and is_active
  ),
  'sharing_mvp0b_room_code_secret_rotation: backfill creates alias for new accepted room-code secret version'
);

select ok(
  (public.guard_prepare_join_internal(
    '11111111-1111-4111-8111-111111111111',
    'AB12C'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_room_code_secret_rotation: join lookup works across accepted room-code secret versions'
);

insert into public.room_members(id, room_id, user_id, display_name, role)
select pg_catalog.gen_random_uuid(),
       '33333333-3333-4333-8333-333333333333',
       pg_catalog.gen_random_uuid(),
       'member-' || n::text,
       case when n = 1 then 'host' else 'member' end
from generate_series(1, 19) n;

select ok(
  (private.check_room_member_limit(
    '33333333-3333-4333-8333-333333333333'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_room_member_limit_helper: 19 active members allows one more join'
);

insert into public.room_members(id, room_id, user_id, display_name, role)
values (
  '44444444-4444-4444-8444-444444444420',
  '33333333-3333-4333-8333-333333333333',
  '55555555-5555-4555-8555-555555555520',
  'member-20',
  'member'
);

select is(
  private.check_room_member_limit(
    '33333333-3333-4333-8333-333333333333'
  ) #>> '{error,code}',
  'ROOM_MEMBER_LIMIT_REACHED',
  'sharing_mvp0b_room_member_limit_helper: 20 active members rejects new join'
);

select ok(
  (private.check_room_member_limit(
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444420'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_room_member_limit_helper: existing member restore is not counted as a new join'
);

select ok(
  (private.store_room_member_credential(
    '44444444-4444-4444-8444-444444444420',
    repeat('A', 43)
  ) ->> 'ok')::boolean,
  'credential digest: restore credential is stored as server-side digests'
);

select is(
  (select octet_length(member_key_lookup_digest)
   from private.room_member_credentials
   where room_member_id = '44444444-4444-4444-8444-444444444420'),
  32,
  'credential digest: lookup digest is SHA-256 sized'
);

create temporary table mvp0b_selected_join_challenge as
select challenge_id
from private.room_join_challenges
where purpose = 'join'
order by created_at desc
limit 1;

select is(
  private.validate_bootstrap_challenge(
    (select challenge_id from mvp0b_selected_join_challenge),
    'restore',
    '11111111-1111-4111-8111-111111111111'
  ) #>> '{error,code}',
  'CHALLENGE_INVALID',
  'sharing_mvp0b_attempt_commit_boundary: wrong purpose returns stable error envelope'
);

select is(
  (select attempt_count
   from private.room_join_challenges
   where challenge_id = (select challenge_id from mvp0b_selected_join_challenge)),
  1,
  'sharing_mvp0b_attempt_commit_boundary: wrong purpose increments challenge attempt_count'
);

select isnt_empty(
  $$
    select 1
    from private.bootstrap_attempts
    where result_code = 'CHALLENGE_INVALID'
  $$,
  'sharing_mvp0b_attempt_commit_boundary: expected challenge failure commits attempt log'
);

update private.room_join_challenges
set created_at = now() - interval '2 seconds',
    expires_at = now() - interval '1 second'
where challenge_id = (select challenge_id from mvp0b_selected_join_challenge);

select is(
  private.validate_bootstrap_challenge(
    (select challenge_id from mvp0b_selected_join_challenge),
    'join',
    '11111111-1111-4111-8111-111111111111'
  ) #>> '{error,code}',
  'CHALLENGE_INVALID',
  'sharing_mvp0b_attempt_commit_boundary: expired challenge returns stable error envelope'
);

select ok(
  (private.cleanup_expired_bootstrap_challenges() ->> 'ok')::boolean,
  'sharing_mvp0b_private_payload_protection: expired challenges and orphaned payload cleanup helper succeeds'
);

update private.sharing_runtime_config
set public_mode = 'local',
    guard_required = false,
    payload_protection_mode = 'plaintext_local_fixture';

select is(
  public.prepare_create_room_challenge(
    '66666666-6666-4666-8666-666666666666',
    '{"fixtureOnly":true,"fixtureRunId":"run-0001"}',
    private.base64url(extensions.digest(convert_to('{"fixtureOnly":true,"fixtureRunId":"run-0001"}', 'UTF8'), 'sha256')),
    0,
    1,
    'plaintext_local_fixture'
  ) #>> '{error,code}',
  'PAYLOAD_PROTECTION_REQUIRED',
  'sharing_mvp0b_private_payload_protection: normal authenticated bootstrap cannot use plaintext_local_fixture'
);

select is(
  private.prepare_create_room_fixture_challenge_internal(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    '{"fixtureOnly":false,"fixtureRunId":"run-0001"}',
    private.base64url(extensions.digest(convert_to('{"fixtureOnly":false,"fixtureRunId":"run-0001"}', 'UTF8'), 'sha256')),
    'run-0001'
  ) #>> '{error,code}',
  'INVALID_REQUEST',
  'sharing_mvp0b_private_payload_protection: fixture RPC rejects non-dummy fixture payload'
);

select ok(
  (private.prepare_create_room_fixture_challenge_internal(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    '{"fixtureOnly":true,"fixtureRunId":"run-0001"}',
    private.base64url(extensions.digest(convert_to('{"fixtureOnly":true,"fixtureRunId":"run-0001"}', 'UTF8'), 'sha256')),
    'run-0001'
  ) ->> 'ok')::boolean,
  'sharing_mvp0b_private_payload_protection: private fixture RPC stores dummy fixture as encrypted payload'
);

select ok(
  exists (
    select 1
    from private.room_create_payload_challenges
    where payload_protection_mode = 'plaintext_local_fixture'
      and encrypted_payload is not null
  ),
  'sharing_mvp0b_private_payload_protection: fixture label still uses encrypted payload storage'
);

create function public.hmac(bytea, bytea, text)
returns bytea
language sql
as $$
  select decode(repeat('00', 32), 'hex');
$$;

select isnt(
  private.room_code_digest('AB12C', 1),
  decode(repeat('00', 32), 'hex'),
  'search_path/shadowing: private digest helper schema-qualifies extension hmac'
);

select has_function(
  'public',
  'claim_item',
  array['uuid', 'text', 'text', 'integer'],
  'sharing_mvp1_gate_progression: claim_item is opened by the MVP-1 migration'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_room'
      and p.pronargs = 1
  ),
  'sharing_mvp0b_legacy_client_fail_closed: legacy create_room(challenge_id) signature is removed before MVP-0c opens create'
);

select * from finish();

rollback;
