// Copy to config.js (or run `node scripts/write-config.mjs` with SUPABASE_URL and
// SUPABASE_ANON_KEY set) and fill in your Supabase project values.
//
// Only ever put the PUBLIC anon key here. It is safe to ship to browsers because
// Row Level Security (supabase/schema.sql) limits it to read-only access.
// NEVER put the service_role key in this file.
window.POSTIT_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-PUBLIC-ANON-KEY",
};
