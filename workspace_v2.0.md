# Takeoff Viewer — Todo List

---

## 🐛 Bug Fixes (do these first)

- [ ] **Fix hardcoded `tempPointsCount={0}` in workspace**
  Workspace passes `tempPointsCount={0}` hardcoded to `ViewerToolbar`. Pipe the real value from `toolbarAPI` so the undo "pop point" tooltip and the polyarc upgrade hint actually work.

- [ ] **Fix duplicate `AdvancedToolsDropdown`**
  Two versions exist: one inside `ViewerToolbar.tsx` (prop-based) and a separate `AdvancedToolsDropdown.tsx` (context-wired). They have diverged. Delete the prop-based inline version and use only the standalone context-aware one everywhere.

- [ ] **Fix export endpoint — no data in request body**
  `executeExport` sends only `filename` to `/api/export`. The server receives no measurements or project state. Either include the full project state in the POST body, or confirm the server reads from a database — otherwise exports are silently empty.

- [ ] **Fix group type mismatch `useEffect` — potential update loop**
  The effect that fixes group header type mismatches calls `updateMeasurement` inside a `useEffect` with `ps.measurements` as a dependency. If `updateMeasurement` is not referentially stable this will loop. Wrap `updateMeasurement` in `useCallback` or use a ref guard to prevent re-firing.

- [ ] **Reassign keyboard shortcut for Polygon tool**
  The `A` key was removed from the workspace handler to fix the polyarc toggle conflict but was never reassigned. Polygon has no keyboard shortcut now. Assign a new key (e.g. `G` for area/polygon) and document it in the toolbar tooltip.

---

## 🔧 Quick Fixes (low effort, high value)

- [ ] **Fix hardcoded workspace name in footer**
  Footer shows `"Workspace: LOGISTICS_HUB_P2"` as a string literal. Replace with `ps.projectName` or a dedicated workspace identifier from project metadata.

- [ ] **Fix hardcoded coordinates in footer**
  Footer shows `"LAT: 34.0522 N / LON: 118.2437 W"` (Los Angeles) hardcoded. Either remove it, or wire it to a project-level location field in project metadata.

- [ ] **Make Escape key close open overlays first**
  Currently Escape always calls `setActiveTool('select')`. It should close the topmost open overlay first (preset drawer, material library, export modal) before falling through to deselecting the tool.

- [ ] **Add snap toggle keyboard shortcut**
  `snapEnabled` has no keyboard shortcut. Add a key (e.g. `F3` or `S`) to toggle snap on/off without reaching for the toolbar button. Update the Pins/Snap button tooltip to show the shortcut.

---

## 🛠 Core Missing Tools

- [ ] **Polar Mode — angle constraint toggle**
  Add a Polar Mode button to the toolbar that constrains drawn lines to 0°, 45°, and 90° angles while active. When enabled, the cursor should snap to the nearest constrained angle as the user moves. Show the current angle in the canvas hint. Shortcut: `F8` (matches CAD convention).

- [ ] **Multi-select tool**
  Add a multi-select mode where the user can either hold `Shift` and click individual measurements, or drag a selection rectangle to grab multiple. Selected items should highlight together. Toolbar actions (delete, recolor, reassign category) should apply to the whole selection. Add a `Shift+click` hint to the existing select tool tooltip as a stepping stone.

- [ ] **Disconnected Point marker**
  Add a neutral point tool that places a reference dot on the drawing not tied to any measurement row. Used for scope limit markers, RFI flags, and reference callouts. Should appear on canvas but not generate a quantity or row in the takeoff table. Store separately from measurement points.

- [ ] **Annotation layer — text labels and callouts**
  Add a text tool that lets users place a label anywhere on the drawing. Each annotation should have editable text, a leader line to a target point, and a color. Annotations should be toggleable as a layer (show/hide all). Store separately from measurements.

---

## 📄 Navigation

- [ ] **Page navigation — multi-page PDF support**
  Add "Page X of Y" display with previous/next arrow buttons to the toolbar. When a PDF with multiple pages is loaded, the user should be able to move between pages without re-importing. Each page should be treated as a separate drawing sheet automatically.

- [ ] **Sheet selector dropdown in toolbar**
  Add a named dropdown to the toolbar (mirroring the drawing list in the sidebar) so the user can switch active sheets without opening the sidebar. Should show the drawing name and page number. Syncs bidirectionally with the sidebar selection.

---

## 🧠 Snap Improvements

- [ ] **Snap to arbitrary point on line segment**
  Extend the snap system beyond fixed candidates (endpoint, midpoint, centroid, intersection). When the cursor hovers near any line in the drawing, allow it to lock onto the nearest point along that segment, not just the precomputed candidates. This fills the gap when estimators need to start a measurement partway along a wall.

---

## 🤖 AI / Advanced Tools

- [ ] **Wire up Magic Fill to boundary detection**
  The `fillCanvasRef` layer and `magic-fill` tool exist but are not connected to any room detection logic. Implement flood-fill boundary detection: on click, expand outward from the cursor position until closed linework is found, then commit that boundary as an area polygon. Ignore interior shapes (furniture, columns) and let the user subtract manually using a deduct polygon. Show a loading indicator while scanning.

- [ ] **Ship Perimeter Offset (remove Soon badge)**
  Already defined in `ADVANCED_CANVAS_TOOLS` with a Soon badge. Implement: user selects an existing closed polygon, enters an offset distance, and the tool auto-generates a new parallel polygon at that distance inward or outward. Primary use case is formwork around slabs.

- [ ] **Ship Symbol Detect (remove Soon badge)**
  Already defined in `ADVANCED_CANVAS_TOOLS`. Implement: user clicks one instance of a symbol on the drawing (door swing, fixture, fitting), the AI scans the rest of the drawing for visual matches, and places a count dot on each match found. User reviews and accepts or rejects each detection.

- [ ] **Ship Volume tool (remove Soon badge)**
  Already defined in `ADVANCED_CANVAS_TOOLS`. Implement: user draws a boundary polygon (same as area), then enters a depth value in a prompt. Tool computes `area × depth` and commits a cubic metre quantity to the takeoff table.

---

## 📥 Import / Export

- [ ] **Add drawing import feedback**
  After a PDF or image is uploaded via the sidebar, show a visible progress state — file name, page count detected, and a success or error confirmation. Currently the user has no feedback that the file loaded correctly beyond the canvas appearing.