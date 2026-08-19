from datetime import date, datetime, timedelta

from dash import Dash, dcc, html, Input, Output, State
from dash.exceptions import PreventUpdate
import skinnycal as dcal

app = Dash(__name__)

# Per-event decoration seam (skinnycal >= 0.2.0):
#   * every block automatically gets data-event-id="<event id>"
#   * extendedProps.classNames become real classes on that block
#   * eventDataAttributes mirrors whitelisted extendedProps keys as data-*
#
# In-place event updates (skinnycal >= 0.3.0):
#   * command {'type': 'setProps', 'updates': [...]} changes an existing
#     event's title / extendedProps WITHOUT replacing the `events` prop, so the
#     block is NOT remounted, and any eventDataAttributes data-* mirrors refresh.
#     Contrast with the "Toggle conflict block" button below, which returns a
#     new events list and therefore remounts every block.
app.index_string = """<!DOCTYPE html>
<html>
    <head>
        {%metas%}<title>{%title%}</title>{%favicon%}{%css%}
        <style>
            .fc-event.is-conflict-hard {
                border-color: #c0392b !important;
                box-shadow: 0 0 0 2px rgba(192, 57, 43, 0.2);
            }
            .fc-event.is-conflict-soft {
                border-color: #b7791f !important;
                box-shadow: 0 0 0 2px rgba(183, 121, 31, 0.2);
            }
        </style>
    </head>
    <body>
        {%app_entry%}
        <footer>{%config%}{%scripts%}{%renderer%}</footer>
    </body>
</html>"""


def build_events(conflict_id):
    """Two events; `conflict_id` names the one carrying the hard-conflict class."""
    return [
        {
            "id": "audit",
            "title": "Audit",
            "date": "2025-08-01",
            "extendedProps": {
                "trainer": "AB",
                "classNames": ["is-conflict-hard"] if conflict_id == "audit" else [],
            },
        },
        {
            "id": "golive",
            "title": "Go‑Live",
            "date": "2025-08-10",
            "extendedProps": {
                "trainer": "CD",
                "classNames": ["is-conflict-hard"] if conflict_id == "golive" else [],
            },
        },
    ]


app.layout = html.Div(
    [
        html.Button("Toggle conflict block", id="toggle"),
        html.Button("Rename Audit in place (setProps)", id="setprops"),
        dcal.FullCalendar(
            id="cal",
            initialView="dayGridMonth",
            initialDate="2025-08-01",
            editable=True,
            selectable=True,
            # Native right-click bridge (skinnycal >= 0.4.0): right-clicking an
            # event, a day/time slot, or a resource lane emits `contextMenu`
            # (see the callback below). skinnycal emits the context only — the
            # app renders and positions the menu itself.
            contextMenuEnabled=True,
            # FullCalendar props passed unchanged:
            headerToolbar={"left": "prev,next today", "center": "title",
                           "right": "dayGridMonth,timeGridWeek"},
            events=build_events("audit"),
            eventDataAttributes=["trainer"],
        ),
        html.Div(id="clicked"),
        # App-owned context menu. skinnycal never renders this — we do. The
        # action buttons live in the layout with fixed ids (so callbacks can
        # target them); open_context_menu shows/hides the relevant ones per
        # target. The right-clicked context is stashed in a Store so an action
        # knows *what* it acts on.
        dcc.Store(id="ctx-context"),
        html.Div(
            id="ctx-menu",
            style={"display": "none"},
            children=[
                html.Div(id="ctx-menu-label", style={
                    "fontWeight": "bold", "marginBottom": "6px",
                    "fontSize": "12px", "color": "#555",
                }),
                html.Button("Rename", id="act-rename",
                            n_clicks=0, style={"display": "none"}),
                html.Button("Move +1 day", id="act-move",
                            n_clicks=0, style={"display": "none"}),
                html.Button("Add event here", id="act-add",
                            n_clicks=0, style={"display": "none"}),
            ],
        ),
        # Hidden button an outside-click clicks to dismiss the menu *through*
        # Dash (see the dismissal callbacks below), plus a dummy output for the
        # one-time listener installer.
        html.Button(id="ctx-dismiss", style={"display": "none"}),
        html.Div(id="ctx-menu-init", style={"display": "none"}),
    ],
    style={
            "paddingLeft": "20%",
            "paddingRight": "20%",
            "paddingBottom": "10%",
        }
)


