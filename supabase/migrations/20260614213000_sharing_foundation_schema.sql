-- [MVP-0 foundation] Empty-DB baseline for the sharing domain.
-- This migration creates only the structural tables needed before MVP-0b.
-- User-facing create/join/snapshot flows remain closed until MVP-0c.

create schema if not exists "private";

create schema if not exists "extensions";
create extension if not exists "pgcrypto" with schema "extensions";

revoke all on schema "private" from public;
revoke all on schema "private" from anon;
revoke all on schema "private" from authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.rooms (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  event_name text not null,
  sharing_status text not null default 'active'
    check (sharing_status in ('active', 'expired', 'closed')),
  created_by uuid,
  host_member_id uuid,
  room_code_secret_version integer,
  room_code_digest bytea,
  items_version bigint not null default 0 check (items_version >= 0),
  route_order_version bigint,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (route_order_version is null or route_order_version >= 0)
);

create table public.room_members (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  display_name text not null,
  color text,
  role text not null check (role in ('host', 'member')),
  membership_status text not null default 'active'
    check (membership_status in ('active', 'left')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((membership_status = 'left') = (left_at is not null))
);

alter table public.rooms
  add constraint rooms_host_member_id_fkey
  foreign key (host_member_id)
  references public.room_members(id)
  on delete set null
  deferrable initially deferred;

create unique index room_members_one_host_per_room
  on public.room_members(room_id)
  where role = 'host' and membership_status = 'active';

create unique index room_members_one_active_auth_per_room
  on public.room_members(room_id, user_id)
  where membership_status = 'active';

create table public.room_event_data (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  schema_version integer not null,
  event_data jsonb not null,
  event_data_size_bytes integer not null check (event_data_size_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.room_items (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  local_item_id text not null,
  event_date text,
  name text not null,
  purchase_status text not null default 'None'
    check (purchase_status in (
      'None',
      'Purchased',
      'SoldOut',
      'Absent',
      'Postpone',
      'Late',
      'LimitedPurchase'
    )),
  price numeric,
  quantity integer check (quantity is null or quantity >= 0),
  limit_quantity integer check (limit_quantity is null or limit_quantity >= 0),
  actual_purchase_quantity integer
    check (actual_purchase_quantity is null or actual_purchase_quantity >= 0),
  remarks text,
  url text,
  assigned_to uuid references public.room_members(id) on delete set null,
  secured_by uuid references public.room_members(id) on delete set null,
  order_index integer,
  postponed boolean not null default false,
  item_version bigint not null default 0 check (item_version >= 0),
  updated_by uuid references public.room_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, local_item_id),
  check (order_index is null or order_index >= 0)
);

create index room_items_room_id_item_version_idx
  on public.room_items(room_id, item_version);

create index room_items_room_id_order_index_idx
  on public.room_items(room_id, event_date, order_index)
  where order_index is not null;

create table public.notifications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  event_id uuid not null default pg_catalog.gen_random_uuid(),
  idempotency_key text not null,
  notification_type text not null,
  target_member_id uuid references public.room_members(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, idempotency_key)
);

create index notifications_room_created_idx
  on public.notifications(room_id, created_at, id);

create table public.activity_log (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete cascade,
  room_member_id uuid references public.room_members(id) on delete set null,
  auth_user_id uuid,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_log_room_created_idx
  on public.activity_log(room_id, created_at, id);

create trigger rooms_set_updated_at
before update on public.rooms
for each row execute function private.set_updated_at();

create trigger room_members_set_updated_at
before update on public.room_members
for each row execute function private.set_updated_at();

create trigger room_event_data_set_updated_at
before update on public.room_event_data
for each row execute function private.set_updated_at();

create trigger room_items_set_updated_at
before update on public.room_items
for each row execute function private.set_updated_at();

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_event_data enable row level security;
alter table public.room_items enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_log enable row level security;

-- MVP-0b/0c access goes through SECURITY DEFINER RPCs. Direct table access is closed.
revoke all on table public.rooms from anon, authenticated;
revoke all on table public.room_members from anon, authenticated;
revoke all on table public.room_event_data from anon, authenticated;
revoke all on table public.room_items from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;
revoke all on table public.activity_log from anon, authenticated;
