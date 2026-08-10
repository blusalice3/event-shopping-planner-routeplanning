begin;

-- This is an upgrade-only migration. Refuse a partial or substituted 0001
-- installation before replacing the complete security-definer function.
do $migration$
begin
  if to_regclass('foundation_release.release_state_heads') is null
    or to_regclass('foundation_release.release_state_namespace_roles') is null
    or to_regclass('foundation_release.release_state_events') is null
    or to_regprocedure(
      'foundation_release.compare_and_append(text,bigint,text,uuid,bytea)'
    ) is null
    or not exists (
      select 1
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
      join pg_catalog.pg_language as language
        on language.oid = procedure.prolang
      where namespace.nspname = 'foundation_release'
        and procedure.proname = 'compare_and_append'
        and procedure.prosecdef
        and language.lanname = 'plpgsql'
        and 'search_path=pg_catalog, foundation_release' = any(
          coalesce(procedure.proconfig, array[]::text[])
        )
    )
  then
    raise exception 'compare_and_append prerequisite differs before phase exit migration'
      using errcode = '55000';
  end if;
end;
$migration$;

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
      'phase-exit-attested',
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
  computed_hash := encode(pg_catalog.sha256(canonical_event_bytes), 'hex');
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

comment on function foundation_release.compare_and_append is
  'CAS append using canonical event bytes, including formal phase-exit ledger events; grant EXECUTE only to release executors.';

commit;
