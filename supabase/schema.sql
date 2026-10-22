-- Copiloto de Marketing IA · Yango — esquema de Supabase.
-- Ejecutar una vez en Supabase: SQL Editor → New query → pegar → Run.
-- Las tablas replican las pestañas del Excel (datos_crudos, diccionario, presupuesto, log_ia),
-- con una columna «escenario» en datos_crudos para comparar escenarios simulados.
-- Regla del MVP: cero datos personales.

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

-- Registro central de preguntas al asistente y briefings aprobados.
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
  sesion       text check (char_length(sesion) <= 64)  -- id anónimo del navegador, para medir adopción
);
create index if not exists log_ia_created_at_idx on public.log_ia (created_at desc);

-- Seguridad a nivel de fila: la app usa la clave pública "anon".
-- Puede LEER los datos y el registro, y AGREGAR filas al registro; nada más.
-- Los datos se editan solo desde el panel de Supabase (Table Editor) o con seed.sql.
alter table public.escenarios   enable row level security;
alter table public.datos_crudos enable row level security;
alter table public.diccionario  enable row level security;
alter table public.presupuesto  enable row level security;
alter table public.log_ia       enable row level security;

drop policy if exists "lectura publica" on public.escenarios;
drop policy if exists "lectura publica" on public.datos_crudos;
drop policy if exists "lectura publica" on public.diccionario;
drop policy if exists "lectura publica" on public.presupuesto;
drop policy if exists "lectura publica" on public.log_ia;
drop policy if exists "registrar uso"   on public.log_ia;

create policy "lectura publica" on public.escenarios   for select to anon, authenticated using (true);
create policy "lectura publica" on public.datos_crudos for select to anon, authenticated using (true);
create policy "lectura publica" on public.diccionario  for select to anon, authenticated using (true);
create policy "lectura publica" on public.presupuesto  for select to anon, authenticated using (true);
create policy "lectura publica" on public.log_ia       for select to anon, authenticated using (true);
create policy "registrar uso"   on public.log_ia       for insert to anon, authenticated with check (true);
