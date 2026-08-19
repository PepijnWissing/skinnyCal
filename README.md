# skinnycal

A lightweight Plotly Dash wrapper around **[@fullcalendar/react](https://fullcalendar.io/docs/react)**, with the FullCalendar **Premium (Scheduler)** plugins statically bundled so resource views work out of the box.

Forked from [`dash-fullcalendar`](https://github.com/ScottTpirate/dash-fullcalendar). See [`PREMIUM_FORK_CHANGES.md`](PREMIUM_FORK_CHANGES.md) for the full rationale and diff notes.

---

## Installation

```bash
pip install skinnycal
```

PyPI distribution and Python import name are both `skinnycal`.

---

## Quick start

```python
from dash import Dash, html
import skinnycal as dcal

app = Dash(__name__)

app.layout = html.Div([
    dcal.FullCalendar(
        id="cal",
        initialView="dayGridMonth",
        editable=True,
        selectable=True,
        events=[
            {"title": "Audit", "date": "2025-08-01"},
            {"title": "Go-Live", "date": "2025-08-10"},
        ],
    )
])

if __name__ == "__main__":
    app.run(debug=True)
```

Open <http://127.0.0.1:8050> in your browser.

### Premium (Scheduler) views

Pass a valid `schedulerLicenseKey` and request a resource view — the premium plugins are already in the bundle, no async chunk fetch:

```python
dcal.FullCalendar(
    id="cal",
    schedulerLicenseKey="GPL-My-Project-Is-Open-Source",  # or your commercial key
    plugins=["resourceTimeline", "interaction"],
    initialView="resourceTimelineWeek",
    resources=[{"id": "a", "title": "Room A"}, {"id": "b", "title": "Room B"}],
    events=[{"resourceId": "a", "title": "Kickoff", "start": "2025-08-01"}],
)
```

### Per-event decoration

Every event block gets `data-event-id="<event id>"` on its `.fc-event` root, so your
own JS can address one block without reaching into FullCalendar internals. Per-block
CSS classes and `data-*` attributes are driven by data — no JS callbacks needed:

```python
dcal.FullCalendar(
    id="cal",
    events=[{
        "id": "bead-42",
        "title": "Module 3",
        "start": "2025-08-01",
        "extendedProps": {
            "classNames": ["is-conflict-hard"],   # -> classes on this block
            "trainer": "AB",                      # -> data-trainer, see below
        },
    }],
    eventDataAttributes=["trainer"],   # mirror these extendedProps keys as data-*
)
```

```js
document.querySelector('[data-event-id="bead-42"]').dataset.trainer  // "AB"
```

Then style it however you like:

```css
.fc-event.is-conflict-hard { border-color: #c0392b; }
```

Because FullCalendar re-evaluates event classes when an event's data changes, you can
toggle state by returning an updated `events` list from a callback — no page reload,
and no need to re-render the whole calendar yourself. `eventDataAttributes` keys are
kebab-cased (`courseCode` → `data-course-code` → `el.dataset.courseCode`) and are
applied when a block mounts; see `PREMIUM_FORK_CHANGES.md` for the caveat about
imperative `command` mutations. `usage.py` is a runnable demo of all of this.

### Context menu (right-click)

FullCalendar has no documented right-click callback, so skinnycal adds one. Set
`contextMenuEnabled=True` and skinnycal listens for the browser's native
`contextmenu` event inside the calendar, works out **what** was right-clicked
(an event, a date/time slot, and/or a resource), suppresses the browser menu for
that target, and reports the context through the read-only `contextMenu` prop.

**skinnycal emits the context only — it does not render the menu, decide which
actions are available, or execute anything.** You draw the menu with whatever you
like (a plain `html.Div`, a component library, or a fully client-side menu) and
handle the chosen action yourself.

```python
from dash import Input, Output, callback, html
from dash.exceptions import PreventUpdate
import skinnycal as dcal

calendar = dcal.FullCalendar(
    id="calendar",
    contextMenuEnabled=True,
    initialView="resourceTimelineWeek",
    resources=resources,
    events=events,
)

@callback(
    Output("calendar-menu", "children"),
    Output("calendar-menu", "style"),
    Input("calendar", "contextMenu"),
    prevent_initial_call=True,
)
def open_context_menu(context):
    if not context:
        raise PreventUpdate
    js = context["jsEvent"]
    return build_actions(context), {
        "display": "block",
        "position": "fixed",
        "left": f"{js['clientX']}px",
        "top": f"{js['clientY']}px",
    }
```

The `contextMenu` payload always has the same top-level keys (anything
unavailable is `null`):

```python
{
    "sequence": 12,                 # increments on every right-click, so two
                                    #   identical right-clicks still fire Dash
    "target": "event",              # "event" | "date" | "resource"
    "calendarId": "calendar",
    "viewType": "resourceTimeline",
    "date": {"start": "2026-08-19", "allDay": True, "timeZone": "local"},
    "resource": {"id": "course-42", "title": "Course 42", "extendedProps": {}},
    "event": {                      # snapshot of the right-clicked event
        "id": "bead-123", "groupId": "", "title": "Module A",
        "start": "2026-08-19", "end": "2026-08-20", "allDay": True,
        "display": "auto", "extendedProps": {"courseCode": "ABC"},
        "resourceIds": ["course-42"],
    },
    "jsEvent": {                    # pointer position + modifier keys
        "clientX": 812, "clientY": 376, "pageX": 812, "pageY": 541,
        "button": 2, "altKey": False, "ctrlKey": False,
        "metaKey": False, "shiftKey": False,
    },
}
```

Notes and caveats:

- **Target precedence is `event` → `date` → `resource`.** Right-clicking an event
  reports `target: "event"` but still fills in the underlying `date`/`resource`
  when they can be resolved; an empty resource-timeline slot reports
  `target: "date"` with a `resource`; a resource label reports
  `target: "resource"` with no date.
- **The date is the rendered *slot start*, not a sub-slot position**, and a named
  timezone is **not** appended to the string — it is supplied separately as
  `date.timeZone`. Client-side you may pass the string straight back to
  FullCalendar; server-side, interpret it in `date.timeZone`. Exact `dateClick`
  parity (snap-duration subdivisions, named-timezone offsets) is out of scope.
- **Give actionable events a stable `id`** so they resolve via FullCalendar's live
  API; anonymous events fall back to a mount-time snapshot.
- **Foreground events are guaranteed targets.** Background events are treated as
  date/resource context unless their DOM element participates in pointer hit
  testing (some views render them with `pointer-events: none`).
- The browser menu is suppressed **only** for a recognized calendar target —
  right-clicking toolbar buttons or other chrome keeps the normal browser menu.
- **Accessibility:** don't rely on right-click alone — provide a keyboard- or
  click-accessible way to reach the same actions.

#### Dismissing the menu

Because the menu is yours, so is closing it — skinnycal has nothing to hide. The
usual behaviour ("click anywhere else to dismiss") is a few lines, but there is
one **gotcha worth stating up front**: dismiss the menu *through* Dash, not by
mutating the DOM.

If your `open` callback owns `menu.style` and you hide the menu by setting
`element.style.display = 'none'` directly (e.g. from a raw `document` listener),
React's virtual DOM still believes the style is `display:'block'`. On the next
right-click your callback returns `display:'block'` again, React diffs
`block → block`, sees no change, and **never re-shows the menu** — it stays hidden
until a page refresh. The fix is to route the dismissal through Dash so React
stays authoritative. A compact, no-round-trip pattern: one persistent `document`
listener that just clicks a hidden button, plus a clientside callback that flips
the style via Dash.

```python
from dash import Input, Output

# In the layout, alongside the menu Div:
#   html.Div(id="calendar-menu", style={"display": "none"}),
#   html.Button(id="menu-dismiss", style={"display": "none"}),
#   html.Div(id="menu-init", style={"display": "none"}),  # dummy output

# Install ONE document listener the first time a menu opens. On an outside
# mousedown it clicks the hidden button (clicks inside the menu are ignored, so
# your action items keep working).
app.clientside_callback(
    """
    function(context) {
        if (!window.__menuBound) {
            window.__menuBound = true;
            document.addEventListener('mousedown', function(e) {
                var menu = document.getElementById('calendar-menu');
                if (!menu || menu.style.display === 'none') { return; }
                if (menu.contains(e.target)) { return; }
                document.getElementById('menu-dismiss').click();
            }, true);
        }
        return window.dash_clientside.no_update;
    }
    """,
    Output("menu-init", "children"),
    Input("calendar", "contextMenu"),
    prevent_initial_call=True,
)

# Hide the menu THROUGH Dash. allow_duplicate is needed because the open
# callback also writes calendar-menu.style.
app.clientside_callback(
    "function(n) { return {'display': 'none'}; }",
    Output("calendar-menu", "style", allow_duplicate=True),
    Input("menu-dismiss", "n_clicks"),
    prevent_initial_call=True,
)
```

This also handles right-clicking a *different* target while a menu is open: the
new right-click's `contextmenu` simply re-opens with fresh context.

`usage.py` includes a runnable context-menu demo, dismissal included.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `skinnycal/` | Python package published to PyPI. Contains generated Dash component classes and pre-compiled JS assets (`_js_dist`). |
| `src/` | Raw React source for the wrapper. |
| `package.json`, `webpack.config.js` | JS build pipeline (`npm run build`). |
| `usage.py` | Minimal Dash demo. |
| `tests/` | Integration tests with `dash[testing]` & `pytest`. |
| `.github/workflows/` | CI workflow that builds and publishes to PyPI on push to `main`. |

---

## Development

1. **Clone** and install dependencies

   ```bash
   git clone https://github.com/PepijnWissing/skinnyCal.git
   cd skinnyCal
   npm install
   python -m venv .venv && . .venv/Scripts/activate   # POSIX: source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Build** and run the example

   ```bash
   npm run build        # webpack + dash-generate-components
   pip install -e .
   python usage.py      # open http://localhost:8050
   ```

3. **Run tests**

   ```bash
   npm run test:js   # Jest unit tests for the pure hit-resolution helpers
   pytest -q         # Dash/Selenium integration tests
   ```

---

## Releasing

Publishing is automated: any push to `main` triggers `.github/workflows/publish.yml`, which builds an sdist + wheel and uploads to PyPI via [Trusted Publishing (OIDC)](https://docs.pypi.org/trusted-publishers/). Pushes that don't bump the version are no-ops (`skip-existing: true`).

To cut a release, bump the version in **all three** places (they must stay in sync — `__version__` is read from `package-info.json` at import time):

- `pyproject.toml` → `[project].version`
- `skinnycal/package-info.json` → `version`
- `package.json` → `version`

Then commit and push to `main`.

---

## License

MIT © Scott Kilgore (upstream wrapper). Bundled `@fullcalendar` premium plugin code is governed by [FullCalendar's own license](https://fullcalendar.io/license) — commercial production use requires a purchased Scheduler license.
