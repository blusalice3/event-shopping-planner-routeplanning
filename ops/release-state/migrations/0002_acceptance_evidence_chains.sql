begin;

create table if not exists foundation_release.acceptance_evidence_chains (
  namespace text not null
    references foundation_release.release_state_heads(namespace)
    on delete restrict,
  chain_id text not null check (chain_id ~ '^[0-9a-f]{64}$'),
  operation_id text not null check (length(operation_id) between 1 and 128),
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  binding_id text not null check (length(binding_id) between 1 and 255),
  sequence bigint not null check (sequence > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null,
  primary key (namespace, chain_id),
  foreign key (namespace, head_sha)
    references foundation_release.release_evidence_objects(namespace, sha256)
    on delete restrict
);

create or replace function foundation_release.append_acceptance_evidence_chain(
  requested_namespace text,
  requested_chain_id text,
  requested_operation_id text,
  requested_source_sha text,
  requested_binding_id text,
  expected_sequence bigint,
  expected_head_sha text,
  requested_sample_sha text,
  requested_sample_media_type text,
  requested_sample_bytes bytea,
  requested_commit_sha text,
  requested_commit_media_type text,
  requested_commit_bytes bytea
)
returns table (
  sample_committed_at timestamptz,
  commit_committed_at timestamptz,
  chain_sequence bigint,
  chain_head_sha text,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, foundation_release
as $$
declare
  expected_executor name;
  computed_chain_id text;
  locked_chain foundation_release.acceptance_evidence_chains%rowtype;
  existing_sample foundation_release.release_evidence_objects%rowtype;
  existing_commit foundation_release.release_evidence_objects%rowtype;
  prior_commit foundation_release.release_evidence_objects%rowtype;
  sample_document jsonb;
  commit_document jsonb;
  prior_commit_document jsonb;
  expected_previous_sample jsonb;
  committed_clock timestamptz;
begin
  if requested_namespace is null
    or requested_namespace !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  then
    raise exception 'invalid acceptance chain namespace'
      using errcode = '22023';
  end if;
  select executor_role
    into expected_executor
    from foundation_release.release_state_namespace_roles
    where release_state_namespace_roles.namespace = requested_namespace;
  if expected_executor is null
    or session_user::text <> expected_executor::text
  then
    raise exception 'acceptance chain executor is not authorized'
      using errcode = '42501';
  end if;

  computed_chain_id := encode(
    pg_catalog.sha256(
      convert_to(
        requested_namespace || E'\n'
          || requested_operation_id || E'\n'
          || requested_source_sha || E'\n'
          || requested_binding_id,
        'UTF8'
      )
    ),
    'hex'
  );
  if requested_operation_id is null
    or length(requested_operation_id) not between 1 and 128
    or requested_source_sha is null
    or requested_source_sha !~ '^[0-9a-f]{40}$'
    or requested_binding_id is null
    or length(requested_binding_id) not between 1 and 255
    or requested_chain_id is distinct from computed_chain_id
    or requested_sample_sha is null
    or requested_sample_sha !~ '^[0-9a-f]{64}$'
    or requested_commit_sha is null
    or requested_commit_sha !~ '^[0-9a-f]{64}$'
    or requested_sample_bytes is null
    or octet_length(requested_sample_bytes) > 268435456
    or requested_commit_bytes is null
    or octet_length(requested_commit_bytes) > 268435456
    or requested_sample_sha is distinct from
      encode(pg_catalog.sha256(requested_sample_bytes), 'hex')
    or requested_commit_sha is distinct from
      encode(pg_catalog.sha256(requested_commit_bytes), 'hex')
    or requested_sample_media_type is distinct from
      'application/vnd.event-shopping-planner.continuous-probe-sample+json;version=1'
    or requested_commit_media_type is distinct from
      'application/vnd.event-shopping-planner.continuous-probe-chain-commit+json;version=1'
    or expected_sequence is null
    or expected_sequence < 0
    or (expected_sequence = 0 and expected_head_sha is not null)
    or (expected_sequence > 0 and expected_head_sha !~ '^[0-9a-f]{64}$')
  then
    raise exception 'acceptance chain append arguments are invalid'
      using errcode = '22023';
  end if;

  begin
    sample_document := convert_from(requested_sample_bytes, 'UTF8')::jsonb;
    commit_document := convert_from(requested_commit_bytes, 'UTF8')::jsonb;
  exception
    when others then
      raise exception 'acceptance chain documents are not UTF-8 JSON'
        using errcode = '22023';
  end;
  if jsonb_typeof(sample_document) is distinct from 'object'
    or (
      select array_agg(key order by key)
      from jsonb_object_keys(sample_document) as sample_keys(key)
    ) is distinct from array[
      'collectorIdentity',
      'evidenceKind',
      'namespace',
      'operationId',
      'previousSample',
      'results',
      'schemaVersion',
      'sourceSha',
      'standardBindingId'
    ]::text[]
    or jsonb_typeof(sample_document -> 'schemaVersion') is distinct from 'number'
    or sample_document ->> 'schemaVersion' is distinct from '1'
    or sample_document ->> 'evidenceKind' is distinct from
      'continuous-production-probe-sample/v1'
    or sample_document ->> 'namespace' is distinct from requested_namespace
    or sample_document ->> 'operationId' is distinct from requested_operation_id
    or sample_document ->> 'sourceSha' is distinct from requested_source_sha
    or sample_document ->> 'standardBindingId' is distinct from requested_binding_id
    or jsonb_typeof(sample_document -> 'results') is distinct from 'array'
    or jsonb_typeof(sample_document -> 'collectorIdentity') is distinct from 'object'
  then
    raise exception 'acceptance sample document binding is invalid'
      using errcode = '22023';
  end if;
  if jsonb_typeof(commit_document) is distinct from 'object'
    or (
      select array_agg(key order by key)
      from jsonb_object_keys(commit_document) as commit_keys(key)
    ) is distinct from array[
      'bindingId',
      'commitKind',
      'namespace',
      'operationId',
      'previousCommit',
      'sampleReference',
      'schemaVersion',
      'sequence',
      'sourceSha'
    ]::text[]
    or jsonb_typeof(commit_document -> 'schemaVersion') is distinct from 'number'
    or commit_document ->> 'schemaVersion' is distinct from '1'
    or commit_document ->> 'commitKind' is distinct from
      'continuous-probe-chain-commit/v1'
    or commit_document ->> 'namespace' is distinct from requested_namespace
    or commit_document ->> 'operationId' is distinct from requested_operation_id
    or commit_document ->> 'sourceSha' is distinct from requested_source_sha
    or commit_document ->> 'bindingId' is distinct from requested_binding_id
    or jsonb_typeof(commit_document -> 'sequence') is distinct from 'number'
    or commit_document ->> 'sequence' is distinct from
      (expected_sequence + 1)::text
    or jsonb_typeof(commit_document -> 'sampleReference') is distinct from 'object'
    or (
      select array_agg(key order by key)
      from jsonb_object_keys(
        commit_document -> 'sampleReference'
      ) as sample_reference_keys(key)
    ) is distinct from array['sha256', 'uri']::text[]
    or commit_document -> 'sampleReference' ->> 'sha256' is distinct from
      requested_sample_sha
    or commit_document -> 'sampleReference' ->> 'uri' is distinct from
      format(
        'release-state://%s/evidence/%s',
        requested_namespace,
        requested_sample_sha
      )
  then
    raise exception 'acceptance chain commit document binding is invalid'
      using errcode = '22023';
  end if;
  if expected_sequence = 0 then
    if commit_document -> 'previousCommit' is distinct from 'null'::jsonb
      or sample_document -> 'previousSample' is distinct from 'null'::jsonb
    then
      raise exception 'acceptance chain origin predecessors are invalid'
        using errcode = '22023';
    end if;
  else
    if commit_document -> 'previousCommit' is distinct from jsonb_build_object(
      'sha256',
      expected_head_sha,
      'uri',
      format(
        'release-state://%s/evidence/%s',
        requested_namespace,
        expected_head_sha
      )
    ) then
      raise exception 'acceptance chain commit predecessor is invalid'
        using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(requested_namespace || E'\n' || requested_chain_id, 0)
  );
  select *
    into locked_chain
    from foundation_release.acceptance_evidence_chains
    where acceptance_evidence_chains.namespace = requested_namespace
      and acceptance_evidence_chains.chain_id = requested_chain_id
    for update;

  if found
    and (
      locked_chain.operation_id <> requested_operation_id
      or locked_chain.source_sha <> requested_source_sha
      or locked_chain.binding_id <> requested_binding_id
    )
  then
    raise exception 'acceptance chain identity differs from canonical head'
      using errcode = '40001';
  end if;
  if found
    and locked_chain.sequence = expected_sequence + 1
    and locked_chain.head_sha = requested_commit_sha
  then
    select * into existing_sample
      from foundation_release.release_evidence_objects
      where release_evidence_objects.namespace = requested_namespace
        and release_evidence_objects.sha256 = requested_sample_sha;
    select * into existing_commit
      from foundation_release.release_evidence_objects
      where release_evidence_objects.namespace = requested_namespace
        and release_evidence_objects.sha256 = requested_commit_sha;
    if existing_sample.sha256 is null
      or existing_commit.sha256 is null
      or existing_sample.object_bytes <> requested_sample_bytes
      or existing_sample.media_type <> requested_sample_media_type
      or existing_commit.object_bytes <> requested_commit_bytes
      or existing_commit.media_type <> requested_commit_media_type
      or existing_sample.committed_at <> existing_commit.committed_at
    then
      raise exception 'acceptance chain replay bytes differ'
        using errcode = '23505';
    end if;
    return query select
      existing_sample.committed_at,
      existing_commit.committed_at,
      locked_chain.sequence,
      locked_chain.head_sha,
      true;
    return;
  end if;

  if expected_sequence = 0 then
    if found then
      raise exception 'acceptance chain compare-and-swap failed'
        using errcode = '40001';
    end if;
  elsif not found
    or locked_chain.sequence <> expected_sequence
    or locked_chain.head_sha <> expected_head_sha
  then
    raise exception 'acceptance chain compare-and-swap failed'
      using errcode = '40001';
  end if;

  if expected_sequence > 0 then
    select * into prior_commit
      from foundation_release.release_evidence_objects
      where release_evidence_objects.namespace = requested_namespace
        and release_evidence_objects.sha256 = expected_head_sha;
    if prior_commit.sha256 is null
      or prior_commit.media_type is distinct from
        'application/vnd.event-shopping-planner.continuous-probe-chain-commit+json;version=1'
    then
      raise exception 'acceptance chain canonical predecessor is missing'
        using errcode = '22023';
    end if;
    begin
      prior_commit_document := convert_from(prior_commit.object_bytes, 'UTF8')::jsonb;
    exception
      when others then
        raise exception 'acceptance chain canonical predecessor is invalid'
          using errcode = '22023';
    end;
    expected_previous_sample := prior_commit_document -> 'sampleReference';
    if jsonb_typeof(expected_previous_sample) is distinct from 'object'
      or sample_document -> 'previousSample' is distinct from expected_previous_sample
    then
      raise exception 'acceptance sample predecessor is invalid'
        using errcode = '22023';
    end if;
  end if;

  select * into existing_sample
    from foundation_release.release_evidence_objects
    where release_evidence_objects.namespace = requested_namespace
      and release_evidence_objects.sha256 = requested_sample_sha;
  select * into existing_commit
    from foundation_release.release_evidence_objects
    where release_evidence_objects.namespace = requested_namespace
      and release_evidence_objects.sha256 = requested_commit_sha;
  if existing_sample.sha256 is not null or existing_commit.sha256 is not null then
    raise exception 'acceptance chain objects already exist outside atomic append'
      using errcode = '23505';
  end if;

  committed_clock := clock_timestamp();
  insert into foundation_release.release_evidence_objects (
    namespace, sha256, media_type, byte_length, object_bytes, committed_at
  ) values (
    requested_namespace,
    requested_sample_sha,
    requested_sample_media_type,
    octet_length(requested_sample_bytes),
    requested_sample_bytes,
    committed_clock
  ) returning * into existing_sample;
  insert into foundation_release.release_evidence_objects (
    namespace, sha256, media_type, byte_length, object_bytes, committed_at
  ) values (
    requested_namespace,
    requested_commit_sha,
    requested_commit_media_type,
    octet_length(requested_commit_bytes),
    requested_commit_bytes,
    committed_clock
  ) returning * into existing_commit;

  if expected_sequence = 0 then
    insert into foundation_release.acceptance_evidence_chains (
      namespace,
      chain_id,
      operation_id,
      source_sha,
      binding_id,
      sequence,
      head_sha,
      updated_at
    ) values (
      requested_namespace,
      requested_chain_id,
      requested_operation_id,
      requested_source_sha,
      requested_binding_id,
      1,
      requested_commit_sha,
      committed_clock
    );
  else
    update foundation_release.acceptance_evidence_chains
      set sequence = expected_sequence + 1,
          head_sha = requested_commit_sha,
          updated_at = committed_clock
      where acceptance_evidence_chains.namespace = requested_namespace
        and acceptance_evidence_chains.chain_id = requested_chain_id
        and acceptance_evidence_chains.sequence = expected_sequence
        and acceptance_evidence_chains.head_sha = expected_head_sha;
    if not found then
      raise exception 'acceptance chain compare-and-swap update failed'
        using errcode = '40001';
    end if;
  end if;

  return query select
    committed_clock,
    committed_clock,
    expected_sequence + 1,
    requested_commit_sha,
    false;
end;
$$;

create or replace function foundation_release.read_acceptance_evidence_chain(
  requested_namespace text,
  requested_chain_id text,
  requested_operation_id text,
  requested_source_sha text,
  requested_binding_id text
)
returns table (
  operation_id text,
  source_sha text,
  binding_id text,
  sequence bigint,
  head_sha text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, foundation_release
as $$
declare
  expected_executor name;
  computed_chain_id text;
  canonical_chain foundation_release.acceptance_evidence_chains%rowtype;
begin
  if requested_namespace is null
    or requested_namespace !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  then
    raise exception 'invalid acceptance chain namespace'
      using errcode = '22023';
  end if;
  select executor_role
    into expected_executor
    from foundation_release.release_state_namespace_roles
    where release_state_namespace_roles.namespace = requested_namespace;
  if expected_executor is null
    or session_user::text <> expected_executor::text
  then
    raise exception 'acceptance chain reader is not authorized'
      using errcode = '42501';
  end if;
  computed_chain_id := encode(
    pg_catalog.sha256(
      convert_to(
        requested_namespace || E'\n'
          || requested_operation_id || E'\n'
          || requested_source_sha || E'\n'
          || requested_binding_id,
        'UTF8'
      )
    ),
    'hex'
  );
  if requested_operation_id is null
    or length(requested_operation_id) not between 1 and 128
    or requested_source_sha is null
    or requested_source_sha !~ '^[0-9a-f]{40}$'
    or requested_binding_id is null
    or length(requested_binding_id) not between 1 and 255
    or requested_chain_id is distinct from computed_chain_id
  then
    raise exception 'acceptance chain reader identity is invalid'
      using errcode = '22023';
  end if;
  select *
    into canonical_chain
    from foundation_release.acceptance_evidence_chains
    where acceptance_evidence_chains.namespace = requested_namespace
      and acceptance_evidence_chains.chain_id = requested_chain_id;
  if not found then
    return;
  end if;
  if canonical_chain.operation_id <> requested_operation_id
    or canonical_chain.source_sha <> requested_source_sha
    or canonical_chain.binding_id <> requested_binding_id
  then
    raise exception 'acceptance chain reader identity differs'
      using errcode = '22023';
  end if;
  return query select
    canonical_chain.operation_id,
    canonical_chain.source_sha,
    canonical_chain.binding_id,
    canonical_chain.sequence,
    canonical_chain.head_sha,
    canonical_chain.updated_at;
end;
$$;

revoke all on table foundation_release.acceptance_evidence_chains from public;
revoke all on function foundation_release.append_acceptance_evidence_chain from public;
revoke all on function foundation_release.read_acceptance_evidence_chain from public;

comment on table foundation_release.acceptance_evidence_chains is
  'Canonical CAS heads for protected continuous acceptance evidence chains.';
comment on function foundation_release.append_acceptance_evidence_chain is
  'Atomically stores one sample/commit pair and advances its canonical chain head.';
comment on function foundation_release.read_acceptance_evidence_chain is
  'Reads one canonical acceptance evidence chain head for protected verification.';

commit;
