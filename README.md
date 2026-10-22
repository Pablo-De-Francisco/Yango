# Copiloto de Marketing IA · Yango (prototipo borrador)

Prototipo del MVP descrito en el informe integrado del curso *Innovación Tech III – Desarrollo de modelos de negocio con IA*.
Autor: Pablo Esteban de Francisco.

El prototipo tiene tres piezas, alimentadas por una **base de datos Supabase** (o, si no está configurada, por los **Excel** de `data/`):

1. **Hoja de KPIs y diccionario**: inversión, conversiones, ingresos, ROAS y CPA por canal, tendencia semanal, plan vs. real y definiciones únicas.
2. **Briefing semanal IA**: borrador de correo para la Dirección de Marketing (resumen, qué explica el cambio, qué decidir), editable y con aprobación humana.
3. **Asistente de preguntas**: responde solo con cifras de los datos y cita la fuente; si el dato no está, lo dice.

Además, un **registro (log_ia)** de briefings aprobados y preguntas. Con Supabase el registro es **central** y cada consulta queda asociada a la **cuenta** que la hizo.

Con Supabase configurado, **para entrar hace falta una cuenta** (correo y contraseña). Cada usuario ve solo sus consultas; las cuentas con rol **admin** ven las de todos, con filtro por usuario.

Un selector de **escenario** permite comparar cuatro conjuntos de datos simulados: *Base*, *Muy favorable*, *Neutro* y *Desfavorable* (no son resultados reales).

> Borrador: el "motor de IA" es un conjunto de reglas que corre en el navegador sobre los datos. No envía datos a ningún modelo de IA externo. En una siguiente versión se puede conectar a un LLM vía API con las mismas reglas del prompt.

## Conectar Supabase (plan gratuito)

1. Crea una cuenta y un proyecto en [supabase.com](https://supabase.com).
2. En el proyecto: **SQL Editor → New query**, pega el contenido de `supabase/schema.sql` y pulsa **Run** (crea las tablas, las cuentas y la seguridad; se puede volver a ejecutar sin perder datos).
3. Repite con `supabase/seed.sql` (carga los cuatro escenarios, el diccionario y el presupuesto).
4. En **Project Settings → API** copia **Project URL** y la clave **anon public**, y pégalas en `config.js` (`supabaseUrl` y `supabaseAnonKey`).
5. Sube el cambio a GitHub: Vercel vuelve a publicar el sitio solo.

La clave *publishable / anon* es pública por diseño: sin sesión no da acceso a nada. Con sesión, las políticas de `schema.sql` solo permiten **leer** los datos y **agregar** consultas propias; no se puede modificar ni borrar nada desde la app. **Nunca** pongas la clave `secret` / `service_role` en `config.js`.

Si Supabase no responde después de iniciar sesión, la app muestra un aviso y usa el Excel del escenario.

## Cuentas y administrador

1. **Correo de confirmación.** Por defecto Supabase pide confirmar el correo al crear una cuenta, y en el plan gratuito solo envía unos pocos correos por hora. Para una demo: **Authentication → Sign In / Providers → Email → desactivar "Confirm email"**. Si lo dejas activo, en **Authentication → URL Configuration** pon **Site URL** = `https://yango-seven.vercel.app` (para que el enlace del correo vuelva a la app).
2. **Crea tu cuenta** en la app con el botón **Crear cuenta** (o en **Authentication → Users → Add user**).
3. **Hazte administrador** ejecutando en el SQL Editor (con tu correo):
   ```sql
   update public.perfiles set rol = 'admin' where email = 'tu-correo@ejemplo.com';
   ```
   Cierra sesión y vuelve a entrar: verás la etiqueta **Administrador** y, en la pestaña **Registro**, todas las consultas con su usuario.
4. **Opcional, acceso solo por invitación:** desactiva **Authentication → Sign In / Providers → "Allow new users to sign up"** y crea las cuentas tú mismo en **Authentication → Users → Add user** (marca *Auto Confirm User*).

El rol solo se puede cambiar desde el SQL Editor; ningún usuario puede hacerse administrador desde la app.

> En el plan gratuito, Supabase pausa los proyectos tras ~1 semana sin actividad; se reactivan desde el panel.

## Tablas

| Tabla | Contenido |
|---|---|
| `escenarios` | id y nombre de cada escenario (los muestra el selector) |
| `datos_crudos` | una fila por escenario, semana y canal (inversión, impresiones, clics, conversiones, ingresos) |
| `diccionario` | definición única, fórmula, dueño y meta de cada KPI |
| `presupuesto` | presupuesto por mes (AAAA-MM) y canal |
| `log_ia` | preguntas y briefings: fecha, cuenta (`user_id`), tipo, escenario, semana, respuesta, fuente, revisor |
| `perfiles` | una fila por cuenta: correo y rol (`usuario` o `admin`); se crea sola al registrarse |
| `log_ia_detalle` | vista de `log_ia` con el correo de quien consultó |

Para ver qué consultó cada usuario: entra a la app con una cuenta **admin** → pestaña **Registro** (filtro por usuario y descarga a Excel), o en Supabase **Table Editor → log_ia_detalle** (exportable a CSV).

## Cómo modificar los datos

- **Con Supabase:** edita las filas en **Table Editor** (o importa un CSV). Para agregar un escenario, crea su fila en `escenarios` y sus filas en `datos_crudos` con ese id.
- **Sin Supabase:** reemplaza el Excel del escenario en `data/` (en GitHub: *Add file → Upload files*, mismo nombre). Los archivos se listan en `config.js`.
- **Prueba rápida (solo tú):** pulsa **Cargar mi Excel** (o arrastra el archivo a la página). Todo se recalcula al instante en tu navegador.

Reglas: no cambies los nombres de las pestañas ni de los encabezados del Excel; puedes agregar semanas y canales nuevos; cero datos personales.

## Estructura

```
index.html            interfaz
styles.css            estilos
app.js                lectura de datos (Supabase o Excel), métricas, briefing y asistente
config.js             conexión a Supabase y lista de escenarios
data/*.xlsx           un Excel por escenario (respaldo sin base de datos)
supabase/schema.sql   tablas y seguridad (RLS)
supabase/seed.sql     datos iniciales de los cuatro escenarios
vercel.json           sin caché para los Excel
```

Sitio estático: no necesita compilación. En local basta con servir la carpeta (por ejemplo `npx serve .`).
