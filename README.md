# Copiloto de Marketing IA · Yango (MVP)

Prototipo del MVP descrito en el informe integrado del curso *Innovación Tech III – Desarrollo de modelos de negocio con IA*.
Autor: Pablo Esteban de Francisco.

El prototipo tiene tres piezas, alimentadas por una **base de datos Supabase** (o, si no está configurada, por los **Excel** de `data/`):

1. **Hoja de KPIs y diccionario**: inversión, conversiones, ingresos, ROAS y CPA por canal, tendencia semanal, plan vs. real y definiciones únicas.
2. **Briefing semanal IA**: correo para la Dirección de Marketing (resumen, qué explica el cambio, qué decidir), editable y con aprobación humana.
3. **Asistente de preguntas**: responde solo con cifras de los datos y cita la fuente; si el dato no está, lo dice.

Además, un **registro (log_ia)** de briefings aprobados y preguntas. Con Supabase el registro es **central** y cada consulta queda asociada a la **cuenta** que la hizo.

Al entrar aparece un **menú de inicio** con tres caminos: descargar el Excel base, modificarlo a mano y subirlo; subir los datos mediante el agente; o explorar la herramienta con los datos base simulados. El botón **Menú de inicio** lo vuelve a abrir.

Con Supabase configurado, **para entrar hace falta una cuenta** (correo y contraseña). Cada usuario ve solo sus consultas; las cuentas con rol **admin** ven las de todos, con filtro por usuario.

Un selector de **escenario** permite comparar cuatro conjuntos de datos simulados: *Base*, *Muy favorable*, *Neutro* y *Desfavorable* (no son resultados reales).

> El asistente y el resumen usan IA (Gemini o Claude, ver más abajo) y solo trabajan con las cifras del escenario elegido. Si la IA no está configurada o falla, responde un motor de reglas que corre en el navegador.

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

## Asistente IA y resumen semanal por correo

- **Asistente IA** (`api/asistente.js`): responde en lenguaje natural con **Gemini** (plan gratuito, variable `GEMINI_API_KEY`; prioriza velocidad: `gemini-3.5-flash-lite` y, si está saturado, `gemini-3.6-flash` y `gemini-3.8-flash`) o con **Claude** (`claude-opus-5-5`, de pago, variable `ANTHROPIC_API_KEY`). En cada consulta el servidor verifica la sesión, trae de Supabase los datos del escenario elegido (todas las semanas, diccionario y presupuesto), calcula ROAS, CPA, variaciones y avance del presupuesto, y se los entrega a la IA, que solo puede usar esas cifras. Recuerda la conversación (últimos 8 mensajes). En la pestaña Briefing, **Resumen detallado con IA** genera el briefing completo. Límite: 40 consultas por usuario y hora. Si la IA no está configurada o falla, responde el motor de reglas.
- **Respuestas en voz** (`api/voz.js`): cada respuesta del asistente y del agente trae el botón **🔊 Escuchar**, y el briefing también. La voz la genera **Gemini** (texto a voz, con la misma `GEMINI_API_KEY`) y cada módulo tiene la suya: asistente RAG = *Kore*, agente de datos = *Puck*, briefing = *Charon*. Los textos largos se piden por fragmentos (el siguiente se prepara mientras suena el actual) y se reproducen con Web Audio. Requiere sesión iniciada; límite: 120 fragmentos de audio por usuario y hora.
- **Dictado por voz** (`api/escuchar.js`): botón **🎤** en el asistente (la pregunta), en el agente (los datos de la semana) y en el briefing (**Indicación por voz**, por ejemplo «enfócate en Meta Ads», que se usa al generar el resumen con IA). Un clic graba y otro termina (máximo 1 minuto); Gemini transcribe el audio con la misma `GEMINI_API_KEY` y, como la pregunta llegó por voz, la respuesta se lee sola en voz alta. El sitio permite el micrófono solo para sí mismo (`Permissions-Policy: microphone=(self)`). Límite: 60 grabaciones por usuario y hora.
- **Resumen semanal** (`api/resumen-semanal.js`): cada **lunes a las 12:00 UTC** (7:00 a. m. en Colombia; ver `crons` en `vercel.json`) genera el briefing de la última semana del escenario *Base* y lo envía al correo de cada usuario con **«Resumen semanal por correo»** activado (casilla junto a su usuario). El administrador puede enviarlo en el momento con **Enviar resumen semanal ahora**.

