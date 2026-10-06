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
`O` perimeter offset · `K` set scale · `S` snap · `F8` angle lock (0°/45°/90°) · `Esc` cancel / back to select ·
`Ctrl/⌘ Z` undo · `Ctrl/⌘ Shift Z` or `Ctrl/⌘ Y` redo ·
`Ctrl/⌘ + / − / 0` zoom in / out / fit.
Shortcuts ignore key presses with Ctrl/⌘/Alt and anything typed into fields.

### Export

`POST /api/export` receives the project's measurements (no PDFs), validates
them with zod, and returns a workbook whose first sheet, **Takeoff**, lists
every measurement with live formulas for amounts, group subtotals, VAT and the
total. When the project has a material library, the Summary / BOQ matrix /
Materials / Cost breakdown sheets are added after it.

## Accounts

Foldrule is offered as a service: people create a free account and log in to
use the tools. **Projects still live on the user's own computer** — the account
only says who they are. (Cloud sync is planned as a paid feature and will hang
off the same user id.)

**Turning accounts on**

1. Create a project at supabase.com.
2. *Settings → API*: copy the Project URL and the `anon` public key into
   `.env.local` (and into Vercel → Settings → Environment Variables):

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ…
   ```

3. *Authentication → URL Configuration*: set **Site URL** to your site
   (e.g. `https://foldrule.app`) and add these **Redirect URLs** for every
   address you use (production, `http://localhost:3000`):
   `…/dashboard` and `…/reset-password`.
4. *Authentication → Providers → Email*: keep "Confirm email" on. For real
   use, set up your own SMTP sender (*Authentication → Emails → SMTP*);
   Supabase's built-in sender is rate-limited to a few emails per hour.
5. Restart `npm run dev` / redeploy (the values are read at build time).

**Until then: mock accounts.** Without those two variables every account
screen still works, on stand-in accounts kept in the browser's localStorage
(`lib/auth/mockAuth.ts`): sign up, log in, log out, profile, change password,
and a reset screen that sets a new password directly (there is no email). The
screens carry a "Demo accounts" badge. This is for building and demos only —
the accounts exist in that one browser, and it is not security. Setting the
two variables switches everything to real accounts with no code changes; mock
accounts do not carry over (their local projects can be moved with
"Download backup" → "Import backup").

**How it fits together**

```
lib/auth/supabase.ts          the client (URL + anon key only)
context/AuthContext.tsx       session, sign in/up/out, reset, profile
components/auth/RequireAuth   gate around /dashboard, /workspace, /takeoff-full,
                              /presets, /open, /account → /login?next=…
app/login  app/register  app/forgot-password  app/reset-password  app/account
lib/storage/projectDb.ts      setStorageOwner(): each local project carries an
                              ownerId; lists and opens are per account
```

* Two people logging in on one computer each see only their own projects.
  Projects made before accounts existed are adopted by the first account that
  opens the project list on that computer.
* A shared projects folder may hold several accounts' projects; each account
  syncs only its own.
* Name and firm are stored in the Supabase user's metadata; no extra tables are
  needed yet.
