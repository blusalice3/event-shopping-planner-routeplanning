-- Recover canonical v2 item fields from the original room item snapshots.
-- Older create_room implementations inserted only legacy room_items columns, so
-- v2 snapshots exposed empty circle/block/number values for rooms created from
-- canonical event data.

create or replace function private.room_items_snapshot_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot jsonb;
  snapshot_priority text;
  snapshot_protection text;
  snapshot_source text;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  if new.local_item_id is null or btrim(new.local_item_id) = '' then
    return new;
  end if;

  select red.event_data #> array['itemSnapshots', new.local_item_id]
    into snapshot
  from public.room_event_data red
  where red.room_id = new.room_id
  limit 1;

  if jsonb_typeof(snapshot) <> 'object' then
    return new;
  end if;

  if coalesce(new.circle_name, '') = '' then
    new.circle_name := coalesce(nullif(btrim(snapshot ->> 'circle'), ''), new.circle_name);
  end if;

  if coalesce(new.block_name, '') = '' then
    new.block_name := coalesce(nullif(btrim(snapshot ->> 'block'), ''), new.block_name);
  end if;

  if coalesce(new.booth_number, '') = '' then
    new.booth_number := coalesce(nullif(btrim(snapshot ->> 'number'), ''), new.booth_number);
  end if;

  if coalesce(new.title, '') = '' then
    new.title := coalesce(
      nullif(btrim(snapshot ->> 'title'), ''),
      nullif(btrim(snapshot ->> 'name'), ''),
      new.title
    );
  end if;

  if coalesce(new.event_date, '') = '' then
    new.event_date := coalesce(nullif(btrim(snapshot ->> 'eventDate'), ''), new.event_date);
  end if;

  snapshot_priority := nullif(btrim(snapshot ->> 'priorityLevel'), '');
  if (new.priority_level is null or new.priority_level = 'none')
     and snapshot_priority in ('none', 'priority', 'highest') then
    new.priority_level := snapshot_priority;
  end if;

  snapshot_protection := nullif(btrim(snapshot ->> 'protectionLevel'), '');
  if new.protection_level is null
     and snapshot_protection in ('full', 'deletable', 'none') then
    new.protection_level := snapshot_protection;
  end if;

  snapshot_source := nullif(btrim(snapshot ->> 'source'), '');
  if new.source is null
     and snapshot_source in ('spreadsheet', 'app') then
    new.source := snapshot_source;
  end if;

  if new.manual_hall_id is null then
    new.manual_hall_id := nullif(btrim(snapshot ->> 'manualHallId'), '');
  end if;

  return new;
end;
$$;

drop trigger if exists room_items_snapshot_defaults on public.room_items;
create trigger room_items_snapshot_defaults
before insert on public.room_items
for each row execute function private.room_items_snapshot_defaults();

with snapshot_items as (
  select red.room_id,
         item.key as local_item_id,
         item.value as payload
  from public.room_event_data red
  cross join lateral jsonb_each(
    case
      when jsonb_typeof(red.event_data -> 'itemSnapshots') = 'object'
        then red.event_data -> 'itemSnapshots'
      else '{}'::jsonb
    end
  ) as item(key, value)
),
repair_plan as (
  select ri.id,
         ri.room_id,
         case
           when coalesce(ri.circle_name, '') = ''
             then coalesce(nullif(btrim(si.payload ->> 'circle'), ''), ri.circle_name, '')
           else ri.circle_name
         end as next_circle_name,
         case
           when coalesce(ri.block_name, '') = ''
             then coalesce(nullif(btrim(si.payload ->> 'block'), ''), ri.block_name, '')
           else ri.block_name
         end as next_block_name,
         case
           when coalesce(ri.booth_number, '') = ''
             then coalesce(nullif(btrim(si.payload ->> 'number'), ''), ri.booth_number, '')
           else ri.booth_number
         end as next_booth_number,
         case
           when coalesce(ri.title, '') = ''
             then coalesce(
               nullif(btrim(si.payload ->> 'title'), ''),
               nullif(btrim(si.payload ->> 'name'), ''),
               ri.title,
               ri.name
             )
           else ri.title
         end as next_title,
         case
           when coalesce(ri.event_date, '') = ''
             then coalesce(nullif(btrim(si.payload ->> 'eventDate'), ''), ri.event_date)
           else ri.event_date
         end as next_event_date,
         case
           when (ri.priority_level is null or ri.priority_level = 'none')
                and nullif(btrim(si.payload ->> 'priorityLevel'), '') in ('none', 'priority', 'highest')
             then nullif(btrim(si.payload ->> 'priorityLevel'), '')
           else ri.priority_level
         end as next_priority_level,
         case
           when ri.protection_level is null
                and nullif(btrim(si.payload ->> 'protectionLevel'), '') in ('full', 'deletable', 'none')
             then nullif(btrim(si.payload ->> 'protectionLevel'), '')
           else ri.protection_level
         end as next_protection_level,
         case
           when ri.source is null
                and nullif(btrim(si.payload ->> 'source'), '') in ('spreadsheet', 'app')
             then nullif(btrim(si.payload ->> 'source'), '')
           else ri.source
         end as next_source,
         case
           when ri.manual_hall_id is null
             then nullif(btrim(si.payload ->> 'manualHallId'), '')
           else ri.manual_hall_id
         end as next_manual_hall_id
  from public.room_items ri
  join snapshot_items si
    on si.room_id = ri.room_id
   and si.local_item_id = ri.local_item_id
  where ri.deleted_at is null
),
changed_items as (
  select rp.*
  from repair_plan rp
  join public.room_items ri on ri.id = rp.id
  where ri.circle_name is distinct from rp.next_circle_name
     or ri.block_name is distinct from rp.next_block_name
     or ri.booth_number is distinct from rp.next_booth_number
     or ri.title is distinct from rp.next_title
     or ri.event_date is distinct from rp.next_event_date
     or ri.priority_level is distinct from rp.next_priority_level
     or ri.protection_level is distinct from rp.next_protection_level
     or ri.source is distinct from rp.next_source
     or ri.manual_hall_id is distinct from rp.next_manual_hall_id
),
touched_rooms as (
  update public.rooms r
  set items_version = r.items_version + 1
  where exists (
    select 1
    from changed_items ci
    where ci.room_id = r.id
  )
  returning r.id, r.items_version
)
update public.room_items ri
set circle_name = ci.next_circle_name,
    block_name = ci.next_block_name,
    booth_number = ci.next_booth_number,
    title = ci.next_title,
    event_date = ci.next_event_date,
    priority_level = coalesce(ci.next_priority_level, 'none'),
    protection_level = ci.next_protection_level,
    source = ci.next_source,
    manual_hall_id = ci.next_manual_hall_id,
    item_version = tr.items_version,
    updated_at = now()
from changed_items ci
join touched_rooms tr on tr.id = ci.room_id
where ri.id = ci.id;
