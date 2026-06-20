# Offsite BCAS · web móvil

Mini-app web (mobile-first) para el offsite de BCAS. Pensada para enviarse por adelantado
(el "momento 0") y para ir desbloqueando juegos durante el día.

## Qué incluye

- **Inicio** — portada, cuenta atrás para la salida e info esencial.
- **Casa** — preview de la casa rural, galería de fotos, cómo llegar (dirección + Google Maps)
  y la checklist de **qué llevar** (se guarda en el móvil de cada persona).
- **Agenda** — horario del día en formato timeline.
- **Equipo** — "conoce al equipo".
- **Juegos** — tarjetas de juego **bloqueadas con código**, que se van abriendo durante el offsite.

Es un único archivo autónomo (`index.html`), sin dependencias ni build. Funciona abriéndolo
directo en el móvil o servido como web. Se puede **añadir a la pantalla de inicio** como una app.

## Cómo editar el contenido

Todo el contenido vive en el objeto **`CONFIG`** al principio del `<script>` en `index.html`:

| Campo            | Para qué |
|------------------|----------|
| `startISO`       | Fecha/hora de la cuenta atrás (salida). |
| `casa.direccion` | Dirección que se muestra en "Cómo llegar". |
| `casa.mapsUrl`   | Enlace de Google Maps del botón. |
| `casa.fotos`     | URLs de fotos de la casa (si está vacío, salen placeholders). |
| `packing`        | Lista de "qué llevar". |
| `agenda`         | Horario por días (usa `tbd:true` para marcar "por confirmar"). |
| `team`           | Personas del equipo (los colores del avatar se generan solos). |
| `games`          | Juegos y su **`code`** de desbloqueo (no distingue mayúsculas). |

### Códigos de los juegos (por defecto)

| Juego               | Código    |
|---------------------|-----------|
| ¿Quién es quién?    | `BCAS1`   |
| Trivial BCAS        | `PISCINA` |
| Reto fotográfico    | `FOTO`    |
| Hombres lobo        | `LUNA`    |

Cámbialos por los que quieras y ve repartiéndolos en cada momento del día.

## Despliegue

El proyecto está en Vercel. La app queda accesible en **`/offsite`** (rewrite añadido en
`vercel.json`). También funciona abriendo `offsite/index.html` localmente.