- **Agente de datos** (pestaña 2, `api/agente-datos.js`): conversa con la persona para cargar una o varias semanas. Si recibe un párrafo dividido por semanas, arma una tabla editable para cada una. Propone el número de semana y la fecha siguientes a la última cargada, pide por canal la inversión, impresiones, clics, conversiones e ingresos (acepta cifras escritas como "12 mil") y las anota en la tabla de su semana. El servidor valida con reglas fijas (datos que faltan, negativos, clics mayores que impresiones, cambios bruscos frente a la semana anterior, semana repetida). Después: **Guardar en la base de datos** (solo administradores; escribe en `datos_crudos` con la clave secreta y queda en el registro), **Descargar Excel actualizado** o **Ver en el tablero** (solo en el navegador).
- **Solicitudes de carga**: los usuarios que no son administradores pulsan **Enviar al administrador para aprobar** (con una nota opcional); cada semana se envía como una solicitud aparte. El administrador ve las pendientes en la misma pestaña (con un contador en la pestaña), puede **Aprobar y guardar** (se valida otra vez y se escribe en `datos_crudos`), **Rechazar** con un motivo, o **Abrir en el borrador** para corregir las cifras. Cada usuario ve el estado de sus solicitudes. Requiere ejecutar una vez `supabase/solicitudes.sql` en el SQL Editor (tabla `solicitudes_datos`, que solo el servidor puede leer y escribir).

Variables de entorno en **Vercel → Settings → Environment Variables** (después: **Redeploy**):