@app.callback(Output("clicked", "children"), Input("cal", "dateClick"))
def show_click(date):
    return f"You clicked {date}" if date else "Click a date on the calendar."


# Dismiss the app-owned menu on any left-click outside it. This is the app's
# job, not skinnycal's: skinnycal reports the right-click context but never
# renders or owns the menu, so it has nothing to hide.
#
# The dismissal must go THROUGH Dash, not by mutating the DOM directly: the open
# callback below owns `ctx-menu.style`, so if we set `display:'none'` behind
# React's back, React still believes the style is `display:'block'` and — on the
# next right-click, which returns `display:'block'` again — sees no change and
# never re-shows the menu (it stays hidden until a page refresh). So instead a
# one-time document listener just *clicks a hidden button*, and a clientside
# callback flips `ctx-menu.style` to hidden via Dash, keeping React in sync.
app.clientside_callback(
    """
    function(context) {
        if (!window.__skinnycalCtxBound) {
            window.__skinnycalCtxBound = true;
            document.addEventListener('mousedown', function(e) {
                var menu = document.getElementById('ctx-menu');
                if (!menu || menu.style.display === 'none') { return; }
                // Keep the menu open for clicks inside it (e.g. action items).
                if (menu.contains(e.target)) { return; }
                document.getElementById('ctx-dismiss').click();
            }, true);
        }
        return window.dash_clientside.no_update;
    }
    """,
    Output("ctx-menu-init", "children"),
    Input("cal", "contextMenu"),
    prevent_initial_call=True,
)

# Flip the menu to hidden through Dash so React's virtual DOM stays authoritative
# (allow_duplicate: the open callback also writes ctx-menu.style).
app.clientside_callback(
    "function(n) { return {'display': 'none'}; }",
    Output("ctx-menu", "style", allow_duplicate=True),
    Input("ctx-dismiss", "n_clicks"),
    prevent_initial_call=True,
)


# --- Menu item button styling (shown vs hidden) ---
_ITEM_BASE = {
    "display": "block",
    "width": "100%",
    "textAlign": "left",
    "border": "none",
    "background": "transparent",
    "padding": "5px 8px",
    "cursor": "pointer",
    "fontSize": "13px",
}
_ITEM_SHOWN = _ITEM_BASE
_ITEM_HIDDEN = {**_ITEM_BASE, "display": "none"}


@app.callback(
    Output("ctx-menu", "style"),
    Output("ctx-menu-label", "children"),
    Output("act-rename", "style"),
    Output("act-move", "style"),
    Output("act-add", "style"),
    Output("ctx-context", "data"),
    Input("cal", "contextMenu"),
    prevent_initial_call=True,
)
def open_context_menu(context):
    """Open the app-owned menu at the pointer with actions for what was clicked.

    skinnycal only reports *what* was right-clicked (target type + date /
    resource / event context + pointer coordinates) via the `contextMenu` prop;
    building the menu, deciding which actions apply, and running them is entirely
    the app's job. We stash the whole context in a Store so the action callbacks
    below know what they operate on.
    """
    if not context:
        raise PreventUpdate

    js = context["jsEvent"]
    target = context["target"]
    if target == "event":
        label = f"Event: {context['event']['title']}"
        rename_style, move_style, add_style = _ITEM_SHOWN, _ITEM_SHOWN, _ITEM_HIDDEN
    elif target == "date":
        label = f"Date: {context['date']['start']}"
        rename_style, move_style, add_style = _ITEM_HIDDEN, _ITEM_HIDDEN, _ITEM_SHOWN
    else:
        label = f"Resource: {context['resource']['id']}"
        rename_style = move_style = add_style = _ITEM_HIDDEN

    menu_style = {
        "display": "block",
        "position": "fixed",
        "left": f"{js['clientX']}px",
        "top": f"{js['clientY']}px",
        "minWidth": "150px",
        "background": "#fff",
        "border": "1px solid #ccc",
        "borderRadius": "4px",
        "boxShadow": "0 2px 8px rgba(0,0,0,0.15)",
        "padding": "6px",
        "zIndex": 1000,
    }
    return menu_style, label, rename_style, move_style, add_style, context


