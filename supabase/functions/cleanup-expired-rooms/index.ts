import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  // 認証チェック: service_role キーまたはカスタムシークレット
  const authHeader = req.headers.get("Authorization");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cleanupSecret = Deno.env.get("CLEANUP_SECRET") ?? "";

  const isServiceRole = authHeader === `Bearer ${serviceRoleKey}`;
  const hasCleanupSecret =
    cleanupSecret !== "" &&
    req.headers.get("x-cleanup-secret") === cleanupSecret;

  if (!isServiceRole && !hasCleanupSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // service_role クライアントで RLS バイパス
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await supabase.rpc("cleanup_expired_rooms");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      deleted_count: data ?? 0,
      timestamp: new Date().toISOString(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