| Variable | Valor |
|---|---|
| `GEMINI_API_KEY` | clave gratuita de [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (o `ANTHROPIC_API_KEY` para usar Claude, de pago). En el plan gratuito Google puede usar lo enviado para mejorar sus productos: los datos del prototipo son simulados y sin datos personales |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API Keys → **secret key** (solo aquí, nunca en `config.js`) |
| `CRON_SECRET` | una frase larga cualquiera; Vercel la usa para autorizar el envío programado |
| `TURNSTILE_SECRET` | Secret Key del widget de Cloudflare Turnstile: con ella el servidor pide el CAPTCHA cada 5 consultas a la IA |
| `GEMINI_TTS_MODEL` | Opcional: modelo de voz de Gemini (si no se define, se prueban los modelos de voz conocidos y, si no existen, se busca uno en la cuenta) |
| `VOZ_ASISTENTE` / `VOZ_AGENTE` / `VOZ_BRIEFING` | Opcional: cambia la voz de cada módulo (voces de Gemini, p. ej. Kore, Puck, Charon, Aoede, Leda) |
| `SMTP_USER` | la cuenta de Gmail que envía los correos |
| `SMTP_PASS` | **contraseña de aplicación** de esa cuenta (Google → Seguridad → Verificación en 2 pasos → Contraseñas de aplicaciones) |

Opcionales: `RESUMEN_ESCENARIO` (por defecto `base`), `SMTP_HOST` / `SMTP_PORT` (por defecto Gmail, 465), `APP_URL`.

Los correos se generan automáticamente con IA, sin revisión previa: llevan un aviso para revisarlos antes de decidir.

## Seguridad

Ejecuta una vez `supabase/seguridad.sql` en el SQL Editor (también está al final de `schema.sql`). Estado de cada control:

| # | Control | Cómo se cumple |
|---|---|---|
| 1 | Secretos fuera de Git | El historial no tiene claves. `.gitignore` excluye `.env*`, `*.pem`, `*.key`. Las claves secretas solo viven en Vercel → Environment Variables |
| 2 | Key pública para la DB | `config.js` usa la clave *publishable*; la *secret* solo la usan las funciones del servidor |
| 3 | Row-Level Security | RLS activo en todas las tablas; sin sesión no se lee nada; `solicitudes_datos` y `uso_api` no tienen políticas (solo el servidor) |
| 4 | Datos sensibles cifrados | Supabase cifra en reposo (AES-256) y en tránsito (TLS); las claves van cifradas en Vercel. En el registro, el correo del destinatario se guarda oculto (`pa…@gmail.com`) |
| 5 | Autenticación obligatoria | Todas las funciones de `api/` exigen sesión válida; el envío semanal, el secreto de Vercel Cron (comparado en tiempo constante) o un administrador |
| 6 | Acceso restringido a registros | Cada usuario ve solo sus consultas; el administrador, todas |
| 7 | Campos protegidos | Permisos por columna: el navegador no puede fijar `id`, `created_at` ni `user_id` en `log_ia`, ni el rol en `perfiles` |
| 8 | Sesión | Supabase Auth guarda la sesión en el navegador (no hay cookies propias); la CSP reduce el riesgo de robo por XSS |
| 9 | Contraseñas con hash | Las gestiona Supabase Auth (bcrypt); la app nunca las guarda |
| 10 | Rate limiting | En el servidor, con la tabla `uso_api`: 40 consultas al asistente, 60 mensajes al agente y 10 correos por usuario y hora |
| 11 | Protección contra bots | CAPTCHA de Cloudflare Turnstile obligatorio al crear cuenta e iniciar sesión (`turnstileSiteKey` en `config.js` + Supabase → Attack Protection) y de nuevo cada 5 consultas a la IA, validado en el servidor con `TURNSTILE_SECRET` en Vercel. Espera de 30 s tras 5 intentos fallidos |
| 12 | Consultas parametrizadas | Todo valor que entra a una consulta se valida (escenario, número, UUID) o se codifica; PostgREST no ejecuta SQL libre |
| 13 | Validación de entradas | Cuerpo JSON con tamaño máximo, acción permitida, correo de un solo destinatario sin saltos de línea, reglas fijas para los datos |
| 14 | Contenido sanitizado | Todo lo que se muestra o se envía por correo se escapa (también el asunto del correo) |
| 15 | Archivos restringidos | Solo `.xlsx`/`.xls` de hasta 5 MB, leídos en el navegador con SheetJS 0.20.3 (sin las vulnerabilidades de la 0.18.5) |
| 16 | Solo los datos necesarios | Las respuestas traen las columnas que usa la app y los errores no muestran tablas ni consultas |
| 17 | Security headers | `vercel.json`: CSP, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` |
| 18 | HTTPS | Vercel redirige a HTTPS y HSTS obliga a usarlo |
| 19 | Dependencias | `npm audit` sin vulnerabilidades; nodemailer 10.5.0; librerías del navegador con versión fija e integridad (SRI) |

Si cambias el script del `<head>` de `index.html`, actualiza su hash `sha256-…` en la CSP de `vercel.json` o el navegador lo bloqueará.

Recomendado en el panel de Supabase (Authentication): exigir contraseñas de al menos 8 caracteres, activar la protección contra contraseñas filtradas, activar CAPTCHA y, para una demo cerrada, desactivar el registro abierto.

## Tablas

| Tabla | Contenido |
|---|---|
| `escenarios` | id y nombre de cada escenario (los muestra el selector) |
| `datos_crudos` | una fila por escenario, semana y canal (inversión, impresiones, clics, conversiones, ingresos) |
| `diccionario` | definición única, fórmula, dueño y meta de cada KPI |
| `presupuesto` | presupuesto por mes (AAAA-MM) y canal |
| `log_ia` | preguntas y briefings: fecha, cuenta (`user_id`), tipo, escenario, semana, respuesta, fuente, revisor |
| `perfiles` | una fila por cuenta: correo, rol (`usuario` o `admin`) y si recibe el resumen semanal; se crea sola al registrarse |
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
app.js                lectura de datos (Supabase o Excel), métricas, briefing, asistente y cuentas
api/asistente.js      asistente IA (Claude) — función de servidor de Vercel
api/voz.js            respuestas en voz con Gemini (una voz por módulo)
api/escuchar.js       dictado por voz: transcribe la grabación con Gemini
api/resumen-semanal.js  envío semanal del briefing por correo (Vercel Cron)
lib/copiloto.js       lógica compartida de las funciones (datos, métricas, Claude)
lib/seguridad.js      validación de entradas, rate limiting y cabeceras de la API
package.json          dependencias de las funciones (SDK de Anthropic, nodemailer)
config.js             conexión a Supabase y lista de escenarios
data/*.xlsx           un Excel por escenario (respaldo sin base de datos)
supabase/schema.sql   tablas y seguridad (RLS)
supabase/seed.sql     datos iniciales de los cuatro escenarios
supabase/seguridad.sql  permisos por columna y tabla de uso (rate limiting)
vercel.json           cabeceras de seguridad (CSP, HSTS…), sin caché para los Excel y tarea semanal
```

Sitio estático: no necesita compilación. En local basta con servir la carpeta (por ejemplo `npx serve .`).
