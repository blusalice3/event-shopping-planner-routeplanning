import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationSource = () =>
  readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260621000000_sharing_item_structural_sync.sql'),
    'utf8',
  );

describe('sharing route date move migration contract', () => {
  it('detaches an existing route item from the old route when its event date changes', () => {
    const source = migrationSource();

    expect(source).toContain('route_detach_for_date_move boolean := false;');
    expect(source).toContain('existing_item.order_index is not null');
    expect(source).toContain('existing_item.event_date is distinct from final_event_date');
    expect(source).toContain('route_event_date <> coalesce(existing_item.event_date, \'\')');
    expect(source).toContain('btrim(p_local_item_id) = any(route_item_ids)');
    expect(source).toContain('where item_id <> btrim(p_local_item_id)');
    expect(source).toContain('order_index = case when route_detach_for_date_move then null else order_index end');
    expect(source).toContain("'route_order_updated'");
    expect(source).toContain("'changedRouteOrders', case");
  });

  it('keeps route-aware create stricter than route date detach', () => {
    const source = migrationSource();

    expect(source).toContain('if event_date_value is distinct from route_event_date');
    expect(source).toContain('or not (btrim(p_local_item_id) = any(route_item_ids)) then');
  });

  it('overrides direct route reorder with v2 canonical item validation', () => {
    const source = migrationSource();

    expect(source).toContain('create or replace function public.update_route_order(');
    expect(source).toContain('insert into public.room_route_order_versions(');
    expect(source).toContain('and coalesce(ri.event_date, \'\') = event_date_key');
    expect(source).toContain('and ri.deleted_at is null');
    expect(source).toContain('event_data_size_bytes = length(convert_to(next_event_data.value::text, \'UTF8\'))');
    expect(source).toContain('changedRouteOrders');
    expect(source).toContain('grant execute on function public.update_route_order(uuid, text, text[], bigint) to authenticated;');
  });

  it('returns fixed tombstone metadata in full snapshots', () => {
    const source = migrationSource();

    expect(source).toContain("'deletedItemClocks', coalesce((");
    expect(source).toContain("'deletedAt', ri.deleted_at");
    expect(source).toContain("'deletedBy', ri.deleted_by");
    expect(source).toContain("'fieldClocks', ri.field_clocks");
    expect(source).toContain("'itemVersion', ri.item_version");
    expect(source).toContain("'updatedAt', ri.updated_at");
  });
});
