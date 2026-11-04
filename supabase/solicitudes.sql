-- Solicitudes de carga de datos: un usuario pide al administrador agregar una semana a datos_crudos.
-- Pegar en Supabase → SQL Editor → New query → Run (se puede volver a ejecutar sin perder datos).
-- Solo el servidor (api/agente-datos.js, con la clave secreta) lee y escribe esta tabla: RLS activo y sin políticas,
-- así que nadie puede tocarla directamente desde el navegador.
create table if not exists public.solicitudes_datos (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  user_id      uuid references auth.users (id) on delete set null,
  email        text,
  escenario    text not null references public.escenarios (id) on update cascade,
  semana       integer not null,
  fecha_inicio date,
  filas        jsonb not null,
  nota         text check (char_length(nota) <= 500),
  estado       text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  revisado_por text,
  revisado_at  timestamptz,
  comentario   text check (char_length(comentario) <= 500)
);
create index if not exists solicitudes_estado_idx on public.solicitudes_datos (estado, created_at desc);
alter table public.solicitudes_datos enable row level security;
notify pgrst, 'reload schema';
