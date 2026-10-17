# Guided test UI design system

This describes the actual experimental React frontend, not the earlier standalone mockup. It is deployed only through the `guided-test` image/branch and `mbot-test` origin. The primary UI remains independent.

## Direction

Project-first Guided workspace: an active mission or a clear Choose mission action sits beside the block canvas. The block library opens on demand. Live Control gives driving, shared power and Stop priority over auxiliary tools. Learn groups Challenges and Achievements. Robot groups setup and Advanced tools without removing existing capabilities.

## Visual tokens

- Body/ink: `#172B3A`
- Secondary text: `#526575`
- Navigation/selection blue: `#2E56C5`
- Run teal: `#006C67`
- Stop/danger red: `#B42318`
- Caution amber: `#F1B434`, dark text
- Light neutral workspace, white controls and grouped sections; system UI font stack.
- Scoped category colors on the block renderer carry syntax, not arbitrary decorative hierarchy.
- Vector shell icons in `StudioIcon.jsx`; legacy capability/content icons remain where their existing components are preserved.

## Blocks

The real editor remains the existing tree engine and catalog. `guidedMode` adds a library drawer, larger named fields and SVG backgrounds over semantic DOM controls. Stacks connect flush; C/E loops remain open-right with continuous rails and compact footers. Typed reporters/predicates stay distinct. The original block moves rather than leaving a stationary ghost.

The renderer does not normalize saved/imported values. Wrapped params, incompatible/unknown values, recording IDs, static expressions, branch mouths and stable identities use the existing tree/admission operations. Display bounds derive from actual runtime capabilities. Live percent power, Program RPM, DC percent and requested turn angle remain distinct.

## Interaction and safety

- Persistent shell Emergency Stop calls the existing App Stop flow and synchronously invalidates mounted Live/recording work.
- Dialogs that cover the shell need an equivalent full Stop inside their non-scrolling chrome.
- Live clicks/holds preserve the original controller, selected-power snapshot, leases, cancellation and no-backlog behavior.
- Sensors remain explicit snapshots. Recording capture/sync requires intentional actions and cancellation on hidden/unmounted context.
- Test banner states that this site shares the real robot and server settings with the main UI. No simulation-only state is used.

## Responsive behavior

- Desktop: mission rail plus canvas; library and helper drawers; drive-first two-column Live layout.
- Tablet: compact shell rows, narrowed rail, reachable library controls.
- Phone: stacked mission/canvas and full-width Live controller, no zero-width drive panel. Global Stop remains in the viewport chrome.
- Preserve visible focus, native fields and reduced-motion support. Browser tests use viewport rectangles and hit testing, not merely document scroll width.

## Scope and current limitations

This is an experimental second frontend for comparison. It deliberately retains the full production engine instead of substituting the mockup's reduced model. It does not migrate browser storage, add Room Explorer, replace firmware, or create another MQTT owner. Browser-local projects/profiles are separate on the test origin; server configuration and recordings are shared. Physical touch/Safari and a child usability session remain separate acceptance beyond automated Chromium coverage.
