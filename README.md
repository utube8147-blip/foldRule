# Foldrule

![Foldrule](public/brand/foldrule-app-icon.svg)

PDF takeoff and BOQ, in your browser: open a PDF drawing, calibrate the
scale, measure lengths, areas and counts, group them, and export a priced BOQ
to Excel.

Projects are stored **locally in the browser** (IndexedDB) — no account or
database is needed. Use **Download backup** on the dashboard to move a project
between computers. (Backups are `.foldrule` files; older `.qsproj` backups still import.)

## Quick start

```bash
npm install
cp .env.example .env.local   # only needed for lab features
npm run dev                  # http://localhost:3000
```

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Dev server (lab pages enabled)                 |
| `npm run build`     | Production build (type-checks)                 |
| `npm start`         | Serve the production build                     |
| `npm run typecheck` | `tsc --noEmit`                                 |
| `npm run lint`      | ESLint (errors fail; legacy issues are warnings) |
| `npm test`          | Vitest unit tests                              |
| `npm run check`     | typecheck + lint + test                        |

Requires Node 20.9+.

## How it fits together

```
/dashboard                      list / create / import local projects
/workspace?project=<id>         the takeoff workspace
/takeoff-full?project=<id>      full-screen takeoff table
/presets?project=<id>           preset library

app/(project)/ProjectSession    reads ?project, loads it, autosaves it
context/TakeoffContext.tsx      project state, undo/redo, persistence
lib/storage/projectDb.ts        IndexedDB: projects + PDF blobs, backups
lib/takeoff/scale.ts            per-page scale + rescaling on calibration
components/Viewer/              PDF canvas, tools, snapping, magic fill
lib/export/                     Excel export (Takeoff sheet + BOQ sheets)
app/api/export/route.ts         validated POST → .xlsx
```

### Measurements, pages and scale

* Every measurement stores the `pageNumber` it was drawn on; the viewer only
  shows the current page's measurements.
* Scale is **per page** (`Drawing.pageScales`). An uncalibrated page shows a
  banner; quantities are in drawing units until you set the scale (press **K**).
* Calibrating a page rescales that page's existing drawn measurements
  (lengths × r, areas × r²). Manually overridden quantities and counts are left
  alone. Calibration is undoable.

### Keyboard shortcuts (owned by `Viewer.tsx`)

`V` select · `P` polygon · `R` rectangle · `M` magic fill · `L` linear ·
`B` arc · `Y` polyarc · `C` circle · `N` count · `T` point · `G` grid count ·
`O` perimeter offset · `K` set scale · `Esc` cancel / back to select ·
`Ctrl/⌘ Z` undo · `Ctrl/⌘ Shift Z` or `Ctrl/⌘ Y` redo ·
`Ctrl/⌘ + / − / 0` zoom in / out / fit.
Shortcuts ignore key presses with Ctrl/⌘/Alt and anything typed into fields.

### Export

`POST /api/export` receives the project's measurements (no PDFs), validates
them with zod, and returns a workbook whose first sheet, **Takeoff**, lists
every measurement with live formulas for amounts, group subtotals, VAT and the
total. When the project has a material library, the Summary / BOQ matrix /
Materials / Cost breakdown sheets are added after it.

## Brand, SEO and icons

* Brand constants (name, tagline, description, colours): `lib/brand.ts`.
  Logo components: `components/brand/Logo.tsx` (`<Logo />`, `<FoldruleMark />`, `<Wordmark />`).
* Colours are Tailwind tokens in `app/globals.css`: `graphite`, `rule`
  (yellow), `paper`, `steel`, `marker` (red). The older `industrial-*` and
  `amber-accent` names map to the same palette.
* Fonts: Inter (UI) and JetBrains Mono (labels, values) — the original app fonts — via `next/font`. Archivo is used only for the wordmark.
* SEO: metadata in `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts`,
  `app/manifest.ts`, generated social image `app/opengraph-image.tsx`, and
  JSON-LD on the landing page. Project screens, labs and auth placeholders are
  `noindex`. Set `NEXT_PUBLIC_SITE_URL` in production.
* Icons: `npm run icons` regenerates `app/icon.svg`, `app/favicon.ico`,
  `app/apple-icon.png`, `public/icons/*` and `public/brand/*` from the mark.
* Storage keys (`quantity-savior` database, backup format id) intentionally
  keep their old names so existing projects and backups keep working.

## Workspace features

* **Row ↔ shape linking** — click a takeoff row to select its shape (switching
  drawing/page and scrolling to it); with the Select tool, click a shape to
  select its row.
* **Labels** — `LABELS ON/OFF` in the toolbar draws each quantity on the drawing
  (cached with the shapes, so it costs nothing while you draw).
