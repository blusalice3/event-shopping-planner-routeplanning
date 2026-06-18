-- [MVP-2c] Enable route-order versions for newly created rooms and snapshots.

alter table public.rooms
  alter column route_order_version set default 0;

update public.rooms
set route_order_version = 0
where route_order_version is null;

alter table private.room_snapshot_receipts
  drop constraint if exists room_snapshot_receipts_route_order_version_check;

alter table private.room_snapshot_receipts
  add constraint room_snapshot_receipts_route_order_version_check
  check (route_order_version is null or route_order_version >= 0);
