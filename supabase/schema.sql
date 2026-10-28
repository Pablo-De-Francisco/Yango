-- Copiloto de Marketing IA · Yango — esquema de Supabase.
-- Ejecutar en Supabase: SQL Editor → New query → pegar → Run.
-- Se puede volver a ejecutar sobre una base existente: no borra datos.
-- Las tablas replican las pestañas del Excel (datos_crudos, diccionario, presupuesto, log_ia),
-- con una columna «escenario» en datos_crudos para comparar escenarios simulados.
-- Para usar la app hace falta una cuenta (Supabase Auth). Regla del MVP: cero datos personales en los datos.

-- Escenarios simulados (base, muy favorable, neutro, desfavorable). La app muestra un selector.
create table if not exists public.escenarios (
  id          text primary key check (id ~ '^[a-z0-9_]+$'),
  nombre      text not null,
  descripcion text,
  orden       integer not null default 0
);

create table if not exists public.datos_crudos (
  id                  bigint generated always as identity primary key,
  escenario           text    not null default 'base' references public.escenarios (id) on update cascade,
  semana              integer not null,
  fecha_inicio        date,
  canal               text    not null,
  inversion           numeric not null check (inversion >= 0),
  impresiones         bigint  not null default 0 check (impresiones >= 0),
  clics               bigint  not null default 0 check (clics >= 0),
  conversiones        numeric not null check (conversiones >= 0),
  ingresos_atribuidos numeric not null check (ingresos_atribuidos >= 0),
  unique (escenario, semana, canal)
);

create table if not exists public.diccionario (
  kpi        text primary key,
  definicion text,
  formula    text,
  dueno      text,
  meta       text,
  orden      integer not null default 0
);

create table if not exists public.presupuesto (
  mes         text    not null check (mes ~ '^\d{4}-\d{2}$'),  -- formato AAAA-MM
  canal       text    not null,
  presupuesto numeric not null check (presupuesto >= 0),
  primary key (mes, canal)
);

-- ---------- cuentas ----------
-- Un perfil por cuenta de Supabase Auth: correo y rol ('usuario' o 'admin').
-- El rol solo se cambia desde el SQL Editor (ver README); la app no puede modificarlo.
create table if not exists public.perfiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  rol        text not null default 'usuario' check (rol in ('usuario', 'admin')),
  created_at timestamptz not null default now()
);

-- preferencia del resumen semanal por correo (el usuario la cambia desde la app)
alter table public.perfiles add column if not exists recibir_resumen boolean not null default true;

create or replace function public.crear_perfil() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario after insert on auth.users for each row execute function public.crear_perfil();
-- perfiles de las cuentas que ya existían antes de este script
insert into public.perfiles (id, email) select id, email from auth.users on conflict (id) do nothing;

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'admin');
$$;

-- Registro central de preguntas al asistente y briefings aprobados, con la cuenta que los hizo.
create table if not exists public.log_ia (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  tipo         text not null check (tipo in ('pregunta', 'briefing')),
  escenario    text check (char_length(escenario) <= 40),
  semana       integer,
  pregunta     text not null check (char_length(pregunta) <= 1000),
  respuesta    text check (char_length(respuesta) <= 5000),
  fuente       text check (char_length(fuente) <= 300),
  revisado_por text check (char_length(revisado_por) <= 120),
  decision     text check (char_length(decision) <= 1000),
  sesion       text check (char_length(sesion) <= 64)  -- id anónimo del navegador
);
alter table public.log_ia add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete set null;
create index if not exists log_ia_created_at_idx on public.log_ia (created_at desc);
create index if not exists log_ia_user_idx on public.log_ia (user_id);

-- Registro con el correo de quien consultó. security_invoker: respeta las reglas de log_ia y perfiles.
create or replace view public.log_ia_detalle with (security_invoker = true) as
  select l.id, l.created_at, l.tipo, l.escenario, l.semana, l.pregunta, l.respuesta, l.fuente,
         l.revisado_por, l.decision, l.sesion, l.user_id, p.email
  from public.log_ia l left join public.perfiles p on p.id = l.user_id;

-- ---------- seguridad (RLS) ----------
-- Sin sesión (anon) no se puede leer ni escribir nada.
-- Con sesión: leer los datos, registrar consultas propias y ver solo las propias; el admin ve todas.
alter table public.escenarios   enable row level security;
alter table public.datos_crudos enable row level security;
alter table public.diccionario  enable row level security;
alter table public.presupuesto  enable row level security;
alter table public.log_ia       enable row level security;
alter table public.perfiles     enable row level security;

-- políticas de la versión sin cuentas
drop policy if exists "lectura publica" on public.escenarios;
drop policy if exists "lectura publica" on public.datos_crudos;
drop policy if exists "lectura publica" on public.diccionario;
drop policy if exists "lectura publica" on public.presupuesto;
drop policy if exists "lectura publica" on public.log_ia;
drop policy if exists "registrar uso"   on public.log_ia;

drop policy if exists "lectura con cuenta"      on public.escenarios;
drop policy if exists "lectura con cuenta"      on public.datos_crudos;
drop policy if exists "lectura con cuenta"      on public.diccionario;
drop policy if exists "lectura con cuenta"      on public.presupuesto;
drop policy if exists "ver propias o admin"     on public.log_ia;
drop policy if exists "registrar propias"       on public.log_ia;
drop policy if exists "ver perfil propio o admin" on public.perfiles;
drop policy if exists "editar preferencias propias" on public.perfiles;

create policy "lectura con cuenta" on public.escenarios   for select to authenticated using (true);
create policy "lectura con cuenta" on public.datos_crudos for select to authenticated using (true);
create policy "lectura con cuenta" on public.diccionario  for select to authenticated using (true);
create policy "lectura con cuenta" on public.presupuesto  for select to authenticated using (true);
create policy "ver propias o admin" on public.log_ia for select to authenticated
  using (user_id = (select auth.uid()) or (select public.es_admin()));
create policy "registrar propias" on public.log_ia for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "ver perfil propio o admin" on public.perfiles for select to authenticated
  using (id = (select auth.uid()) or (select public.es_admin()));
-- cada usuario edita solo su propia fila y solo la columna recibir_resumen (el rol no se puede tocar)
create policy "editar preferencias propias" on public.perfiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke update on public.perfiles from anon, authenticated;
grant update (recibir_resumen) on public.perfiles to authenticated;