* **Scale presets** — `1:N ▾` next to Calibrate sets the scale from the title
  block (e.g. "1:100 @ A1"), correcting for PDFs printed on a different sheet.
* **Project Explorer** — search drawings, filter to pages that need a scale,
  page chips (● = scale set) for multi-page PDFs, remove a drawing.
* **Analysis** — "Generate Full Analysis": quantities by type, cost by group,
  unpriced rows and pages without a scale (click to jump to each).
* Drag PDFs onto the drawing area; press `?` for all keyboard shortcuts.

## Performance notes

* **Context split** — `useTakeoffData()` gives project data + actions;
  `useTakeoffContext()` adds the per-click drawing state (Viewer only). Save
  status is in `useSaveStatus()`. Prefer `useTakeoffData()` in new components
  so they don't re-render on every drawing click.
* **Drawing canvas** — committed measurements are cached in an off-screen
  layer; pointer moves only update refs and repaint once per animation frame.
* **PDF render** — pages render off-screen and swap in, so zooming never
  blanks the drawing.
* **Code splitting** — three.js loads only with the preset 3D preview; the
  snap workers are real files in `workers/*.worker.js`.
* **Animations** — use `import * as motion from 'motion/react-m'` (not
  `motion/react`); `LazyMotion` is set up in `components/MotionProvider.tsx`
  and throws in dev if the full `motion` component is used.

## Install as an app, save to a folder, open files

**Install.** In Edge/Chrome an **Install app** button appears in the dashboard
header when the browser allows it (and in the address bar). The installed app
has its own window, works offline after first use (`public/sw.js`, production
builds only), and opens files from File Explorer: double-click a `.foldrule`
backup, or right-click a PDF → *Open with → Foldrule* (handled by `/open`).

**Save to a folder** (Edge/Chrome). Dashboard → *Save location* → *Choose
folder*. Browser storage stays the working copy; the folder is a mirror of real
files, one sub-folder per project:

```
<your folder>/Colombo-Residence__1a2b3c4d/project.json
<your folder>/Colombo-Residence__1a2b3c4d/drawings/A-101__9f8e7d6c.pdf
```

Every save is pushed to the folder; opening the dashboard syncs both ways (the
newer copy wins), so a OneDrive/Google Drive folder keeps two computers in step.
Code: `lib/storage/folderSync.ts`, UI: `components/pwa/FolderControls.tsx`.

**Permission, without nagging.** Browsers only grant folder access from a click.
First time: the folder picker grants it. Later, in a normal tab the browser may
forget it; saving then pauses (work still saves in the browser) and a single
inline "Allow access" strip appears — "Not now" hides it for the session. In the
installed app, Edge/Chrome offer *Allow on every visit*, so it isn't asked again.
Nothing opens a dialog on its own.

## Log in / Sign up

`/login` and `/register` are live. There is no account server yet, so signing
up or logging in saves a **local profile** (name, firm, email — never the
password) in this browser via `lib/profile.ts`; it appears in the dashboard
header, and Logout clears it. Replace with real auth when the backend lands.

## Lab / test-bench pages

`/magicFill`, `/PdfCVMatchPage` and `/Snap` (in `app/(test)/`) are for building
and trying features before wiring them into the workspace. They, the Roboflow
proxy (`/api/roboflow`) and the sample-workbook `GET /api/export` are:

* **enabled** in `npm run dev`
* **404** in production builds, unless `NEXT_PUBLIC_ENABLE_LABS=true`

If you enable labs on a public deployment, set `ROBOFLOW_ALLOWED_WORKSPACES`
/ `ROBOFLOW_ALLOWED_MODELS` so the proxy can't be used for other models.

## PDF.js

The viewer uses one PDF.js instance (`lib/pdf/pdfClient.ts`) with the worker
at `public/pdf.worker.min.js`. The worker **must match** the `pdfjs-dist`
version, so the package is pinned exactly. After upgrading:

```bash
cp node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs public/pdf.worker.min.js
```

## Adding a backend later

Keep the function signatures in `lib/storage/projectDb.ts`
(`listProjects`, `getProject`, `saveProjectState`, `saveDrawingFile`, …) and
swap or sync the implementation — the UI and context call only those. See
`context/DataArchitecture.md` for the planned Supabase schema.

## Known limitations

* Data lives in one browser profile. Clearing site data deletes projects —
  download backups. The app asks the browser for persistent storage.
* The `(project)` screens need `?project=<id>`; open them from the dashboard.
* ~450 lint warnings (mostly `any` and unused variables in older code) are
  left as warnings to fix incrementally.
