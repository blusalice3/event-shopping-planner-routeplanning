with canonical_route_by_date as (
  select
    route_items.room_id,
    jsonb_object_agg(route_items.event_date, route_items.item_ids order by route_items.event_date) as route_order_by_date
  from (
    select
      ri.room_id,
      ri.event_date,
      jsonb_agg(ri.local_item_id order by ri.order_index, ri.local_item_id, ri.id) as item_ids
    from public.room_items ri
    where ri.deleted_at is null
      and ri.order_index is not null
      and ri.event_date is not null
      and btrim(ri.event_date) <> ''
    group by ri.room_id, ri.event_date
  ) route_items
  group by route_items.room_id
),
repair_candidates as (
  select
    red.room_id,
    jsonb_set(
      red.event_data,
      '{routeOrderByDate}',
      coalesce(canonical.route_order_by_date, '{}'::jsonb),
      true
    ) as next_event_data
  from public.room_event_data red
  join public.rooms r on r.id = red.room_id
  left join canonical_route_by_date canonical on canonical.room_id = red.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and (
      coalesce(red.event_data -> 'routeOrderByDate', '{}'::jsonb)
        <> coalesce(canonical.route_order_by_date, '{}'::jsonb)
      or red.event_data_size_bytes <> length(convert_to(red.event_data::text, 'UTF8'))
    )
),
repaired as (
  update public.room_event_data red
  set event_data = repair_candidates.next_event_data,
      event_data_size_bytes = length(convert_to(repair_candidates.next_event_data::text, 'UTF8'))
  from repair_candidates
  where red.room_id = repair_candidates.room_id
  returning red.room_id
)
select jsonb_build_object(
  'repairedRooms',
  count(*)
) as sharing_activation_mirror_repair
from repaired;
