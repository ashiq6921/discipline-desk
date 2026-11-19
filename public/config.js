/* Supabase connection for the hosted app (not used inside the Artifact).
 *
 * url: your project URL. Not a secret.
 * anonKey: the PUBLIC key (Supabase > Project Settings > API Keys: "anon public", or the key that
 *   starts with sb_publishable_). It is safe in a web page because the row-level security rules in
 *   supabase/schema.sql stop it reading anything unless you are logged in.
 *
 * NEVER put the project's secret or admin key (any key labelled "secret") in this file: this file is published on a public website.
 */
window.DD_CONFIG = {
  supabase: {
    url: "https://kitgjisixdofjojuprog.supabase.co",
    anonKey: "sb_publishable_E-tvZ7_JybXVTwnn7fh4Dg_df1oq74H",
  },
};