# --- Interactive actions. Each reads the stashed context, updates the calendar,
#     and closes the menu (through Dash, with allow_duplicate since
#     open_context_menu also owns ctx-menu.style).
#
#     All three drive the `events` prop as the single source of truth. skinnycal
#     also offers in-place `command`s (setProps / setDates) that mutate a block
#     WITHOUT replacing `events` (no remount) — see the "Rename Audit in place"
#     button — but those changes are not reflected back into the `events` prop,
#     so mixing them with an `events`-list replacement in the same demo would let
#     one action silently undo another. Keeping every menu action on `events`
#     avoids that; a real app that wants in-place commands should keep its own
#     authoritative event state (e.g. a Store) rather than reading it back. ---

_HIDE = {"display": "none"}


def _shift_one_day(value):
    """Return the ISO date/datetime string one day later."""
    if "T" in value:
        return (datetime.fromisoformat(value) + timedelta(days=1)).isoformat()
    return (date.fromisoformat(value) + timedelta(days=1)).isoformat()


@app.callback(
    Output("cal", "events", allow_duplicate=True),
    Output("ctx-menu", "style", allow_duplicate=True),
    Input("act-rename", "n_clicks"),
    State("ctx-context", "data"),
    State("cal", "events"),
    prevent_initial_call=True,
)
def action_rename(_n_clicks, context, events):
    """Append a pencil to the right-clicked event's title."""
    if not context or context.get("target") != "event":
        raise PreventUpdate
    target_id = context["event"]["id"]
    new_events = [dict(e) for e in (events or [])]
    for e in new_events:
        if e.get("id") == target_id:
            e["title"] = e.get("title", "") + " ✏️"
    return new_events, _HIDE


@app.callback(
    Output("cal", "events", allow_duplicate=True),
    Output("ctx-menu", "style", allow_duplicate=True),
    Input("act-move", "n_clicks"),
    State("ctx-context", "data"),
    State("cal", "events"),
    prevent_initial_call=True,
)
def action_move(_n_clicks, context, events):
    """Move the right-clicked event one day later."""
    if not context or context.get("target") != "event":
        raise PreventUpdate
    target_id = context["event"]["id"]
    new_events = [dict(e) for e in (events or [])]
    for e in new_events:
        if e.get("id") != target_id:
            continue
        # Existing events carry a "date" key; ones we add carry "start".
        key = "date" if "date" in e else "start"
        e[key] = _shift_one_day(e[key])
        if "end" in e:
            e["end"] = _shift_one_day(e["end"])
    return new_events, _HIDE


@app.callback(
    Output("cal", "events", allow_duplicate=True),
    Output("ctx-menu", "style", allow_duplicate=True),
    Input("act-add", "n_clicks"),
    State("ctx-context", "data"),
    State("cal", "events"),
    prevent_initial_call=True,
)
def action_add(n_clicks, context, events):
    """Add a new event on the right-clicked date."""
    if not context or context.get("target") != "date":
        raise PreventUpdate
    new_events = [dict(e) for e in (events or [])]
    new_events.append(
        {
            "id": f"new-{n_clicks}",
            "title": "New event",
            "start": context["date"]["start"],
            "allDay": context["date"]["allDay"],
        }
    )
    return new_events, _HIDE


@app.callback(
    Output("cal", "command"),
    Input("setprops", "n_clicks"),
    prevent_initial_call=True,
)
def rename_audit(n_clicks):
    """Update the Audit event's title and its `trainer` extendedProp in place.

    Because this goes through the `setProps` command rather than replacing the
    `events` prop, the Audit block is mutated on its existing DOM element (no
    remount) and its `data-trainer` mirror refreshes to the new value. `n_clicks`
    doubles as the nonce so repeated clicks change the command by reference.
    """
    return {
        "type": "setProps",
        "nonce": n_clicks,
        "updates": [
            {
                "id": "audit",
                "title": f"Audit (renamed x{n_clicks})",
                "extendedProps": {"trainer": "ZZ"},
            }
        ],
    }


@app.callback(
    Output("cal", "events"),
    Input("toggle", "n_clicks"),
    State("cal", "events"),
    prevent_initial_call=True,
)
def toggle_conflict(_n_clicks, events):
    """Move the conflict class to the other event by returning a new events list."""
    current = next(
        (
            e["id"]
            for e in events
            if "is-conflict-hard" in e.get("extendedProps", {}).get("classNames", [])
        ),
        None,
    )
    return build_events("golive" if current == "audit" else "audit")


if __name__ == "__main__":
    app.run(debug=True)
