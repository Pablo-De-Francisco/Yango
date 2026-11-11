-- Endurecimiento de seguridad del Copiloto de Marketing IA.
-- Pegar en Supabase → SQL Editor → New query → Run (se puede volver a ejecutar sin perder datos).
-- Requiere haber ejecutado antes schema.sql (y solicitudes.sql si se usa el agente de datos).

-- 1) Sin sesión (anon) no se puede tocar ninguna tabla ni vista, aunque una política lo permitiera por error.
revoke all on public.escenarios, public.datos_crudos, public.diccionario, public.presupuesto,
              public.log_ia, public.perfiles, public.solicitudes_datos from anon;
revoke all on public.log_ia_detalle from anon;

-- 2) Las tablas de datos solo se leen desde la app; escribir es tarea del servidor (clave secreta).
revoke insert, update, delete, truncate on public.escenarios, public.datos_crudos, public.diccionario, public.presupuesto from authenticated;
grant select on public.escenarios, public.datos_crudos, public.diccionario, public.presupuesto to authenticated;

-- 3) Bloquear manipulación de campos en el registro: una cuenta solo escribe el contenido de la consulta.
--    No puede fijar id, created_at ni user_id (este último lo pone la base con auth.uid()).
revoke insert, update, delete, truncate on public.log_ia from authenticated;
grant insert (tipo, escenario, semana, pregunta, respuesta, fuente, revisado_por, decision, sesion) on public.log_ia to authenticated;
grant select on public.log_ia to authenticated;

-- 4) Perfiles: nadie crea ni borra perfiles desde la app; solo se cambia la preferencia del resumen (ver schema.sql).
revoke insert, delete, truncate on public.perfiles from authenticated;

-- 5) Solicitudes de carga: solo el servidor las lee y escribe.
revoke all on public.solicitudes_datos from authenticated;

-- 6) Uso de las funciones con IA, para limitar consultas por usuario y hora (rate limiting) en el servidor.
--    El navegador no puede leerla ni escribirla: así nadie puede saltarse el límite.
create table if not exists public.uso_api (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null check (char_length(endpoint) <= 40)
);
create index if not exists uso_api_user_idx on public.uso_api (user_id, endpoint, created_at desc);
alter table public.uso_api enable row level security;
revoke all on public.uso_api from anon, authenticated;

-- 7) Borrar el uso de más de 7 días (lo ejecuta el servidor al registrar un uso nuevo; no hace falta programarlo).
create or replace function public.limpiar_uso_api() returns void
language sql security definer set search_path = '' as $$
  delete from public.uso_api where created_at < now() - interval '7 days';
$$;
revoke all on function public.limpiar_uso_api() from public, anon, authenticated;

notify pgrst, 'reload schema';
