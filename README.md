# Copiloto de Marketing IA · Yango (prototipo borrador)

Prototipo del MVP descrito en el informe integrado del curso *Innovación Tech III – Desarrollo de modelos de negocio con IA*.
Autor: Pablo Esteban de Francisco.

El prototipo tiene tres piezas, todas alimentadas por **un solo Excel** (`data/kpis_marketing.xlsx`):

1. **Hoja de KPIs y diccionario**: inversión, conversiones, ingresos, ROAS y CPA por canal, tendencia semanal, plan vs. real y definiciones únicas.
2. **Briefing semanal IA**: borrador de correo para la Dirección de Marketing (resumen, qué explica el cambio, qué decidir), editable y con aprobación humana.
3. **Asistente de preguntas**: responde solo con cifras del Excel y cita la fuente; si el dato no está, lo dice.

Además, un **registro (log_ia)** de briefings aprobados y preguntas, exportable al Excel.

> Borrador: el "motor de IA" es un conjunto de reglas que corre en el navegador sobre los datos del Excel. No envía datos a terceros. En una siguiente versión se puede conectar a un LLM vía API con las mismas reglas del prompt.

## Cómo modificar los datos

El Excel tiene las pestañas `instrucciones`, `datos_crudos`, `kpis`, `diccionario`, `presupuesto` y `log_ia`.

- **Prueba rápida (solo tú):** edita el Excel, abre el prototipo y pulsa **Cargar mi Excel** (o arrastra el archivo a la página). Todo se recalcula al instante.
- **Para todos:** reemplaza `data/kpis_marketing.xlsx` en este repositorio (en GitHub: *Add file → Upload files*, mismo nombre). Vercel vuelve a publicar el sitio solo.

Reglas: no cambies los nombres de las pestañas ni de los encabezados; puedes agregar semanas y canales nuevos; cero datos personales.

## Estructura

```
index.html      interfaz
styles.css      estilos
app.js          lectura del Excel, métricas, briefing y asistente
data/kpis_marketing.xlsx   fuente única de datos
vercel.json     sin caché para el Excel
```

Sitio estático: no necesita compilación. En local basta con servir la carpeta (por ejemplo `npx serve .`).
