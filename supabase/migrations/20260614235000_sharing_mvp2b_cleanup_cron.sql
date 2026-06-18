-- [MVP-2b] Schedule expired-room cleanup daily at 03:00 JST.

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function private.run_expired_room_cleanup_job()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleanup_result jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  cleanup_result := public.cleanup_expired_room_data(null, 72, 50);
  return cleanup_result;
end;
$$;

revoke all on function private.run_expired_room_cleanup_job() from public;
revoke all on function private.run_expired_room_cleanup_job() from anon;
revoke all on function private.run_expired_room_cleanup_job() from authenticated;
grant execute on function private.run_expired_room_cleanup_job() to postgres;

do $$
begin
  perform cron.unschedule(job.jobid)
  from cron.job job
  where job.jobname = 'sharing-expired-room-cleanup-daily';

  perform cron.schedule(
    'sharing-expired-room-cleanup-daily',
    '0 18 * * *',
    'select private.run_expired_room_cleanup_job();'
  );
end;
$$;
