/* Configuración del Copiloto de Marketing IA.
   Con supabaseUrl y supabaseAnonKey vacíos, la app funciona solo con los Excel de data/.
   Para usar la base de datos: Supabase → Project Settings → API → copia "Project URL" y la clave "publishable" (o "anon public").
   La clave anon es pública por diseño: la seguridad la dan las políticas RLS de supabase/schema.sql.
   Nunca pongas aquí la clave "service_role". */
window.COPILOTO_CONFIG = {
  supabaseUrl: 'https://xubnplutpfkxkzwuebpg.supabase.co',
  supabaseAnonKey: 'sb_publishable_1rvoYKrN8nQFferis-y9xw_bt6B9J42',

  // Escenarios cuando no hay base de datos (con Supabase se leen de la tabla «escenarios»).
  escenarios: [
    { id: 'base', nombre: 'Base', archivo: 'data/kpis_marketing.xlsx' },
    { id: 'muy_favorable', nombre: 'Muy favorable', archivo: 'data/kpis_marketing_muy_favorables.xlsx' },
    { id: 'neutro', nombre: 'Neutro', archivo: 'data/kpis_marketing_neutro.xlsx' },
    { id: 'desfavorable', nombre: 'Desfavorable', archivo: 'data/kpis_marketing_desfavorables.xlsx' },
  ],
};
