---
name: responsive-sweep
description: Verify a UCG layout/CSS/topbar/nav change at 375/768/1280px including the mobile nav drawer and contrast. Use after any change to layout, CSS, the topbar, the nav, or a page's structure — before claiming the change is done.
---

# Responsive sweep

Required after **any** layout / CSS / topbar / nav change. Not a polish step.

Breakpoint: `Layout.tsx` + `index.css` `@media (max-width: 860px)`.

## Procedure

Start the dev server via `preview_start` with `{name: "ucg-dev"}` (port 5173). Do not run a dev
server through Bash.

For each width — **375, 768, 1280**, then spot-check **1440**:

1. `resize_window` to the width.
2. Check no horizontal overflow:

```js
({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })
```

   `scrollWidth` must be ≤ `clientWidth`. If it overflows, find the offending element rather than
   masking it with `overflow: hidden`.
3. Confirm the topbar renders in **≤ 2 lines**.
4. Confirm foreground/background pairs are legible — resolve CSS variables to actual values
   rather than assuming. Pale accents (`--bluegreen`/`--purple`/`--gold`) are fills only and must
   never carry text on a light surface.

## Below 860px, also exercise the nav drawer

Hamburger → overlay opens → Esc closes → reopen → link-tap navigates and closes.

`preview_click` can silently miss tiny or tightly-padded buttons — it reports success while the
handler never fires. If a click seems to do nothing, confirm with a direct JS `.click()` dispatch
before concluding there's an app bug.

## Topbar membership badges

`TopbarMembership` self-fits by direct layout observation (ResizeObserver): stack only if the user
chip wrapped (`name.top - crumb.top > 6`). Width *estimation* was tried and abandoned — do not
reintroduce it.

With dev auto-login active the badges render normally, so verify them directly. Only when
`VITE_DEV_AUTH_*` are blank should you inject a worst-case topbar via `preview_eval`.

## Evidence

Screenshot each width, and state the measured `scrollWidth`/`clientWidth` pair per width. A
claim of "verified responsive" without the numbers is not verification.