* The gate decides who may use the app on this deployment. It is **not** a
  security boundary for data (the data is on the user's machine). Anything that
  must be enforced — paid plans, cloud sync — needs a server-side check when
  those features are built.

## Brand, SEO and icons

* Brand constants (name, tagline, description, colours): `lib/brand.ts`.
  Logo components: `components/brand/Logo.tsx` (`<Logo />`, `<FoldruleMark />`, `<Wordmark />`).
* Colours are Tailwind tokens in `app/globals.css`: `graphite`, `rule`
  (yellow), `paper`, `steel`, `marker` (red). The older `industrial-*` and
  `amber-accent` names map to the same palette.
* Fonts: Inter (UI) and JetBrains Mono (labels, values) — the original app fonts — via `next/font`. Archivo is used only for the wordmark.
* SEO: metadata in `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts`,
  `app/manifest.ts`, generated social image `app/opengraph-image.tsx`, and
  JSON-LD on the landing page. Project screens, labs and the account screens are
  `noindex`. Set `NEXT_PUBLIC_SITE_URL` in production.
* Icons: `npm run icons` regenerates `app/icon.svg`, `app/favicon.ico`,
  `app/apple-icon.png`, `public/icons/*` and `public/brand/*` from the mark.
* Storage keys (`quantity-savior` database, backup format id) intentionally
  keep their old names so existing projects and backups keep working.

## Tools: Area · Length · Count

The rail is organised by what is measured, not by shape (`components/Viewer/ToolGroups.tsx`):

| Rail button | Ways to draw (panel that opens beside the button on hover) |
| ----------- | ------------------------------------------ |
| Select      | —                                          |
| Area        | Draw outline (straight, `A` for a curved edge) · Rectangle · Circle · Regular (n sides) |
| Length      | Draw run (straight, `A` for a curved stretch) · Single arc · Circle (circumference) |
| Count       | Items · On a grid · Marker                 |
| Magic fill  | —                                          |

* Each mode is one of the underlying tools plus a `DrawMode` flag
  (`lib/geometry/pathShapes.ts`): e.g. *Area · With curves* is the line+curve
  path tool (`polyarc`) with `area: true`, which closes the path into a polygon.
* Every Area mode commits the **same kind of shape** (a `Polygon` ring; curves
  are finely stepped, a circle's quantity is exact πr²), so later editing /
  cut-outs / merging can treat all areas alike.
* Hovering (or focusing) a rail button opens its ways to draw beside it, each
  with a one-line "what do I click" hint. Clicking the button re-uses the way
  last chosen there; its icon shows the current one. While drawing a path with
  curves, a small Straight / Curve switch sits under the button (or press `A`).
* Shortcuts pick a mode directly: `P` area outline, `R` rectangle,
  `C` circle (area), `L` length run, `B` single arc,
  `N` count, `G` grid count, `T` marker, `M` magic fill; `A` switches the next
  edge between straight and curve while drawing a path.

## Magic fill

* Rooms are worked out once per page from a wall mask (`hooks/fill/`), saved,
  and outlined on hover. **Fills use those outlines**: a click fills the room
  under the cursor, a lasso (hold Space, click around, close) fills every room
  it touches, exactly as previewed. Pieces that only a thin drawn line
  separates are joined into one outline first (`lib/geometry/ringUnion.ts`,
  gaps up to 2 × `LINE_BRIDGE_PX` mask pixels), so no line is drawn through
  the fill and it is one area; rooms separated by a real wall stay separate. The older pixel flood
  fill is only a fallback for pages whose rooms aren't ready yet.
* **Thin lines are walls.** A line narrower than a mask pixel (fine pens, big
  sheets, diagonal and curved lines) is too faint for the darkness test, which
  is how fills leaked through closed walls. `buildWallMask` also accepts
  "ridge" pixels — darker than the paper two pixels away on both sides — so
  hairlines close rooms while tinted/shaded areas stay open. The same code
  lives in `workers/wallMask.worker.js`; a test keeps the two identical.
  `ROOMS_VERSION` was bumped, so saved rooms are rebuilt on first use.

## Workspace layout

```
header        project name · undo/redo · scale · unit · calibrate · save · export
tool rail     far left: a Drawings button, then Select · Area · Length · Count ·
              Magic · More
fly-outs      hovering a rail button opens its ways to draw beside it
drawer        Project Explorer (drawings, scope/specs, upload) — slides over the
              drawing from the rail's top button or [; closes on outside click,
              Esc, or picking a drawing. It never takes layout space.
              (ViewerToolbar orientation="vertical"; "More tools" opens sideways)
drawing       opens fitted to the window
bar under it  page · zoom · Snap (S) · Angle lock (F8) · Show ▾ (labels, pins,
              PDF geometry) · tool hint          (ViewerStatusControls)
right         takeoff panel (] to hide, drag its edge to resize)
```

There is no horizontal toolbar row; the horizontal `ViewerToolbar` layout is
kept only for the Viewer used on its own (`hideToolbar={false}`).

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

## Production-only pitfalls (read before touching `public/sw.js`)

* **Service worker and web workers.** The bundler passes each web worker its
  start-up config in the URL fragment (`…worker.js#params=…`). A `Response`
  returned from `fetch()` or the Cache API carries its own URL without the
  fragment, and the browser uses that as the worker's location — so the worker
  boots with no config and never answers. Symptom: in a production build (the
  only place the service worker runs) the viewer sits on "Extracting snap
  geometry…" and snapping, pins, hover geometry and fill never start, while
  `npm run dev` works. `public/sw.js` therefore answers worker-script requests
  with a URL-less copy of the response. Keep that when editing the worker.
* **Geometry timeout.** `hooks/snapEngine/usePdfDocument.ts` gives the geometry
  worker 60 s, then reports an error instead of waiting forever.
* **Fonts are self-hosted** (`app/fonts/*.woff2` via `next/font/local`), so
  builds don't need to reach Google Fonts and the installed app has its fonts
  offline.
* **Browser storage unavailable (full disk, "Internal error opening backing
  store").** `lib/storage/projectDb.ts` switches to an in-memory database with
  the same API (`fake-indexeddb`, loaded only when needed) so the app keeps
  working, and the projects folder becomes the only persistent copy:
  a banner (`StorageModeBanner`) asks for the folder, projects are pulled from
  it, every save is written to it, and the header shows "folder only". Because
  the browser remembers the chosen folder *in IndexedDB*, the folder has to be
  chosen again after each reload until browser storage works. With no folder,
  the UI says plainly that nothing is being saved.
* **Why keep browser storage when a folder is connected?** It is what remembers
  the folder, it makes saves instant and prompt-free when folder access has
  lapsed, and it works when a network/cloud folder is slow or offline.

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

**One folder per computer — browser tab and installed app share it.** The chosen
folder is remembered in the browser's own storage, which the tab and the
installed app both use (same browser, same profile). Connect it in either one
and the other picks it up: changes are announced between open windows
(`BroadcastChannel`), each window re-checks when it regains focus
(`refreshFolderState`), and writes from different windows are serialised with a
Web Lock. Choosing a folder also asks the browser to keep this storage
(`navigator.storage.persist`). Note that Edge and Chrome are separate browsers:
a folder connected in one is not visible to the other.

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
