begin;

create extension if not exists pgcrypto;
create schema if not exists foundation_release;

create table if not exists foundation_release.release_state_heads (
  namespace text primary key,
  sequence bigint not null default 0 check (sequence >= 0),
  event_hash text,
  constraint release_state_heads_hash_check check (
    (sequence = 0 and event_hash is null)
    or (sequence > 0 and event_hash ~ '^[0-9a-f]{64}$')
  )
);

create table if not exists foundation_release.release_state_namespace_roles (
  namespace text primary key
    check (namespace ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  executor_role name not null
);

alter table foundation_release.release_state_namespace_roles
  drop constraint if exists release_state_namespace_roles_namespace_fkey;

create table if not exists foundation_release.release_state_events (
  namespace text not null
    references foundation_release.release_state_heads(namespace)
    on delete restrict,
  sequence bigint not null check (sequence > 0),
  event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
  previous_hash text check (
    previous_hash is null or previous_hash ~ '^[0-9a-f]{64}$'
  ),
  append_id uuid not null,
  event_bytes bytea not null,
  committed_at timestamptz not null default clock_timestamp(),
  primary key (namespace, sequence),
  unique (namespace, append_id),
  unique (namespace, event_hash),
  constraint release_state_events_previous_check check (
    (sequence = 1 and previous_hash is null)
    or (sequence > 1 and previous_hash is not null)
  )
);

create table if not exists foundation_release.release_evidence_objects (
  namespace text not null
    references foundation_release.release_state_heads(namespace)
    on delete restrict,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text not null check (
    length(media_type) between 1 and 255
    and media_type !~ '[[:cntrl:]]'
  ),
  byte_length bigint not null check (
    byte_length >= 0 and byte_length <= 268435456
  ),
  object_bytes bytea not null,
  committed_at timestamptz not null default clock_timestamp(),
  primary key (namespace, sha256),
  constraint release_evidence_length_check
    check (byte_length = octet_length(object_bytes))
);

create or replace function foundation_release.reject_immutable_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception 'foundation release records are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists release_state_events_immutable_update_delete
  on foundation_release.release_state_events;
create trigger release_state_events_immutable_update_delete
before update or delete on foundation_release.release_state_events
for each row execute function foundation_release.reject_immutable_mutation();

drop trigger if exists release_state_events_immutable_truncate
  on foundation_release.release_state_events;
create trigger release_state_events_immutable_truncate
before truncate on foundation_release.release_state_events
for each statement execute function foundation_release.reject_immutable_mutation();

drop trigger if exists release_evidence_immutable_update_delete
  on foundation_release.release_evidence_objects;
create trigger release_evidence_immutable_update_delete
before update or delete on foundation_release.release_evidence_objects
for each row execute function foundation_release.reject_immutable_mutation();

drop trigger if exists release_evidence_immutable_truncate
  on foundation_release.release_evidence_objects;
create trigger release_evidence_immutable_truncate
before truncate on foundation_release.release_evidence_objects
for each statement execute function foundation_release.reject_immutable_mutation();

create or replace function foundation_release.compare_and_append(
  requested_namespace text,
  expected_sequence bigint,
  expected_hash text,
  requested_append_id uuid,
  canonical_event_bytes bytea
)
returns table (
  namespace text,
  sequence bigint,
  event_hash text,
  committed_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, foundation_release
as $$
declare
  expected_executor name;
  existing_event foundation_release.release_state_events%rowtype;
  locked_head foundation_release.release_state_heads%rowtype;
  event_document jsonb;
  computed_hash text;
  committed_clock timestamptz;
begin
  if requested_namespace is null
    or requested_namespace !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  then
    raise exception 'invalid release namespace' using errcode = '22023';
  end if;
  if expected_sequence is null or expected_sequence < 0 then
    raise exception 'invalid expected sequence' using errcode = '22023';
  end if;
  if requested_append_id is null then
    raise exception 'append ID is required' using errcode = '22023';
  end if;
  if canonical_event_bytes is null
    or octet_length(canonical_event_bytes) = 0
    or octet_length(canonical_event_bytes) > 1048576
  then
    raise exception 'invalid event byte length' using errcode = '22023';
  end if;
  if expected_sequence = 0 and expected_hash is not null then
    raise exception 'first append hash must be null' using errcode = '22023';
  end if;
  if expected_sequence > 0
    and (expected_hash is null or expected_hash !~ '^[0-9a-f]{64}$')
  then
    raise exception 'invalid expected event hash' using errcode = '22023';
  end if;

  begin
    event_document := convert_from(canonical_event_bytes, 'UTF8')::jsonb;
  exception
    when others then
      raise exception 'event bytes are not valid UTF-8 JSON'
        using errcode = '22023';
  end;
  if jsonb_typeof(event_document) <> 'object'
    or (
      select count(*)
      from jsonb_object_keys(event_document)
    ) <> 11
    or not (
      event_document ?& array[
        'schemaVersion',
        'namespace',
        'sequence',
        'eventType',
        'operationId',
        'appendId',
        'previousEventHash',
        'payload',
        'payloadSha256',
        'evidenceRefs',
        'approvalRefs'
      ]
    )
    or event_document->>'schemaVersion' is distinct from '1'
    or event_document->>'namespace' is distinct from requested_namespace
    or event_document->>'appendId' is distinct from requested_append_id::text
    or event_document->>'sequence' is null
    or event_document->>'sequence' !~ '^[1-9][0-9]*$'
    or (event_document->>'sequence')::bigint <> expected_sequence + 1
    or event_document->>'eventType' is null
    or event_document->>'eventType' not in (
      'state-initialized',
      'policy-activated',
      'db-contract-activated',
      'promotion-prepared',
      'deployment-assigned',
      'assignment-validated',
      'observation-started',
      'release-accepted',
      'operation-aborted',
      'temporary-containment-activated',
      'containment-activated',
      'rollback-activated',
      'package-redeploy-activated',
      'state-reconciled'
    )
    or coalesce(length(event_document->>'operationId'), 0) = 0
    or jsonb_typeof(event_document->'payload') <> 'object'
    or coalesce(event_document->>'payloadSha256', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(event_document->'evidenceRefs') <> 'array'
    or jsonb_typeof(event_document->'approvalRefs') <> 'array'
    or (
      expected_hash is null
      and (
        not (event_document ? 'previousEventHash')
        or event_document->'previousEventHash' <> 'null'::jsonb
      )
    )
    or (
      expected_hash is not null
      and event_document->>'previousEventHash' is distinct from expected_hash
    )
  then
    raise exception 'event envelope does not match CAS arguments'
      using errcode = '22023';
  end if;

  select executor_role
    into expected_executor
    from foundation_release.release_state_namespace_roles
    where release_state_namespace_roles.namespace = requested_namespace;
  if expected_executor is null
    or session_user::text <> expected_executor::text
  then
    raise exception 'release namespace executor denied' using errcode = '42501';
  end if;

  select *
    into existing_event
    from foundation_release.release_state_events
    where release_state_events.namespace = requested_namespace
      and append_id = requested_append_id;
  if found then
    if existing_event.event_bytes <> canonical_event_bytes then
      raise exception 'append ID replay bytes differ' using errcode = '23505';
    end if;
    return query
      select
        existing_event.namespace,
        existing_event.sequence,
        existing_event.event_hash,
        existing_event.committed_at,
        true;
    return;
  end if;

  if expected_sequence = 0 then
    insert into foundation_release.release_state_heads (
      namespace,
      sequence,
      event_hash
    ) values (
      requested_namespace,
      0,
      null
    )
    on conflict on constraint release_state_heads_pkey do nothing;
  end if;

  select *
    into locked_head
    from foundation_release.release_state_heads
    where release_state_heads.namespace = requested_namespace
    for update;
  if not found then
    raise exception 'release namespace not provisioned' using errcode = 'P0002';
  end if;

  select *
    into existing_event
    from foundation_release.release_state_events
    where release_state_events.namespace = requested_namespace
      and append_id = requested_append_id;
  if found then
    if existing_event.event_bytes <> canonical_event_bytes then
      raise exception 'append ID replay bytes differ' using errcode = '23505';
    end if;
    return query
      select
        existing_event.namespace,
        existing_event.sequence,
        existing_event.event_hash,
        existing_event.committed_at,
        true;
    return;
  end if;

  if locked_head.sequence <> expected_sequence
    or locked_head.event_hash is distinct from expected_hash
  then
    raise exception 'release state compare-and-swap failed'
      using errcode = '40001';
  end if;
  computed_hash := encode(digest(canonical_event_bytes, 'sha256'), 'hex');
  committed_clock := clock_timestamp();

  insert into foundation_release.release_state_events (
    namespace,
    sequence,
    event_hash,
    previous_hash,
    append_id,
    event_bytes,
    committed_at
  ) values (
    requested_namespace,
    expected_sequence + 1,
    computed_hash,
    expected_hash,
    requested_append_id,
    canonical_event_bytes,
    committed_clock
  );

  update foundation_release.release_state_heads
    set
      sequence = expected_sequence + 1,
      event_hash = computed_hash
    where release_state_heads.namespace = requested_namespace;

  return query
    select
      requested_namespace,
      expected_sequence + 1,
      computed_hash,
      committed_clock,
      false;
end;
$$;

create or replace function foundation_release.put_evidence_if_absent(
  requested_namespace text,
  expected_sha256 text,
  requested_media_type text,
  requested_object_bytes bytea
)
returns table (
  namespace text,
  sha256 text,
  media_type text,
  byte_length bigint,
  committed_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, foundation_release
as $$
declare
  expected_executor name;
  computed_hash text;
  existing_object foundation_release.release_evidence_objects%rowtype;
  committed_clock timestamptz;
begin
  if requested_namespace is null
    or requested_namespace !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  then
    raise exception 'invalid release namespace' using errcode = '22023';
  end if;
  if expected_sha256 is null
    or expected_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid evidence SHA-256' using errcode = '22023';
  end if;
  if requested_media_type is null
    or length(requested_media_type) not between 1 and 255
    or requested_media_type ~ '[[:cntrl:]]'
  then
    raise exception 'invalid evidence media type' using errcode = '22023';
  end if;
  if requested_object_bytes is null
    or octet_length(requested_object_bytes) > 268435456
  then
    raise exception 'evidence object exceeds 256 MiB' using errcode = '22023';
  end if;

  select executor_role
    into expected_executor
    from foundation_release.release_state_namespace_roles
    where release_state_namespace_roles.namespace = requested_namespace;
  if expected_executor is null
    or session_user::text <> expected_executor::text
  then
    raise exception 'release namespace executor denied' using errcode = '42501';
  end if;
  computed_hash := encode(digest(requested_object_bytes, 'sha256'), 'hex');
  if computed_hash <> expected_sha256 then
    raise exception 'evidence SHA-256 mismatch' using errcode = '22000';
  end if;

  select *
    into existing_object
    from foundation_release.release_evidence_objects
    where release_evidence_objects.namespace = requested_namespace
      and release_evidence_objects.sha256 = expected_sha256;
  if found then
    if existing_object.object_bytes <> requested_object_bytes
      or existing_object.media_type <> requested_media_type
    then
      raise exception 'evidence hash already has different metadata or bytes'
        using errcode = '23505';
    end if;
    return query
      select
        existing_object.namespace,
        existing_object.sha256,
        existing_object.media_type,
        existing_object.byte_length,
        existing_object.committed_at,
        true;
    return;
  end if;

  insert into foundation_release.release_state_heads (
    namespace,
    sequence,
    event_hash
  ) values (
    requested_namespace,
    0,
    null
  )
  on conflict on constraint release_state_heads_pkey do nothing;

  committed_clock := clock_timestamp();
  insert into foundation_release.release_evidence_objects (
    namespace,
    sha256,
    media_type,
    byte_length,
    object_bytes,
    committed_at
  ) values (
    requested_namespace,
    expected_sha256,
    requested_media_type,
    octet_length(requested_object_bytes),
    requested_object_bytes,
    committed_clock
  )
  on conflict on constraint release_evidence_objects_pkey do nothing;

  if found then
    return query
      select
        requested_namespace,
        expected_sha256,
        requested_media_type,
        octet_length(requested_object_bytes)::bigint,
        committed_clock,
        false;
    return;
  end if;

  select *
    into existing_object
    from foundation_release.release_evidence_objects
    where release_evidence_objects.namespace = requested_namespace
      and release_evidence_objects.sha256 = expected_sha256;
  if not found
    or existing_object.object_bytes <> requested_object_bytes
    or existing_object.media_type <> requested_media_type
  then
    raise exception 'evidence hash already has different metadata or bytes'
      using errcode = '23505';
  end if;
  return query
    select
      existing_object.namespace,
      existing_object.sha256,
      existing_object.media_type,
      existing_object.byte_length,
      existing_object.committed_at,
      true;
end;
$$;

revoke all on schema foundation_release from public;
revoke all on all tables in schema foundation_release from public;
revoke all on all functions in schema foundation_release from public;

comment on schema foundation_release is
  'Protected append-only web foundation release state and evidence store.';
comment on function foundation_release.compare_and_append is
  'CAS append using canonical event bytes; grant EXECUTE only to release executors.';
comment on function foundation_release.put_evidence_if_absent is
  'Content-addressed immutable evidence insert; grant EXECUTE only to release executors.';

commit;
